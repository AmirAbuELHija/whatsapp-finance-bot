/** The AI brain: builds the conversation, runs the tool-calling loop and falls back across providers. */
import { AI, LIMITS } from '../../config/constants.js';
import {
  FALLBACK_ANSWER,
  IMAGE_HISTORY_MARKER,
  marketBriefingPrompt,
  marketStoryPrompt,
  systemPrompt,
} from '../../config/prompts.js';
import { parseMarketStory } from '../summary/market-story.js';
import { HeuristicRater, type RequestRater } from '../../core/ai/request-rating.js';
import { AiProviderError, messageOf, statusOf } from '../../core/errors.js';
import { stripNamePrefix } from '../../core/text/name-prefix.js';
import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ImageInput,
  Logger,
  MarketStory,
  NewsItem,
  OutgoingFile,
  ToolCall,
  ToolChoice,
} from '../../core/types.js';
import type { ConversationHistory } from '../conversation/history.js';
import { TOOL, type ToolRegistry } from './tool-registry.js';

export interface ChatAgentOptions {
  providers: readonly ChatProvider[];
  tools: ToolRegistry;
  history: ConversationHistory;
  maxToolSteps: number;
  timezone: string;
  ownerRules?: string;
  replyLanguage?: string;
  /** Rates each request 1-10 so providers can pick a model; defaults to the text heuristic. */
  rater?: RequestRater;
  logger?: Logger;
  now?: () => Date;
}

export interface AskOptions {
  /** Display name of the sender, used in group chats. */
  senderName?: string | undefined;
  /** Force the first AI step to call this tool (e.g. a YouTube link always goes to the video tool). */
  forceTool?: string | undefined;
  /** Pictures sent with the question (only Gemini can see them). */
  images?: ImageInput[] | undefined;
  /** Files created by tools (documents, slides) are added here; the caller sends them. */
  files?: OutgoingFile[] | undefined;
}

const parseArgs = (raw: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const firstMessage = (response: ChatResponse) => response.choices[0]?.message;

export class ChatAgent {
  private readonly now: () => Date;

  constructor(private readonly options: ChatAgentOptions) {
    if (!options.providers.length) throw new Error('ChatAgent needs at least one chat provider');
    this.now = options.now ?? (() => new Date());
  }

  async ask(
    chatId: string,
    text: string,
    { senderName, forceTool, images = [], files = [] }: AskOptions = {},
  ): Promise<string> {
    const { tools, history, maxToolSteps, logger } = this.options;
    const rated = await (this.options.rater ?? new HeuristicRater()).rate(text);
    // A picture goes to Flash with low thinking: capable enough, and fast (high thinking on pictures times out).
    const score = images.length
      ? Math.min(Math.max(rated.score, LIMITS.minImageScore), LIMITS.maxImageScore)
      : rated.score;
    logger?.info({ score, rated: rated.score, source: rated.source, images: images.length }, 'request rated');
    const userContent = senderName ? `${senderName}: ${text}` : text;
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      ...history
        .get(chatId)
        .map((t): ChatMessage =>
          t.role === 'user' ? { role: 'user', content: t.content } : { role: 'assistant', content: t.content },
        ),
      images.length ? { role: 'user', content: userContent, images } : { role: 'user', content: userContent },
    ];

    let answer: string | null = null;
    let preferModel: string | undefined; // the model that answered the previous step quickly is asked again
    for (let step = 0; step < maxToolSteps; step++) {
      const forced = step === 0 && forceTool !== undefined && tools.names.includes(forceTool);
      const toolChoice: ToolChoice = forced ? { type: 'function', function: { name: forceTool } } : 'auto';
      const response = await this.complete({
        messages,
        tools: [...tools.schemas],
        tool_choice: toolChoice,
        score,
        temperature: AI.chatTemperature,
        max_tokens: AI.maxCompletionTokens,
        ...(preferModel ? { preferModel } : {}),
      });
      preferModel = response.model;
      const message = firstMessage(response);
      if (!message) throw new AiProviderError('Empty response from the AI', 'agent');
      const calls = message.tool_calls ?? [];
      if (!calls.length) {
        answer = (message.content ?? '').trim();
        break;
      }
      messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls });
      const results = await Promise.all(calls.map((call) => this.runTool(call, files)));
      calls.forEach((call, i) => {
        const result = results[i];
        if (result && typeof result === 'object' && 'error' in result)
          logger?.warn({ tool: call.function.name, error: result.error }, 'tool failed');
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, LIMITS.maxToolResultChars),
        });
      });
    }

    if (answer === null) {
      // Out of tool steps: ask for a final answer with what we have.
      const final = firstMessage(
        await this.complete({
          messages,
          tools: [...tools.schemas],
          tool_choice: 'none',
          score,
          ...(preferModel ? { preferModel } : {}),
          temperature: AI.chatTemperature,
          max_tokens: AI.maxCompletionTokens,
        }),
      );
      answer = (final?.content ?? '').trim();
    }
    if (answer && senderName) answer = stripNamePrefix(answer, senderName);
    if (!answer) answer = FALLBACK_ANSWER;

    // Pictures are not kept (memory); the history only notes that one was sent.
    history.add(chatId, images.length ? `${IMAGE_HISTORY_MARKER} ${userContent}` : userContent, answer);
    return answer;
  }

  /** One-shot briefing from headlines: no tools and no chat history, so it's cheap on the free quota. */
  /** The words for the summary slides, from live numbers and the latest headlines (JSON from the AI). */
  async writeMarketStory({
    numbers,
    items,
    language,
  }: {
    numbers: string;
    items: readonly NewsItem[];
    language: string;
  }): Promise<MarketStory> {
    const today = new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: this.options.timezone,
    }).format(this.now());
    const headlines = items.map((h) => `- ${h.title}${h.source ? ` (${h.source})` : ''}`).join('\n');
    const response = await this.complete({
      messages: [
        { role: 'system', content: marketStoryPrompt(language) },
        {
          role: 'user',
          content: `Date: ${today}\n\nMarket numbers:\n${numbers}\n\nHeadlines, newest first:\n${headlines}`,
        },
      ],
      temperature: AI.summaryTemperature,
      max_tokens: AI.maxCompletionTokens,
      score: 5,
    });
    return parseMarketStory(firstMessage(response)?.content ?? '', items, this.now(), this.options.timezone);
  }

  async summarize({
    topic,
    items,
    language,
  }: {
    topic: string;
    items: readonly NewsItem[];
    language: string;
  }): Promise<string> {
    const lines = items.map((h) => {
      const when = h.publishedAt ? `, ${h.publishedAt.slice(0, 16).replace('T', ' ')} UTC` : '';
      return `- ${h.title}${h.source ? ` (${h.source}${when})` : ''}`;
    });
    const today = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: this.options.timezone }).format(
      this.now(),
    );
    const response = await this.complete({
      messages: [
        { role: 'system', content: marketBriefingPrompt(language) },
        {
          role: 'user',
          content: `Briefing topic: ${topic}\nDate: ${today}\nHeadlines, newest first:\n${lines.join('\n')}`,
        },
      ],
      temperature: AI.summaryTemperature,
      max_tokens: AI.maxCompletionTokens,
    });
    const text = (firstMessage(response)?.content ?? '').trim();
    if (!text) throw new AiProviderError("Couldn't write a summary right now, try again in a minute", 'agent');
    return text;
  }

  private systemPrompt(): string {
    return systemPrompt({
      now: this.now(),
      timeZone: this.options.timezone,
      ownerRules: this.options.ownerRules ?? '',
      replyLanguage: this.options.replyLanguage ?? '',
    });
  }

  private async runTool(call: ToolCall, files: OutgoingFile[]): Promise<unknown> {
    const args = parseArgs(call.function.arguments);
    if (!args) return { error: 'Tool arguments were not valid JSON' };
    // Document content can be long: log only its shape.
    const logged = call.function.name === TOOL.document ? { title: args.title, format: args.format } : args;
    this.options.logger?.info({ tool: call.function.name, args: logged }, 'tool call');
    return this.options.tools.call(call.function.name, args, { files });
  }

  /** Main AI first, then the backups. */
  private async complete(request: ChatRequest): Promise<ChatResponse> {
    const { providers, logger } = this.options;
    let lastError: unknown;
    for (const [i, provider] of providers.entries()) {
      try {
        return await provider.create(request);
      } catch (error) {
        lastError = error;
        if (i < providers.length - 1)
          logger?.warn(
            { provider: provider.name, status: statusOf(error), error: messageOf(error) },
            'AI provider failed, using the backup',
          );
      }
    }
    if (lastError instanceof AiProviderError) throw lastError;
    throw new AiProviderError(messageOf(lastError), providers.at(-1)?.name ?? 'unknown', statusOf(lastError), {
      cause: lastError,
    });
  }
}
