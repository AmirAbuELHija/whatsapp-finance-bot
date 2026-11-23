/**
 * Fixed technical values: endpoints, timeouts, cache lifetimes and size limits.
 * Things an operator may want to change live in the environment schema (env.ts) instead.
 */

export const ENDPOINTS = {
  yahooChart: 'https://query1.finance.yahoo.com/v8/finance/chart/',
  /** Same API on another host: used when query1 is rate-limiting or down. */
  yahooChartBackup: 'https://query2.finance.yahoo.com/v8/finance/chart/',
  yahooSearch: 'https://query1.finance.yahoo.com/v1/finance/search',
  frankfurterLatest: 'https://api.frankfurter.dev/v1/latest',
  googleNewsRss: 'https://news.google.com/rss/search',
  youtubeOembed: 'https://www.youtube.com/oembed',
  youtubeWatch: 'https://www.youtube.com/watch?v=',
  geminiApi: 'https://generativelanguage.googleapis.com/v1beta',
} as const;

export const HTTP = {
  /** Some public endpoints reject requests without a browser-like user agent. */
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  timeoutMs: 10_000,
  oembedTimeoutMs: 8_000,
  maxCacheEntries: 500,
} as const;

export const CACHE_TTL_MS = {
  market: 60_000,
  news: 5 * 60_000,
  summary: 10 * 60_000,
  video: 60 * 60_000,
  groupMetadata: 5 * 60_000,
} as const;

export const LIMITS = {
  maxReplyChars: 4_000,
  maxQuotesPerRequest: 5,
  maxToolResultChars: 6_000,
  quotedBotSnippetChars: 300,
  quotedMessageSnippetChars: 1_500,
  defaultHeadlines: 5,
  maxHeadlinesForAi: 10,
  maxHeadlines: 20,
  summaryHeadlines: 15,
  maxNewsQueryChars: 120,
  rememberedSentIds: 1_000,
  sentMessageStoreSize: 500,
  historyMaxChats: 200,
  rateLimiterMaxKeys: 5_000,
  summaryCacheEntries: 50,
  videoCacheEntries: 100,
  minHistoryBarsForVolatility: 10,
  tradingDaysPerYear: 252,
  /** Points kept per price history for charts. */
  chartPoints: 160,
  /** Pictures bigger than this are refused (Gemini takes up to ~20MB per request, inline). */
  maxImageBytes: 8 * 1024 * 1024,
  /**
   * Requests with a picture are rated within this range: Flash with low thinking reads pictures well and fast,
   * while high thinking on a picture often takes longer than the timeout.
   */
  minImageScore: 4,
  maxImageScore: 6,
} as const;

/** Word documents and slide decks the bot can create (create_document tool). */
export const DOCUMENTS = {
  maxSections: 20,
  maxItemsPerSection: 12,
  maxTextChars: 1_200,
  maxTitleChars: 120,
  maxTableRows: 25,
  maxTableColumns: 8,
  /** Bullets per slide before a section continues on the next slide. */
  bulletsPerSlide: 7,
  /** Points shown under a chart on the same slide. */
  bulletsUnderChart: 3,
  mimeTypes: {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
} as const;

/** Picture formats Gemini can read. */
export const IMAGE_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];

export const TIMING = {
  typingRefreshMs: 10_000,
  reconnectInitialMs: 2_000,
  reconnectMaxMs: 60_000,
  rateLimitWindowMs: 60_000,
  /** A "heartbeat" log line this often while connected; the cloud alert fires when they stop. */
  heartbeatMs: 5 * 60_000,
  /** Disconnected this long = something is stuck: exit so the service manager starts a fresh process. */
  maxDisconnectedMs: 15 * 60_000,
} as const;

export const AI = {
  /** Room for a whole document or deck in one tool call. */
  maxCompletionTokens: 6_144,
  chatTemperature: 0.2,
  summaryTemperature: 0.3,
  /** HTTP statuses where trying the backup model of the same provider makes sense. */
  retryableStatuses: [404, 408, 413, 429, 500, 502, 503, 504] as readonly number[],
} as const;

export const GEMINI = {
  modelListPageSize: 1_000,
  modelListTimeoutMs: 15_000,
  videoTimeoutMs: 180_000,
  /** Per attempt, by tier: a model that doesn't answer in time is skipped for the next rung. */
  chatTimeoutMs: { lite: 20_000, flash: 35_000, pro: 45_000 },
  /** Stop climbing the ladder after this many attempts or this long, then hand over to the backup AI. */
  maxAttemptsPerRequest: 3,
  requestBudgetMs: 60_000,
  /**
   * Hedging: if a model hasn't answered after this long, a second (faster) model is asked in parallel and the
   * first good answer wins. Overloaded models often hang instead of saying "busy", so this keeps replies quick.
   */
  hedgeAfterMs: 8_000,
  /**
   * Routing ladder, least to most reasoning. A request starts at the rung for its estimated effort
   * and climbs when a model fails, is busy, or gives a weak answer.
   */
  ladder: [
    { tier: 'lite', thinkingLevel: 'low' },
    { tier: 'flash', thinkingLevel: 'low' },
    { tier: 'flash', thinkingLevel: 'high' },
    { tier: 'pro', thinkingLevel: 'high' },
  ] as const,
  /** Score (1-10) → starting rung of the ladder. */
  scoreBands: [
    // Free tier: Flash-Lite has ~25x the daily quota of Flash, so it takes everything up to 5.
    { maxScore: 5, rung: 0 },
    { maxScore: 7, rung: 1 },
    { maxScore: 9, rung: 2 },
    { maxScore: 10, rung: 3 },
  ] as const,
  /** The AI rater must answer fast; otherwise the heuristic score is used. */
  raterTimeoutMs: 3_000,
  /**
   * How long a model is skipped after a problem. A first timeout counts as busy (10 min); a second timeout
   * within a day removes that model (at that thinking level) for a day, remembered across restarts.
   */
  cooldownMs: {
    busy: 10 * 60_000,
    /** Answered, but slower than the hedge delay (or lost the race to a faster model). */
    slow: 10 * 60_000,
    timeout: 24 * 60 * 60_000,
    unavailable: 24 * 60 * 60_000,
  },
  /** File in AUTH_DIR that remembers resting models across restarts. */
  healthFile: 'gemini-model-health.json',
  /** File in AUTH_DIR with today's request count per model. */
  quotaFile: 'gemini-quota.json',
  /** Google resets the free daily quota at midnight Pacific time. */
  quotaTimeZone: 'America/Los_Angeles',
  /**
   * Free-tier limits from Google AI Studio (Usage → rate limits), requests per minute / per day.
   * The router skips a model that has none left, instead of wasting a call on a 429. A 0 means the model
   * isn't on the free tier. Applied while GEMINI_FREE_TIER=true (the default); update when Google changes them.
   */
  freeTierLimits: {
    'gemini-4-hydrogen': { rpm: 5, rpd: 20 },
    'gemini-3.8-flash': { rpm: 5, rpd: 20 },
    'gemini-3.6-flash': { rpm: 5, rpd: 20 },
    'gemini-3-flash': { rpm: 5, rpd: 20 },
    'gemini-3-flash-preview': { rpm: 5, rpd: 20 },
    'gemini-2.5-flash': { rpm: 5, rpd: 20 },
    'gemini-3.5-flash-lite': { rpm: 15, rpd: 500 },
    'gemini-3.1-flash-lite': { rpm: 15, rpd: 500 },
    'gemini-2.5-flash-lite': { rpm: 10, rpd: 20 },
    'gemini-2.0-flash': { rpm: 0, rpd: 0 },
    'gemini-2.0-flash-001': { rpm: 0, rpd: 0 },
    'gemini-2.0-flash-lite': { rpm: 0, rpd: 0 },
    'gemini-2.0-flash-lite-001': { rpm: 0, rpd: 0 },
    'gemini-2.5-pro': { rpm: 0, rpd: 0 },
    'gemini-3.1-pro': { rpm: 0, rpd: 0 },
    'gemini-4-argon': { rpm: 0, rpd: 0 },
    'gemini-4-carbon': { rpm: 0, rpd: 0 },
  } as Readonly<Record<string, { rpm: number; rpd: number }>>,
  /** `npm run check -- --probe`: a model slower than this on a tiny prompt is suggested for exclusion. */
  probeTimeoutMs: 15_000,
  /** Documented sentinel for function calls that did not come from Gemini (e.g. made by the backup AI). */
  skipThoughtSignature: 'skip_thought_signature_validator',
  /**
   * Gemini 4 uses element codenames instead of flash/pro (gemini-4-argon...). Known codenames → routing tier.
   * Hydrogen is the reported fast Flash-tier Gemini 4 (not released yet; picked up automatically when it is).
   * Add new codenames here when Google ships them.
   */
  codenameTiers: { hydrogen: 'flash', argon: 'pro' } as Readonly<Record<string, 'lite' | 'flash' | 'pro'>>,
  /** Previews are skipped for older generations, but allowed from this version on (new models start as previews). */
  previewFromVersion: 4,
  /** Used when the account cannot list models. */
  fallbackModels: [
    'gemini-4-hydrogen',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.7-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-flash-lite-latest',
    'gemini-flash-latest',
  ] as readonly string[],
} as const;

export const WHATSAPP = {
  statusBroadcastJid: 'status@broadcast',
  groupSuffix: '@g.us',
  newsletterSuffix: '@newsletter',
  browserName: 'Chrome',
} as const;
