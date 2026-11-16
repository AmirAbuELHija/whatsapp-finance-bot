/**
 * The tools the AI can call. Each has a JSON schema (what the AI sees) and a run function.
 * To add a tool: append to `definitions` in buildToolRegistry.
 */
import { LIMITS } from '../../config/constants.js';
import { HISTORY_RANGES } from '../../config/reference-data.js';
import { messageOf } from '../../core/errors.js';
import * as calc from '../../core/finance/calculators.js';
import type { MarketData, NewsSource, ToolSchema, VideoAnalyzer } from '../../core/types.js';

export const TOOL = {
  quote: 'get_quote',
  history: 'get_price_history',
  convert: 'convert_currency',
  news: 'get_news',
  video: 'youtube_video',
  compound: 'compound_growth',
  loan: 'loan_payment',
  goal: 'savings_goal',
  cagr: 'cagr',
  budget: 'budget_50_30_20',
} as const;

type Args = Record<string, unknown>;

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Args): unknown;
}

export interface ToolRegistry {
  readonly names: readonly string[];
  readonly schemas: readonly ToolSchema[];
  /** Runs a tool. Failures are returned as { error } so the AI can explain them. */
  call(name: string, args: Args): Promise<unknown>;
}

const numberParam = (description: string) => ({ type: 'number', description });
const str = (v: unknown): string => {
  if (typeof v === 'string') return v;
  return typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
};
const num = (v: unknown): number => Number(v);
const optionalNum = (v: unknown): number | undefined => (v == null || v === '' ? undefined : Number(v));

export interface ToolDependencies {
  market: MarketData;
  news?: NewsSource | undefined;
  video?: VideoAnalyzer | undefined;
}

export function buildToolRegistry({ market, news, video }: ToolDependencies): ToolRegistry {
  const definitions: ToolDefinition[] = [
    {
      name: TOOL.quote,
      description:
        'Latest price, daily change and 52-week range. Use Yahoo symbols: AAPL, MSFT, ^GSPC (S&P 500), ^IXIC (Nasdaq), ' +
        `TEVA.TA / TA35.TA (Tel Aviv), BTC-USD (crypto), USDILS=X (FX), GC=F (gold). Up to ${LIMITS.maxQuotesPerRequest} symbols.`,
      parameters: {
        type: 'object',
        properties: {
          symbols: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: LIMITS.maxQuotesPerRequest },
        },
        required: ['symbols'],
      },
      run: async ({ symbols }) => {
        const list = (Array.isArray(symbols) ? symbols : [symbols]).map(str).slice(0, LIMITS.maxQuotesPerRequest);
        const settled = await Promise.allSettled(list.map((s) => market.getQuote(s)));
        return settled.map((r, i) =>
          r.status === 'fulfilled' ? r.value : { symbol: list[i], error: messageOf(r.reason) },
        );
      },
    },
    {
      name: TOOL.history,
      description:
        'Performance of one symbol over a period: start/end price, % change, high, low, max drawdown, annualized volatility.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          range: { type: 'string', enum: Object.keys(HISTORY_RANGES), description: 'Period, default 1mo' },
        },
        required: ['symbol'],
      },
      run: ({ symbol, range }) => market.getHistory(str(symbol), range == null ? undefined : str(range)),
    },
    {
      name: TOOL.convert,
      description: 'Convert an amount between currencies (USD, ILS, EUR, GBP, JPY, ... and crypto like BTC).',
      parameters: {
        type: 'object',
        properties: { amount: numberParam('Amount to convert'), from: { type: 'string' }, to: { type: 'string' } },
        required: ['amount', 'from', 'to'],
      },
      run: ({ amount, from, to }) => market.convertCurrency(num(amount), str(from), str(to)),
    },
    {
      name: TOOL.compound,
      description:
        'Future value of an investment with monthly compounding and optional monthly deposits; optional inflation adjustment.',
      parameters: {
        type: 'object',
        properties: {
          principal: numberParam('Starting amount (0 if none)'),
          annual_rate_pct: numberParam('Expected yearly return in percent, e.g. 7'),
          years: numberParam('Number of years'),
          monthly_contribution: numberParam('Deposit added every month (default 0)'),
          inflation_pct: numberParam("Optional yearly inflation in percent to show the value in today's money"),
        },
        required: ['principal', 'annual_rate_pct', 'years'],
      },
      run: (a) =>
        calc.compoundGrowth({
          principal: num(a.principal),
          annualRatePct: num(a.annual_rate_pct),
          years: num(a.years),
          monthlyContribution: optionalNum(a.monthly_contribution) ?? 0,
          inflationPct: optionalNum(a.inflation_pct) ?? null,
        }),
    },
    {
      name: TOOL.loan,
      description: 'Monthly payment, total paid and total interest for a fixed-rate loan or mortgage.',
      parameters: {
        type: 'object',
        properties: {
          principal: numberParam('Loan amount'),
          annual_rate_pct: numberParam('Yearly interest in percent'),
          years: numberParam('Loan term in years'),
        },
        required: ['principal', 'annual_rate_pct', 'years'],
      },
      run: (a) =>
        calc.loanPayment({ principal: num(a.principal), annualRatePct: num(a.annual_rate_pct), years: num(a.years) }),
    },
    {
      name: TOOL.goal,
      description: 'How much to save each month to reach a target amount in a given number of years.',
      parameters: {
        type: 'object',
        properties: {
          target: numberParam('Target amount'),
          annual_rate_pct: numberParam('Expected yearly return in percent'),
          years: numberParam('Years until the goal'),
          current_savings: numberParam('Already saved (default 0)'),
        },
        required: ['target', 'annual_rate_pct', 'years'],
      },
      run: (a) =>
        calc.savingsGoal({
          target: num(a.target),
          annualRatePct: num(a.annual_rate_pct),
          years: num(a.years),
          currentSavings: optionalNum(a.current_savings) ?? 0,
        }),
    },
    {
      name: TOOL.cagr,
      description: 'Compound annual growth rate and total return between a start and end value.',
      parameters: {
        type: 'object',
        properties: {
          start_value: numberParam('Starting value'),
          end_value: numberParam('Ending value'),
          years: numberParam('Years between them'),
        },
        required: ['start_value', 'end_value', 'years'],
      },
      run: (a) => calc.cagr({ startValue: num(a.start_value), endValue: num(a.end_value), years: num(a.years) }),
    },
    {
      name: TOOL.budget,
      description: 'Split a monthly income into needs (50%), wants (30%) and savings (20%).',
      parameters: {
        type: 'object',
        properties: { monthly_income: numberParam('Monthly net income') },
        required: ['monthly_income'],
      },
      run: (a) => calc.budget503020({ monthlyIncome: num(a.monthly_income) }),
    },
  ];

  if (news) {
    definitions.splice(3, 0, {
      name: TOOL.news,
      description:
        'Search the latest news on ANY topic (markets, companies, economy, politics, tech, sports...). Use it for anything recent ' +
        'or "what happened with..." questions. Returns headlines (title, outlet, time, link). query can be a ticker (AAPL, TEVA.TA, BTC-USD), a topic in any language ' +
        '("Fed rates", "ריבית בנק ישראל"), "il" for Tel Aviv market news, or empty for general market news. ' +
        'Only report what the headlines say; do not invent details.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Ticker, topic, "il", or empty for the overall market' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: LIMITS.maxHeadlinesForAi,
            description: `Number of headlines, default ${LIMITS.defaultHeadlines}; use ~10 for a market summary`,
          },
        },
      },
      run: ({ query, limit }) =>
        news.getNews(str(query), {
          limit: Math.min(optionalNum(limit) ?? LIMITS.defaultHeadlines, LIMITS.maxHeadlinesForAi),
        }),
    });
  }

  if (video?.enabled) {
    definitions.push({
      name: TOOL.video,
      description:
        'Watch a PUBLIC YouTube video from its link and answer about it: a summary, the key points, or a specific question ' +
        '("what does he say about NVDA?"). Use it whenever the message (or the message being replied to) contains a YouTube link. ' +
        "Pass the user's request as `question`, in the user's language. Can take up to a minute for long videos.",
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The YouTube link' },
          question: { type: 'string', description: 'What the user wants to know; leave empty for a summary' },
        },
        required: ['url'],
      },
      run: ({ url, question }) => video.ask(str(url), str(question)),
    });
  }

  const byName = new Map(definitions.map((d) => [d.name, d]));
  return {
    names: definitions.map((d) => d.name),
    schemas: definitions.map(({ name, description, parameters }) => ({
      type: 'function' as const,
      function: { name, description, parameters },
    })),
    async call(name, args) {
      const definition = byName.get(name);
      if (!definition) return { error: `Unknown tool "${name}"` };
      try {
        return await definition.run(args);
      } catch (error) {
        return { error: messageOf(error) };
      }
    },
  };
}
