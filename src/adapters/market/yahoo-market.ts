/**
 * Market data from free public sources (no API keys):
 *  - Yahoo Finance chart endpoint (unofficial): stocks, ETFs, indices, crypto, FX, futures
 *  - Frankfurter (ECB reference rates): currency conversion
 */
import { ENDPOINTS, LIMITS } from '../../config/constants.js';
import {
  DEFAULT_HISTORY_RANGE,
  HISTORY_RANGES,
  MINOR_CURRENCIES,
  type HistoryRange,
} from '../../config/reference-data.js';
import { UpstreamError, UserInputError } from '../../core/errors.js';
import { round } from '../../core/text/format.js';
import type { Conversion, MarketData, PriceHistory, Quote } from '../../core/types.js';
import type { HttpClient } from '../http/http-client.js';
import { conversionSymbol, isCrypto, normalizeSymbol } from './symbols.js';

const SOURCES = {
  quote: 'Yahoo Finance (may be delayed)',
  history: 'Yahoo Finance closing prices',
  ecb: 'ECB reference rate via Frankfurter',
} as const;
const CURRENCY_CODE = /^[A-Z]{3,5}$/;
const PRICE_DECIMALS = { small: 4, normal: 2 } as const;
const SMALL_PRICE = 10;
const RATE_DECIMALS = 6;

interface ChartMeta {
  currency?: string;
  symbol?: string;
  longName?: string;
  shortName?: string;
  regularMarketPrice?: number;
  regularMarketTime?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  fullExchangeName?: string;
  exchangeName?: string;
  exchangeTimezoneName?: string;
}

interface ChartResult {
  meta?: ChartMeta;
  timestamp?: number[];
  indicators?: { quote?: { close?: (number | null)[]; open?: (number | null)[] }[] };
}

interface ChartResponse {
  chart?: { result?: ChartResult[] | null; error?: { description?: string } | null };
}

interface FrankfurterResponse {
  date?: string;
  rates?: Record<string, number>;
}

interface Bar {
  t: number;
  c: number;
}

const price = (x: number | null | undefined): number | null =>
  x == null || !Number.isFinite(x)
    ? null
    : round(x, Math.abs(x) < SMALL_PRICE ? PRICE_DECIMALS.small : PRICE_DECIMALS.normal);

const scaled = (x: number | undefined, factor: number): number | null => (x == null ? null : price(x * factor));

function dayKey(epochSec: number, timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'UTC' }).format(new Date(epochSec * 1000));
  } catch {
    return new Date(epochSec * 1000).toISOString().slice(0, 10);
  }
}

/** Currency as people expect it (Tel Aviv quotes come in agorot). */
function currencyOf(meta: ChartMeta): { currency: string | null; factor: number } {
  const minor = meta.currency ? MINOR_CURRENCIES[meta.currency] : undefined;
  return minor ? { currency: minor.major, factor: minor.factor } : { currency: meta.currency ?? null, factor: 1 };
}

function barsOf(result: ChartResult): Bar[] {
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  return timestamps.flatMap((t, i) => {
    const c = closes[i];
    return typeof c === 'number' && Number.isFinite(c) ? [{ t, c }] : [];
  });
}

/** The open of the latest daily bar (today's open once the market has opened). */
function todaysOpen(result: ChartResult): number | null {
  const opens = result.indicators?.quote?.[0]?.open ?? [];
  const last = opens.at(-1);
  return typeof last === 'number' && Number.isFinite(last) ? last : null;
}

/** At most LIMITS.chartPoints evenly spaced bars, always keeping the last one. */
function downsample(bars: Bar[]): Bar[] {
  const max = LIMITS.chartPoints;
  if (bars.length <= max) return bars;
  const step = (bars.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => bars[Math.round(i * step)]).filter((b): b is Bar => b !== undefined);
}

export function isHistoryRange(value: string): value is HistoryRange {
  return Object.hasOwn(HISTORY_RANGES, value);
}

export class YahooMarketData implements MarketData {
  constructor(
    private readonly http: HttpClient,
    /** Waits between retries (replaceable in tests). */
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async getQuote(symbol: string): Promise<Quote> {
    const sym = normalizeSymbol(symbol);
    const result = await this.chart(sym, '5d', '1d');
    const meta = result.meta ?? {};
    const { currency, factor } = currencyOf(meta);
    const last = meta.regularMarketPrice;
    if (last == null || !Number.isFinite(last)) throw new UserInputError(`No price available for ${sym}`);

    const previous = this.previousClose(meta, barsOf(result));
    const change = previous != null ? last - previous : null;
    return {
      symbol: sym,
      name: meta.longName ?? meta.shortName ?? sym,
      currency,
      price: price(last * factor),
      previousClose: previous != null ? price(previous * factor) : null,
      change: change != null ? price(change * factor) : null,
      changePct: change != null && previous ? round((change / previous) * 100, 2) : null,
      open: scaled(todaysOpen(result) ?? undefined, factor),
      dayHigh: scaled(meta.regularMarketDayHigh, factor),
      dayLow: scaled(meta.regularMarketDayLow, factor),
      fiftyTwoWeekHigh: scaled(meta.fiftyTwoWeekHigh, factor),
      fiftyTwoWeekLow: scaled(meta.fiftyTwoWeekLow, factor),
      exchange: meta.fullExchangeName ?? meta.exchangeName ?? null,
      marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      source: SOURCES.quote,
    };
  }

  async getHistory(symbol: string, range: string = DEFAULT_HISTORY_RANGE): Promise<PriceHistory> {
    const sym = normalizeSymbol(symbol);
    const rng = range.toLowerCase();
    if (!isHistoryRange(rng))
      throw new UserInputError(`range must be one of: ${Object.keys(HISTORY_RANGES).join(', ')}`);
    const interval = HISTORY_RANGES[rng];
    const result = await this.chart(sym, rng, interval);
    const meta = result.meta ?? {};
    const { currency, factor } = currencyOf(meta);
    const bars = barsOf(result);
    const first = bars[0];
    const last = bars.at(-1);
    if (!first || !last || bars.length < 2) throw new UserInputError(`Not enough price history for ${sym} over ${rng}`);

    const closes = bars.map((b) => b.c * factor);
    const startPrice = first.c * factor;
    const endPrice = last.c * factor;
    return {
      symbol: sym,
      name: meta.longName ?? meta.shortName ?? sym,
      currency,
      range: rng,
      from: new Date(first.t * 1000).toISOString().slice(0, 10),
      to: new Date(last.t * 1000).toISOString().slice(0, 10),
      startPrice: price(startPrice),
      endPrice: price(endPrice),
      changePct: round((endPrice / startPrice - 1) * 100, 2),
      high: price(Math.max(...closes)),
      low: price(Math.min(...closes)),
      maxDrawdownPct: round(maxDrawdown(closes) * 100, 2),
      annualizedVolatilityPct: interval === '1d' ? annualizedVolatility(closes) : null,
      bars: bars.length,
      points: downsample(bars).map((b) => ({
        date: new Date(b.t * 1000).toISOString().slice(0, 10),
        close: price(b.c * factor) ?? b.c * factor,
      })),
      source: SOURCES.history,
    };
  }

  async convertCurrency(amount: number, from: string, to: string): Promise<Conversion> {
    if (!Number.isFinite(amount)) throw new UserInputError('amount must be a number');
    const a = amount;
    const f = from.trim().toUpperCase();
    const t = to.trim().toUpperCase();
    if (!CURRENCY_CODE.test(f) || !CURRENCY_CODE.test(t))
      throw new UserInputError('Use currency codes like USD, ILS, EUR, BTC');
    if (f === t) return { amount: a, from: f, to: t, rate: 1, result: round(a, 2) };

    if (!isCrypto(f) && !isCrypto(t)) {
      try {
        const data = await this.http.getJson<FrankfurterResponse>(
          `${ENDPOINTS.frankfurterLatest}?base=${f}&symbols=${t}`,
        );
        const rate = data.rates?.[t];
        if (rate != null && Number.isFinite(rate)) {
          return {
            amount: a,
            from: f,
            to: t,
            rate: round(rate, RATE_DECIMALS),
            result: round(a * rate, 2),
            date: data.date ?? null,
            source: SOURCES.ecb,
          };
        }
      } catch {
        // ECB doesn't cover every currency; fall back to Yahoo.
      }
    }
    const quote = await this.getQuote(conversionSymbol(f, t));
    return {
      amount: a,
      from: f,
      to: t,
      rate: quote.price,
      result: quote.price == null ? null : round(a * quote.price, 2),
      date: quote.marketTime,
      source: quote.source,
    };
  }

  private async chart(sym: string, range: string, interval: string): Promise<ChartResult> {
    const path = `${encodeURIComponent(sym)}?range=${range}&interval=${interval}`;
    // Yahoo rate-limits cloud servers (HTTP 429) when many quotes are asked at once: wait a moment and try the
    // other host. 404 = unknown symbol, never retried.
    const hosts = [ENDPOINTS.yahooChart, ENDPOINTS.yahooChartBackup, ENDPOINTS.yahooChart];
    let data: ChartResponse | undefined;
    let lastError: unknown;
    for (const [attempt, host] of hosts.entries()) {
      if (attempt > 0) await this.sleep(400 * attempt + Math.floor(Math.random() * 300));
      try {
        data = await this.http.getJson<ChartResponse>(`${host}${path}`);
        break;
      } catch (error) {
        if (error instanceof UpstreamError && error.status === 404) {
          throw new UserInputError(
            `Unknown symbol ${sym}. Tel Aviv stocks end in .TA (e.g. TEVA.TA), crypto like BTC-USD`,
          );
        }
        const retryable =
          !(error instanceof UpstreamError) || error.status == null || error.status === 429 || error.status >= 500;
        if (!retryable) throw error;
        lastError = error;
      }
    }
    if (!data) throw lastError instanceof Error ? lastError : new Error(`No data for ${sym}`);
    const result = data.chart?.result?.[0];
    if (!result?.meta) throw new UserInputError(data.chart?.error?.description ?? `No data for ${sym}`);
    return result;
  }

  /** Previous session's close; computed from daily bars when Yahoo doesn't send it. */
  private previousClose(meta: ChartMeta, bars: Bar[]): number | null {
    if (meta.previousClose != null && Number.isFinite(meta.previousClose)) return meta.previousClose;
    const last = bars.at(-1);
    const beforeLast = bars.at(-2);
    if (last && beforeLast && meta.regularMarketTime) {
      const sameSession =
        dayKey(last.t, meta.exchangeTimezoneName) === dayKey(meta.regularMarketTime, meta.exchangeTimezoneName);
      return sameSession ? beforeLast.c : last.c;
    }
    return meta.chartPreviousClose ?? null;
  }
}

export function maxDrawdown(closes: readonly number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    worst = Math.min(worst, (c - peak) / peak);
  }
  return worst;
}

/** Annualized volatility in percent from daily closes, or null when there are too few points. */
export function annualizedVolatility(closes: readonly number[]): number | null {
  if (closes.length < LIMITS.minHistoryBarsForVolatility) return null;
  const returns = closes.slice(1).map((c, i) => Math.log(c / (closes[i] ?? c)));
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return round(Math.sqrt(variance) * Math.sqrt(LIMITS.tradingDaysPerYear) * 100, 1);
}
