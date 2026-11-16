/**
 * The tools the AI can call. Each has a JSON schema (what the AI sees) and a run function.
 * To add a tool: append to `definitions` in buildToolRegistry.
 */
import { LIMITS } from '../../config/constants.js';
import { HISTORY_RANGES } from '../../config/reference-data.js';
import { messageOf } from '../../core/errors.js';
import * as calc from '../../core/finance/calculators.js';
import type {
  ChartSeries,
  DocumentBuilder,
  DocumentSection,
  DocumentSpec,
  ReportRenderer,
  MarketData,
  NewsSource,
  OutgoingFile,
  ToolSchema,
  VideoAnalyzer,
} from '../../core/types.js';

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
  document: 'create_document',
  report: 'stock_report',
} as const;

/** Per-request context: files a tool creates are collected here and sent after the answer. */
export interface ToolContext {
  files: OutgoingFile[];
}

type Args = Record<string, unknown>;

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Args, context: ToolContext): unknown;
}

export interface ToolRegistry {
  readonly names: readonly string[];
  readonly schemas: readonly ToolSchema[];
  /** Runs a tool. Failures are returned as { error } so the AI can explain them. */
  call(name: string, args: Args, context?: ToolContext): Promise<unknown>;
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
  documents?: DocumentBuilder | undefined;
  reports?: ReportRenderer | undefined;
  /** For dates printed on reports. */
  timezone?: string | undefined;
  now?: () => Date;
}

const textList = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

export function buildToolRegistry({
  market,
  news,
  video,
  documents,
  reports,
  timezone = 'UTC',
  now = () => new Date(),
}: ToolDependencies): ToolRegistry {
  /** A price chart for a symbol, from market data (never from the AI). */
  const chartFor = async (symbol: string, range?: string): Promise<ChartSeries> => {
    const history = await market.getHistory(symbol, range);
    return { title: `${history.name} (${history.symbol}) · ${history.range}`, points: history.points ?? [] };
  };
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
      run: async ({ symbol, range }) => {
        // Chart points are for pictures and slides; the AI only needs the numbers.
        const { points: _points, ...history } = await market.getHistory(
          str(symbol),
          range == null ? undefined : str(range),
        );
        return history;
      },
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

  if (documents)
    definitions.push({
      name: TOOL.document,
      description:
        'Creates a file and sends it to the chat: format "pptx" for slides / a presentation / a deck, "docx" for a ' +
        'document / report / Word file (also when PDF is asked: send docx and say it can be saved as PDF). Write the ' +
        'full content yourself; get live numbers with the other tools first. Slides: short bullets, one idea each.',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['pptx', 'docx'] },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          sections: {
            type: 'array',
            description: 'In order. For slides, one section per slide.',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                chart_symbol: { type: 'string', description: 'Optional: add a price chart of this symbol (real data)' },
                chart_range: {
                  type: 'string',
                  enum: Object.keys(HISTORY_RANGES),
                  description: 'Chart period, default 1mo',
                },
                paragraphs: textList('Full sentences (documents)'),
                bullets: textList('Short points'),
                table: {
                  type: 'object',
                  properties: {
                    headers: { type: 'array', items: { type: 'string' } },
                    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                  },
                  required: ['headers', 'rows'],
                },
              },
              required: ['heading'],
            },
          },
        },
        required: ['format', 'title', 'sections'],
      },
      run: async (args, context) => {
        const format = args.format === 'docx' ? 'docx' : 'pptx';
        const raw = Array.isArray(args.sections) ? (args.sections as (DocumentSection & Args)[]) : [];
        const sections = await Promise.all(
          raw.map(async ({ chart_symbol, chart_range, ...section }) =>
            typeof chart_symbol === 'string' && chart_symbol
              ? {
                  ...section,
                  chart: await chartFor(chart_symbol, typeof chart_range === 'string' ? chart_range : undefined),
                }
              : section,
          ),
        );
        const file = await documents.build({ ...(args as unknown as DocumentSpec), format, sections });
        context.files.push(file);
        return {
          created: file.fileName,
          format,
          bytes: file.data.byteLength,
          note: 'The file will be sent to the chat.',
        };
      },
    });

  if (reports)
    definitions.push({
      name: TOOL.report,
      description:
        "Sends a designed stock report: price, today's change, a price chart, key stats and your highlights. " +
        'format "image" (default) shows as a picture in the chat; "pptx"/"docx" sends slides or a document. ' +
        "Read the news first (get_news) and pass 2-5 short highlights in the user's language. One symbol per call.",
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          range: { type: 'string', enum: Object.keys(HISTORY_RANGES), description: 'Chart period, default 3mo' },
          highlights: textList('2-5 short news/analysis points, one line each'),
          format: { type: 'string', enum: ['image', 'pptx', 'docx'] },
        },
        required: ['symbol'],
      },
      run: async (args, context) => {
        const symbol = str(args.symbol);
        const range = typeof args.range === 'string' ? args.range : '3mo';
        const [quote, history] = await Promise.all([market.getQuote(symbol), market.getHistory(symbol, range)]);
        const highlights = (Array.isArray(args.highlights) ? args.highlights : [])
          .filter((h): h is string => typeof h === 'string' && h.trim() !== '')
          .slice(0, 5);
        const format = args.format === 'pptx' || args.format === 'docx' ? args.format : 'image';
        let file;
        if (format === 'image' || !documents) {
          file = await reports.stockCard({ quote, history, highlights, generatedAt: now(), timeZone: timezone });
        } else {
          const name = quote.name || quote.symbol;
          const pct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
          file = await documents.build({
            format,
            title: `${name} (${quote.symbol})`,
            subtitle: `Stock report · ${now().toLocaleDateString('en-GB', { timeZone: timezone, dateStyle: 'medium' })}`,
            sections: [
              {
                heading: `Price · ${history.range}`,
                chart: { title: `${quote.symbol} · ${history.range}`, points: history.points ?? [] },
                bullets: [
                  `Price ${quote.price ?? '—'} ${quote.currency ?? ''} (${pct(quote.changePct)} today)`,
                  `${history.range}: ${pct(history.changePct)}, high ${history.high ?? '—'}, low ${history.low ?? '—'}`,
                ],
              },
              {
                heading: 'Key numbers',
                table: {
                  headers: ['Metric', 'Value'],
                  rows: [
                    ['Day range', `${quote.dayLow ?? '—'} – ${quote.dayHigh ?? '—'}`],
                    ['52-week range', `${quote.fiftyTwoWeekLow ?? '—'} – ${quote.fiftyTwoWeekHigh ?? '—'}`],
                    [`${history.range} change`, pct(history.changePct)],
                    ['Max drawdown', pct(history.maxDrawdownPct == null ? null : -Math.abs(history.maxDrawdownPct))],
                    ['Volatility (annualized)', pct(history.annualizedVolatilityPct)],
                  ],
                },
              },
              ...(highlights.length ? [{ heading: 'Highlights', bullets: highlights }] : []),
            ],
          });
        }
        context.files.push(file);
        return {
          created: file.fileName,
          format,
          price: quote.price,
          changePctToday: quote.changePct,
          periodChangePct: history.changePct,
          note: 'The report will be sent to the chat; just add one short sentence.',
        };
      },
    });

  const byName = new Map(definitions.map((d) => [d.name, d]));
  return {
    names: definitions.map((d) => d.name),
    schemas: definitions.map(({ name, description, parameters }) => ({
      type: 'function' as const,
      function: { name, description, parameters },
    })),
    async call(name, args, context = { files: [] }) {
      const definition = byName.get(name);
      if (!definition) return { error: `Unknown tool "${name}"` };
      try {
        return await definition.run(args, context);
      } catch (error) {
        return { error: messageOf(error) };
      }
    },
  };
}
