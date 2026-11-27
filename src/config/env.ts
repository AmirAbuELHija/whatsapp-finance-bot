/**
 * Environment settings: the single place that reads process.env, validates it and applies defaults.
 * Everything else receives a typed AppConfig.
 */
import { z } from 'zod';
import { ConfigError } from '../core/errors.js';
import { languageName } from '../core/text/language.js';

const DEFAULTS = {
  llmBaseUrl: 'https://api.groq.com/openai/v1',
  llmModel: 'openai/gpt-oss-120b',
  maxToolSteps: 5,
  youtubeFps: 0.5,
  /** Gemini 3 "thinks" a lot by default, which is slow for chat. */
  geminiThinkingLevel: 'auto',
  routerRating: 'ai',
  trigger: '@bot',
  replyPrefix: '🤖 ',
  summaryLanguage: 'en',
  rateLimitPerMinute: 6,
  historyTurns: 6,
  authDir: './auth',
  logLevel: 'info',
  timezone: 'Asia/Jerusalem',
} as const;

/** Local LLM servers (Ollama, LM Studio...) don't need a real key. */
const LOCAL_LLM = /localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|ollama/i;

const text = (fallback = '') =>
  z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim() || fallback);

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v.trim() === '' ? fallback : /^(1|true|yes|on)$/i.test(v.trim())));

const positiveNumber = (fallback: number, { integer = false } = {}) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v == null || v.trim() === '') return fallback;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
        ctx.addIssue({ code: 'custom', message: `must be a ${integer ? 'whole ' : ''}number >= 0, got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const digitsOnly = (v: string) => v.replace(/\D/g, '');

const EnvSchema = z.object({
  MAIN_AI: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const value = (v ?? '').trim().toLowerCase();
      if (!value) return undefined;
      if (value === 'gemini') return 'gemini' as const;
      if (value === 'groq' || value === 'openai') return 'groq' as const;
      ctx.addIssue({ code: 'custom', message: `must be "gemini" or "groq", got "${v}"` });
      return z.NEVER;
    }),
  LLM_BASE_URL: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const value = (v ?? '').trim();
      if (!value) return undefined;
      if (!URL.canParse(value)) {
        ctx.addIssue({ code: 'custom', message: `must be a URL, got "${value}"` });
        return z.NEVER;
      }
      return value;
    }),
  LLM_API_KEY: text(),
  LLM_MODEL: text(DEFAULTS.llmModel),
  LLM_FALLBACK_MODEL: text(),
  LLM_REASONING_EFFORT: text(),
  LLM_MAX_TOOL_STEPS: positiveNumber(DEFAULTS.maxToolSteps, { integer: true }),
  GEMINI_API_KEY: text(),
  /** Massive (formerly Polygon.io) key: last-close backup for "@bot summary" when Yahoo is unreachable. */
  MASSIVE_API_KEY: text(),
  /** Alpaca market data keys (free plan works): live backup for "@bot summary" when Yahoo is unreachable. */
  ALPACA_KEY_ID: text(),
  ALPACA_SECRET_KEY: text(),
  /** "iex" (free plan) or "sip" (paid, all US exchanges). */
  ALPACA_FEED: text('iex').transform((v) => v.toLowerCase()),
  GEMINI_MODEL: text(),
  GEMINI_EXCLUDE_MODELS: list,
  GEMINI_FREE_TIER: flag(true),
  GEMINI_THINKING_LEVEL: text(DEFAULTS.geminiThinkingLevel).transform((v) =>
    v.toLowerCase() === 'default' ? '' : v.toLowerCase(),
  ),
  ROUTER_RATING: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : undefined),
    z.enum(['ai', 'heuristic']).default(DEFAULTS.routerRating),
  ),
  YOUTUBE_FPS: positiveNumber(DEFAULTS.youtubeFps),
  BOT_TRIGGER: text(DEFAULTS.trigger),
  REPLY_PREFIX: z
    .string()
    .optional()
    .transform((v) => v ?? DEFAULTS.replyPrefix),
  BOT_INSTRUCTIONS: text(),
  REPLY_LANGUAGE: text().transform(languageName),
  DEFAULT_LANGUAGE: text(DEFAULTS.summaryLanguage).transform((v) => v.toLowerCase()),
  ALLOWED_USERS: list.transform((items) => items.map(digitsOnly).filter(Boolean)),
  ALLOWED_GROUPS: list,
  ALLOW_EVERYONE: flag(false),
  RESPOND_TO_SELF: flag(true),
  DM_WITHOUT_TRIGGER: flag(false),
  RATE_LIMIT_PER_MINUTE: positiveNumber(DEFAULTS.rateLimitPerMinute, { integer: true }),
  HISTORY_TURNS: positiveNumber(DEFAULTS.historyTurns, { integer: true }),
  PAIRING_NUMBER: text().transform(digitsOnly),
  AUTH_DIR: text(DEFAULTS.authDir),
  /** Chromium for the "@bot summary" picture. Empty: look in the usual places; "off": use the built-in SVG slides. */
  CHROMIUM_PATH: text(),
  /** Set by the server (infra/vm/run-bot.sh): the exact image that is running. Empty when run by hand. */
  BOT_IMAGE: text(),
  LOG_LEVEL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : undefined),
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default(DEFAULTS.logLevel),
  ),
  TIMEZONE: text(DEFAULTS.timezone),
});

export type MainAI = 'gemini' | 'groq';

export interface AppConfig {
  /** Which AI answers chat first; the other one is the automatic backup. */
  mainAI: MainAI;
  llm: {
    baseURL: string;
    apiKey: string;
    model: string;
    fallbackModel: string;
    reasoningEffort: string;
    maxToolSteps: number;
  };
  gemini: {
    apiKey: string;
    model: string;
    thinkingLevel: string;
    youtubeFps: number;
    /** Models never to use: exact names or "prefix*". */
    excludeModels: string[];
    /** Apply the free-tier per-model limits (skip models with no quota left). */
    freeTier: boolean;
  };
  /** How requests are rated 1-10 before routing: a quick AI call, or an instant text heuristic. */
  routerRating: 'ai' | 'heuristic';
  bot: {
    trigger: string;
    replyPrefix: string;
    instructions: string;
    /** "" = answer in the user's language. */
    replyLanguage: string;
    summaryLanguage: string;
    historyTurns: number;
    timezone: string;
  };
  access: {
    allowedUsers: string[];
    allowedGroups: string[];
    allowEveryone: boolean;
    respondToSelf: boolean;
    dmWithoutTrigger: boolean;
    rateLimitPerMinute: number;
  };
  whatsapp: { authDir: string; pairingNumber: string };
  /** The deployed Docker image ("…@sha256:…"); "" when not run from a deployed image. */
  image: string;
  /** "" = find Chromium automatically, "off" = never use a browser. */
  chromiumPath: string;
  /** "" = no end-of-day backup for the summary. */
  massiveApiKey: string;
  alpaca: { keyId: string; secretKey: string; feed: string };
  logLevel: string;
}

/** Parses and validates the environment. Throws ConfigError listing every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new ConfigError(`Invalid settings in .env:\n- ${problems.join('\n- ')}`, problems);
  }
  const e = parsed.data;
  const baseURL = e.LLM_BASE_URL ?? DEFAULTS.llmBaseUrl;
  const llmKey = e.LLM_API_KEY || (LOCAL_LLM.test(baseURL) ? 'local' : '');

  return {
    mainAI: e.MAIN_AI ?? (llmKey ? 'groq' : 'gemini'),
    llm: {
      baseURL,
      apiKey: llmKey,
      model: e.LLM_MODEL,
      fallbackModel: e.LLM_FALLBACK_MODEL,
      reasoningEffort: e.LLM_REASONING_EFFORT,
      maxToolSteps: e.LLM_MAX_TOOL_STEPS,
    },
    gemini: {
      apiKey: e.GEMINI_API_KEY,
      model: e.GEMINI_MODEL,
      thinkingLevel: e.GEMINI_THINKING_LEVEL,
      youtubeFps: e.YOUTUBE_FPS,
      excludeModels: e.GEMINI_EXCLUDE_MODELS,
      freeTier: e.GEMINI_FREE_TIER,
    },
    routerRating: e.ROUTER_RATING,
    bot: {
      trigger: e.BOT_TRIGGER,
      replyPrefix: e.REPLY_PREFIX,
      instructions: e.BOT_INSTRUCTIONS,
      replyLanguage: e.REPLY_LANGUAGE,
      summaryLanguage: e.REPLY_LANGUAGE || e.DEFAULT_LANGUAGE,
      historyTurns: e.HISTORY_TURNS,
      timezone: e.TIMEZONE,
    },
    access: {
      allowedUsers: e.ALLOWED_USERS,
      allowedGroups: e.ALLOWED_GROUPS,
      allowEveryone: e.ALLOW_EVERYONE,
      respondToSelf: e.RESPOND_TO_SELF,
      dmWithoutTrigger: e.DM_WITHOUT_TRIGGER,
      rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    },
    whatsapp: { authDir: e.AUTH_DIR, pairingNumber: e.PAIRING_NUMBER },
    image: e.BOT_IMAGE,
    chromiumPath: e.CHROMIUM_PATH,
    massiveApiKey: e.MASSIVE_API_KEY,
    alpaca: { keyId: e.ALPACA_KEY_ID, secretKey: e.ALPACA_SECRET_KEY, feed: e.ALPACA_FEED },
    logLevel: e.LOG_LEVEL,
  };
}

/** Cross-field checks that need the whole config (e.g. the main AI must have a key). */
export function configProblems(config: AppConfig): string[] {
  const problems: string[] = [];
  if (config.mainAI === 'gemini' && !config.gemini.apiKey) {
    problems.push('MAIN_AI=gemini but GEMINI_API_KEY is empty. Get a free key at https://aistudio.google.com/apikey');
  }
  if (config.mainAI === 'groq' && !config.llm.apiKey) {
    problems.push('LLM_API_KEY is empty. Get a free key (see README) and put it in .env, or set MAIN_AI=gemini');
  }
  if (!config.bot.trigger) problems.push('BOT_TRIGGER is empty');
  return problems;
}
