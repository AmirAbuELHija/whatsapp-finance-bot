/** Translation between the agent's OpenAI-style messages and Gemini's generateContent format. */
import { GEMINI } from '../../../config/constants.js';
import { AiProviderError } from '../../../core/errors.js';
import type { ChatRequest, ChatResponse, ToolCall } from '../../../core/types.js';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: unknown; id?: string };
  functionResponse?: { name: string; response: { result: unknown }; id?: string };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiGenerateRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
  tools?: { functionDeclarations: { name: string; description: string; parameters: Record<string, unknown> }[] }[];
  toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] } };
  generationConfig?: { thinkingConfig?: { thinkingLevel: string } };
}

export interface GeminiGenerateResponse {
  candidates?: { finishReason?: string; content?: { parts?: GeminiPart[] } }[];
  promptFeedback?: { blockReason?: string };
}

const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

export function toGeminiRequest(request: ChatRequest, { thinkingLevel = '' } = {}): GeminiGenerateRequest {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  const calls = new Map<string, { name: string; geminiId: string | undefined }>();

  for (const message of request.messages) {
    switch (message.role) {
      case 'system':
        system.push(message.content);
        break;
      case 'user':
        contents.push({
          role: 'user',
          parts: [
            ...(message.images ?? []).map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })),
            { text: message.content },
          ],
        });
        break;
      case 'assistant': {
        const parts: GeminiPart[] = message.content ? [{ text: message.content }] : [];
        (message.tool_calls ?? []).forEach((call, i) => {
          const google = call.extra_content?.google;
          calls.set(call.id, { name: call.function.name, geminiId: google?.function_call_id });
          const part: GeminiPart = {
            functionCall: { name: call.function.name, args: parseJson(call.function.arguments || '{}') },
          };
          if (google?.function_call_id && part.functionCall) part.functionCall.id = google.function_call_id;
          // The first call of each step must carry a signature; calls made by another AI get the documented skip value.
          if (google?.thought_signature) part.thoughtSignature = google.thought_signature;
          else if (i === 0) part.thoughtSignature = GEMINI.skipThoughtSignature;
          parts.push(part);
        });
        if (parts.length) contents.push({ role: 'model', parts });
        break;
      }
      case 'tool': {
        const info = calls.get(message.tool_call_id) ?? { name: 'tool', geminiId: undefined };
        const part: GeminiPart = {
          functionResponse: { name: info.name, response: { result: parseJson(message.content) } },
        };
        if (info.geminiId && part.functionResponse) part.functionResponse.id = info.geminiId;
        const last = contents.at(-1);
        // Answers to parallel calls belong together in one user turn.
        if (last?.role === 'user' && last.parts.every((p) => p.functionResponse)) last.parts.push(part);
        else contents.push({ role: 'user', parts: [part] });
        break;
      }
    }
  }

  const body: GeminiGenerateRequest = { contents };
  if (system.length) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  if (request.tools?.length) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      },
    ];
    const choice = request.tool_choice;
    let config: NonNullable<GeminiGenerateRequest['toolConfig']>['functionCallingConfig'] = { mode: 'AUTO' };
    if (choice === 'none') config = { mode: 'NONE' };
    else if (typeof choice === 'object') config = { mode: 'ANY', allowedFunctionNames: [choice.function.name] };
    body.toolConfig = { functionCallingConfig: config };
  }
  // No temperature: Gemini 3 models work best on their default.
  if (thinkingLevel) body.generationConfig = { thinkingConfig: { thinkingLevel } };
  return body;
}

export function fromGeminiResponse(body: GeminiGenerateResponse, model?: string): ChatResponse {
  const candidate = body.candidates?.[0];
  if (!candidate) {
    const reason = body.promptFeedback?.blockReason;
    throw new AiProviderError(`Gemini returned no answer${reason ? ` (blocked: ${reason})` : ''}`, 'gemini', 400);
  }
  const parts = candidate.content?.parts ?? [];
  const text = parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
  const toolCalls: ToolCall[] = parts.flatMap((p, i) => {
    if (!p.functionCall) return [];
    return [
      {
        id: p.functionCall.id ?? `gc_${Date.now().toString(36)}_${i}`,
        type: 'function' as const,
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
        extra_content: { google: { thought_signature: p.thoughtSignature, function_call_id: p.functionCall.id } },
      },
    ];
  });
  return {
    ...(model ? { model } : {}),
    choices: [
      {
        finish_reason: candidate.finishReason ?? null,
        message: { content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      },
    ],
  };
}
