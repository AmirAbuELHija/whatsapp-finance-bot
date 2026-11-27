/**
 * Slash commands ("@bot /price AAPL"): instant and deterministic. Only /summary uses the AI (once, cached).
 * To add a command: add an entry to `handlers` in the constructor.
 */
import { CACHE_TTL_MS, LIMITS } from '../../config/constants.js';
import { DEFAULT_HISTORY_RANGE, HISTORY_RANGES } from '../../config/reference-data.js';
import { TtlCache } from '../../core/cache/ttl-cache.js';
import { AiProviderError, UserInputError, messageOf } from '../../core/errors.js';
import * as calc from '../../core/finance/calculators.js';
import { duration, num, parseAmount, pct, shortTime } from '../../core/text/format.js';
import { languageFromWord } from '../../core/text/language.js';
import type { MarketData, NewsItem, NewsSource, OutgoingFile } from '../../core/types.js';
import type { ConversationHistory } from '../conversation/history.js';
import { formatConversion, formatHistory, formatNews, formatQuote } from './formatters.js';
import { helpText } from './help.js';

export interface CommandContext {
  chatId: string;
  senderIds?: readonly string[];
  /** Commands that make pictures or documents add them here; they are sent after the text. */
  files?: OutgoingFile[];
}

/** Builds the "@bot summary" dashboard slides. */
export interface DashboardBuilder {
  build(language: string): Promise<{ text: string; files: OutgoingFile[] }>;
}

type Handler = (args: string[], ctx: CommandContext) => string | Promise<string>;

export interface Summarizer {
  summarize(input: { topic: string; items: readonly NewsItem[]; language: string }): Promise<string>;
}

export interface CommandRouterOptions {
  market: MarketData;
  news?: NewsSource | undefined;
  history: ConversationHistory;
  summarizer?: Summarizer | undefined;
  dashboard?: DashboardBuilder | undefined;
  logger?: { warn(obj: object, msg: string): void } | undefined;
  timezone: string;
  /** Language name or code for /summary when none is given. */
  summaryLanguage?: string;
  dmWithoutTrigger?: boolean;
  youtubeEnabled?: boolean;
  /** The deployed Docker image, shown by /status ("" or undefined = not a deployed image). */
  image?: string | undefined;
  /** When the bot started (ms); defaults to when the router was created. */
  startedAt?: number;
  now?: () => number;
}

/** "registry/…/bot@sha256:1a2b3c4d…" → "sha256:1a2b3c4d5e6f" (enough to tell two deploys apart). */
function shortImage(image: string | undefined): string {
  if (!image) return 'local build (not a deployed image)';
  const digest = /@(sha256:[0-9a-f]{12})/.exec(image)?.[1];
  return digest ?? image.split('/').pop() ?? image;
}

const CONNECTOR_WORDS = /^(to|in|into|=|->)$/i;
const COMMAND = /^\/[a-z]/i;

/** Parses numeric arguments; throws a usage message when required ones are missing. */
function amounts(command: string, args: readonly string[], names: readonly string[], required: number): number[] {
  const values = args.map(parseAmount);
  if (values.length < required || values.slice(0, names.length).some((v) => Number.isNaN(v))) {
    throw new UserInputError(`Usage: /${command} ${names.map((n, i) => (i < required ? n : `[${n}]`)).join(' ')}`);
  }
  return values;
}

export class CommandRouter {
  private readonly handlers: Readonly<Record<string, Handler>>;
  private readonly summaryCache: TtlCache<string>;

  constructor(private readonly options: CommandRouterOptions) {
    this.summaryCache = new TtlCache(CACHE_TTL_MS.summary, LIMITS.summaryCacheEntries, options.now);
    const { market, history, timezone } = options;
    const now = options.now ?? Date.now;
    const startedAt = options.startedAt ?? now();

    const handlers: Record<string, Handler> = {
      help: () =>
        helpText({ dmWithoutTrigger: options.dmWithoutTrigger ?? false, youtube: options.youtubeEnabled ?? false }),

      price: async (args) => {
        if (!args.length) throw new UserInputError('Usage: /price AAPL [MSFT ...]');
        const symbols = args.slice(0, LIMITS.maxQuotesPerRequest);
        const settled = await Promise.allSettled(symbols.map((s) => market.getQuote(s)));
        return settled
          .map((r, i) =>
            formatQuote(
              r.status === 'fulfilled'
                ? r.value
                : { symbol: (symbols[i] ?? '').toUpperCase(), error: messageOf(r.reason) },
              timezone,
            ),
          )
          .join('\n\n');
      },

      history: async ([symbol, range = DEFAULT_HISTORY_RANGE]) => {
        if (!symbol) throw new UserInputError(`Usage: /history SYMBOL [${Object.keys(HISTORY_RANGES).join('|')}]`);
        return formatHistory(await market.getHistory(symbol, range));
      },

      fx: async (args) => {
        const words = args.filter((w) => !CONNECTOR_WORDS.test(w));
        let amount = 1;
        if (words.length && !Number.isNaN(parseAmount(words[0]))) amount = parseAmount(words.shift());
        const [from, to] = words;
        if (!from || !to) throw new UserInputError('Usage: /fx [amount] FROM TO — e.g. /fx 100 USD ILS');
        return formatConversion(await market.convertCurrency(amount, from.toUpperCase(), to.toUpperCase()), timezone);
      },

      news: async (args) => {
        if (!options.news) throw new UserInputError('News is not configured');
        return formatNews(await options.news.getNews(args.join(' ')));
      },

      summary: (args, ctx) => this.summary(args, ctx),

      compound: (args) => {
        const [principal = 0, rate = 0, years = 0, monthly = 0] = amounts(
          'compound',
          args,
          ['start', 'rate%', 'years', 'monthly'],
          3,
        );
        const r = calc.compoundGrowth({ principal, annualRatePct: rate, years, monthlyContribution: monthly });
        return [
          '*Compound growth*',
          `${num(principal)} start · +${num(monthly)}/mo · ${num(rate)}%/yr · ${num(years)} yrs`,
          `➡️ Final value: *${num(r.finalValue)}*`,
          `You put in: ${num(r.totalContributed)}`,
          `Growth: ${num(r.totalGrowth)}`,
        ].join('\n');
      },

      loan: (args) => {
        const [principal = 0, rate = 0, years = 0] = amounts('loan', args, ['amount', 'rate%', 'years'], 3);
        const r = calc.loanPayment({ principal, annualRatePct: rate, years });
        return [
          '*Loan / mortgage*',
          `${num(principal)} · ${num(rate)}%/yr · ${num(years)} yrs (${r.months} payments)`,
          `➡️ Monthly payment: *${num(r.monthlyPayment)}*`,
          `Total paid: ${num(r.totalPaid)}`,
          `Total interest: ${num(r.totalInterest)}`,
        ].join('\n');
      },

      goal: (args) => {
        const [target = 0, rate = 0, years = 0, current = 0] = amounts(
          'goal',
          args,
          ['target', 'rate%', 'years', 'saved'],
          3,
        );
        const r = calc.savingsGoal({ target, annualRatePct: rate, years, currentSavings: current });
        return [
          '*Savings goal*',
          `Target ${num(target)} in ${num(years)} yrs at ${num(rate)}%/yr, ${num(current)} saved`,
          r.alreadyOnTrack
            ? `✅ Already on track: your savings grow to ${num(r.currentSavingsGrowsTo)}`
            : `➡️ Save *${num(r.monthlyNeeded)} per month*`,
        ].join('\n');
      },

      cagr: (args) => {
        const [startValue = 0, endValue = 0, years = 0] = amounts('cagr', args, ['start', 'end', 'years'], 3);
        const r = calc.cagr({ startValue, endValue, years });
        return `*CAGR*\n${num(startValue)} → ${num(endValue)} in ${num(years)} yrs\n➡️ *${pct(r.cagrPct)} per year* (total ${pct(r.totalReturnPct)})`;
      },

      budget: (args) => {
        const [monthlyIncome = 0] = amounts('budget', args, ['monthly income'], 1);
        const r = calc.budget503020({ monthlyIncome });
        return `*50/30/20 budget* for ${num(monthlyIncome)}/mo\n- Needs (50%): ${num(r.needs50)}\n- Wants (30%): ${num(r.wants30)}\n- Savings (20%): ${num(r.savings20)}`;
      },

      reset: (_args, ctx) => {
        history.clear(ctx.chatId);
        return '🧹 Context cleared for this chat.';
      },

      status: () =>
        [
          '*Bot status* ✅',
          `Running for ${duration(now() - startedAt)} (since ${shortTime(new Date(startedAt).toISOString(), timezone)})`,
          `Version: ${shortImage(options.image)}`,
          `Node ${process.version}`,
        ].join('\n'),

      chatid: (_args, ctx) => `Chat: ${ctx.chatId}\nSender ids: ${ctx.senderIds?.join(', ') || '(you)'}`,
    };

    // Aliases
    const aliases: Record<string, keyof typeof handlers> = {
      p: 'price',
      h: 'history',
      convert: 'fx',
      mortgage: 'loan',
      n: 'news',
      brief: 'summary',
      sum: 'summary',
      summery: 'summary',
      סיכום: 'summary',
      ملخص: 'summary',
      uptime: 'status',
      version: 'status',
    };
    for (const [alias, target] of Object.entries(aliases)) {
      const handler = handlers[target];
      if (handler) handlers[alias] = handler;
    }
    this.handlers = handlers;
  }

  isCommand(text: string | null | undefined): boolean {
    return COMMAND.test((text ?? '').trim());
  }

  async run(text: string, ctx: CommandContext): Promise<string> {
    const [raw = '', ...args] = text.trim().split(/\s+/);
    const name = raw.slice(1).toLowerCase();
    const handler = this.handlers[name];
    if (!handler) return `Unknown command /${name}. Send "@bot /help".`;
    try {
      return await handler(args, ctx);
    } catch (error) {
      if (error instanceof AiProviderError) throw error; // the message handler turns AI errors into friendly text
      return `⚠️ ${messageOf(error)}`;
    }
  }

  private async summary(args: readonly string[], ctx: CommandContext): Promise<string> {
    const { news, summarizer, dashboard, summaryLanguage = 'en' } = this.options;
    if (!news || !summarizer) throw new UserInputError('Summary is not configured');
    let language = languageFromWord(summaryLanguage) ?? summaryLanguage;
    const topicWords: string[] = [];
    for (const word of args) {
      const picked = languageFromWord(word);
      if (picked) language = picked;
      else topicWords.push(word);
    }
    const query = topicWords.join(' ');

    let slidesFailed = false;
    // No topic: the full market dashboard (two slides). A topic, or any failure: the text briefing.
    if (!query && dashboard && ctx.files) {
      try {
        const built = await dashboard.build(language);
        ctx.files.push(...built.files);
        return built.text;
      } catch (error) {
        this.options.logger?.warn({ error: messageOf(error) }, 'summary slides failed, sending the text summary');
        slidesFailed = true;
      }
    }
    const key = `${query.toLowerCase()}|${language}`;
    const note = slidesFailed ? "⚠️ Couldn't draw the summary slides right now, here's the text version.\n\n" : '';
    const cached = this.summaryCache.get(key);
    if (cached) return note + cached;

    const result = await news.getNews(query, { limit: LIMITS.summaryHeadlines });
    if (!result.items.length) return `📰 No recent news found for *${result.topic}*.`;
    const text = await summarizer.summarize({
      topic: query ? result.topic : 'Global markets',
      items: result.items,
      language,
    });
    this.summaryCache.set(key, text);
    return note + text;
  }
}
