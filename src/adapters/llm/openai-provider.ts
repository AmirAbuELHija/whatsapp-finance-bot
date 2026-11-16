/** Any OpenAI-compatible chat API (Groq, OpenRouter, Ollama...) with an optional backup model. */
import OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { AI } from '../../config/constants.js';
import { IMAGE_UNSUPPORTED_NOTE } from '../../config/prompts.js';
import { statusOf } from '../../core/errors.js';
import type { ChatMessage, ChatProvider, ChatRequest, ChatResponse, Logger } from '../../core/types.js';

export interface ChatCompletionsClient {
  chat: { completions: { create(params: ChatCompletionCreateParamsNonStreaming): Promise<unknown> } };
}

export interface OpenAIProviderOptions {
  client: ChatCompletionsClient;
  model: string;
  fallbackModel?: string;
  /** Only sent to the main model (some backup models reject it). */
  reasoningEffort?: string;
  name?: string;
  logger?: Logger;
}

const SDK_MAX_RETRIES = 1;
const SDK_TIMEOUT_MS = 60_000;

export function createOpenAIClient({ baseURL, apiKey }: { baseURL: string; apiKey: string }): OpenAI {
  return new OpenAI({ baseURL, apiKey, maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS });
}

/** Gemini-only fields must not reach other providers; pictures become a note (these models are text-only). */
function standardMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m): ChatMessage => {
    if (m.role === 'assistant' && m.tool_calls)
      return { ...m, tool_calls: m.tool_calls.map(({ id, type, function: fn }) => ({ id, type, function: fn })) };
    if (m.role === 'user' && m.images) {
      const text = m.images.length ? `${IMAGE_UNSUPPORTED_NOTE}\n${m.content}` : m.content;
      return { role: 'user', content: text };
    }
    return m;
  });
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly name: string;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.name = options.name ?? 'openai';
  }

  async create(request: ChatRequest): Promise<ChatResponse> {
    const { client, model, fallbackModel, reasoningEffort, logger } = this.options;
    // `score` is our routing hint, not an OpenAI field: some APIs reject unknown fields.
    const { score: _score, preferModel: _preferModel, ...rest } = request;
    const base = { ...rest, messages: standardMessages(request.messages) } as unknown as Omit<
      ChatCompletionCreateParamsNonStreaming,
      'model'
    >;
    try {
      return (await client.chat.completions.create({
        ...base,
        model,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      } as ChatCompletionCreateParamsNonStreaming)) as ChatResponse;
    } catch (error) {
      const status = statusOf(error);
      if (!fallbackModel || status === undefined || !AI.retryableStatuses.includes(status)) throw error;
      logger?.warn({ status, fallbackModel }, 'primary model failed, trying fallback');
      return (await client.chat.completions.create({ ...base, model: fallbackModel })) as ChatResponse;
    }
  }
}
