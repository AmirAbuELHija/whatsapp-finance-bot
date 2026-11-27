/** Composition root: builds every service from the config. The only place that knows all concrete classes. */
import { join } from 'node:path';
import { CACHE_TTL_MS, GEMINI } from '../config/constants.js';
import type { AppConfig } from '../config/env.js';
import type { ChatProvider, Logger } from '../core/types.js';
import { HttpClient, type FetchLike } from '../adapters/http/http-client.js';
import { GeminiApi } from '../adapters/llm/gemini/gemini-api.js';
import { GeminiChatProvider } from '../adapters/llm/gemini/gemini-chat-provider.js';
import { ModelHealth } from '../adapters/llm/gemini/gemini-models.js';
import { GeminiRater } from '../adapters/llm/gemini/gemini-rater.js';
import { JsonFileHealthStore, JsonFileQuotaStore } from '../adapters/llm/gemini/model-health-file.js';
import { QuotaTracker } from '../adapters/llm/gemini/gemini-quota.js';
import { HeuristicRater, type RequestRater } from '../core/ai/request-rating.js';
import {
  OpenAICompatibleProvider,
  createOpenAIClient,
  type ChatCompletionsClient,
} from '../adapters/llm/openai-provider.js';
import { YahooMarketData } from '../adapters/market/yahoo-market.js';
import { NewsService } from '../adapters/news/news-service.js';
import { YouTubeVideoService } from '../adapters/youtube/youtube-video-service.js';
import { ChatAgent } from '../services/agent/chat-agent.js';
import { buildToolRegistry } from '../services/agent/tool-registry.js';
import { OfficeDocumentBuilder } from '../adapters/documents/office-document-builder.js';
import { StockReportRenderer } from '../adapters/reports/stock-report-renderer.js';
import {
  BrowserSummaryRenderer,
  FallbackSummaryRenderer,
  findChromium,
} from '../adapters/reports/browser-summary-renderer.js';
import type { BackupMarketSource, SummaryRenderer } from '../core/types.js';
import { CommandRouter } from '../services/commands/command-router.js';
import { MarketSummaryService } from '../services/summary/market-summary.js';
import { MassiveEndOfDay } from '../adapters/market/massive-eod.js';
import { AlpacaLiveData } from '../adapters/market/alpaca-live.js';
import { ConversationHistory } from '../services/conversation/history.js';
import { MessageHandler } from '../services/messaging/message-handler.js';
import { RateLimiter } from '../services/security/rate-limiter.js';

export interface ContainerOverrides {
  fetchImpl?: FetchLike;
  /** Keep model health in memory only (tests). */
  memoryHealth?: boolean;
  openAIClient?: ChatCompletionsClient;
}

/** One Gemini client and one model-health record, shared by chat routing, rating and video. */
export interface GeminiShared {
  api: GeminiApi;
  health: ModelHealth;
}

export function createGeminiShared(
  config: AppConfig,
  logger: Logger | undefined,
  overrides: ContainerOverrides = {},
): GeminiShared {
  const dir = config.whatsapp.authDir;
  const store = overrides.memoryHealth ? undefined : new JsonFileHealthStore(join(dir, GEMINI.healthFile), logger);
  const quota = new QuotaTracker(
    config.gemini.freeTier ? GEMINI.freeTierLimits : {},
    Date.now,
    overrides.memoryHealth ? undefined : new JsonFileQuotaStore(join(dir, GEMINI.quotaFile), logger),
  );
  return {
    api: new GeminiApi(
      config.gemini.apiKey,
      overrides.fetchImpl,
      logger,
      config.gemini.excludeModels,
      config.gemini.model,
      quota,
    ),
    health: new ModelHealth(Date.now, store),
  };
}

/** Chat AIs in the order they are tried: the main one, then the backup. */
export function buildProviders(
  config: AppConfig,
  logger: Logger | undefined,
  overrides: ContainerOverrides = {},
  gemini: GeminiShared = createGeminiShared(config, logger, overrides),
): ChatProvider[] {
  const geminiChat = config.gemini.apiKey
    ? new GeminiChatProvider(gemini.api, {
        model: config.gemini.model,
        thinkingLevel: config.gemini.thinkingLevel,
        health: gemini.health,
        ...(logger ? { logger } : {}),
      })
    : null;
  const groq = config.llm.apiKey
    ? new OpenAICompatibleProvider({
        client: overrides.openAIClient ?? createOpenAIClient(config.llm),
        model: config.llm.model,
        fallbackModel: config.llm.fallbackModel,
        reasoningEffort: config.llm.reasoningEffort,
        name: 'groq',
        ...(logger ? { logger } : {}),
      })
    : null;
  const ordered = config.mainAI === 'gemini' ? [geminiChat, groq] : [groq, geminiChat];
  return ordered.filter((p): p is GeminiChatProvider | OpenAICompatibleProvider => p !== null);
}

/** Pre-rating of requests (1-10): a quick Gemini call when available and enabled, otherwise the heuristic. */
export function buildRater(config: AppConfig, gemini: GeminiShared, logger?: Logger): RequestRater {
  return config.routerRating === 'ai' && config.gemini.apiKey
    ? new GeminiRater(gemini.api, gemini.health, logger)
    : new HeuristicRater();
}

/** Where "@bot summary" gets its numbers when Yahoo fails: Alpaca (live ETFs), then Massive (last close). */
export function marketBackups(config: AppConfig, fetchImpl?: FetchLike): BackupMarketSource[] {
  const http = () => new HttpClient({ timeoutMs: 20_000, ...(fetchImpl ? { fetchImpl } : {}) });
  const backups: BackupMarketSource[] = [];
  if (config.alpaca.keyId && config.alpaca.secretKey) {
    backups.push(
      new AlpacaLiveData({
        keyId: config.alpaca.keyId,
        secretKey: config.alpaca.secretKey,
        feed: config.alpaca.feed,
        http: http(),
      }),
    );
  }
  if (config.massiveApiKey) backups.push(new MassiveEndOfDay({ apiKey: config.massiveApiKey, http: http() }));
  return backups;
}

/** The browser-rendered summary picture when Chromium is available, else (or on failure) the built-in SVG slides. */
export function summaryRenderer(chromiumPath: string, builtIn: SummaryRenderer, logger?: Logger): SummaryRenderer {
  if (chromiumPath.toLowerCase() === 'off') return builtIn;
  const executablePath = findChromium(chromiumPath || undefined);
  if (!executablePath) {
    logger?.info('Chromium not found: "@bot summary" uses the built-in slides');
    return builtIn;
  }
  return new FallbackSummaryRenderer(new BrowserSummaryRenderer({ executablePath }), builtIn, logger);
}

export function createContainer(config: AppConfig, logger: Logger, overrides: ContainerOverrides = {}) {
  const fetchImpl = overrides.fetchImpl;
  const market = new YahooMarketData(
    new HttpClient({ cacheTtlMs: CACHE_TTL_MS.market, ...(fetchImpl ? { fetchImpl } : {}) }),
  );
  const news = new NewsService(new HttpClient({ cacheTtlMs: CACHE_TTL_MS.news, ...(fetchImpl ? { fetchImpl } : {}) }));
  const gemini = createGeminiShared(config, logger, overrides);
  const video = new YouTubeVideoService(gemini.api, {
    model: config.gemini.model,
    fps: config.gemini.youtubeFps,
    language: config.bot.replyLanguage,
    logger,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  const providers = buildProviders(config, logger, overrides, gemini);
  const rater = buildRater(config, gemini, logger);
  const history = new ConversationHistory(config.bot.historyTurns);
  const reports = new StockReportRenderer();
  const tools = buildToolRegistry({
    market,
    news,
    video,
    reports,
    documents: new OfficeDocumentBuilder(reports),
    timezone: config.bot.timezone,
  });
  const agent = new ChatAgent({
    providers,
    tools,
    history,
    maxToolSteps: config.llm.maxToolSteps,
    timezone: config.bot.timezone,
    ownerRules: config.bot.instructions,
    replyLanguage: config.bot.replyLanguage,
    rater,
    logger,
  });
  const commands = new CommandRouter({
    market,
    news,
    history,
    summarizer: agent,
    dashboard: new MarketSummaryService({
      market,
      news,
      writer: agent,
      renderer: summaryRenderer(config.chromiumPath, reports, logger),
      backups: marketBackups(config, fetchImpl),
      timeZone: config.bot.timezone,
    }),
    logger,
    timezone: config.bot.timezone,
    summaryLanguage: config.bot.summaryLanguage,
    dmWithoutTrigger: config.access.dmWithoutTrigger,
    youtubeEnabled: video.enabled,
    image: config.image,
  });
  const handler = new MessageHandler({
    config,
    logger,
    commands,
    agent,
    rateLimiter: new RateLimiter(config.access.rateLimitPerMinute),
  });

  return { market, news, video, providers, rater, history, tools, agent, commands, handler };
}

export type Container = ReturnType<typeof createContainer>;
