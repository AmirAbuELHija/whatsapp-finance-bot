/**
 * Massive (formerly Polygon.io) free "Basic" key: end-of-day data, 5 API calls a minute. Used when Yahoo can't
 * be reached from the server, so "@bot summary" still shows the last close instead of nothing.
 *
 * One summary needs at most 5 calls, and most of them are cached (a closed day never changes):
 *   1. Nasdaq Composite (I:COMP) daily bars, 7 months → the index, the trend chart, and which days are latest
 *   2-3. Every US stock and ETF for the latest and the previous trading day (grouped daily) → sectors, SPY/DIA,
 *        oil/gold ETFs, the watchlist, the biggest movers across the market and how many stocks rose or fell
 *   4-5. Every crypto pair for the same two days → Bitcoin
 * The key is sent in a header, never in a URL (URLs end up in logs and error messages).
 */
import { HttpClient } from '../http/http-client.js';
import { UpstreamError } from '../../core/errors.js';
import type {
  BackupMarketData,
  BackupMarketRequest,
  BackupMarketSource,
  PricePoint,
  SnapshotItem,
} from '../../core/types.js';

const BASE = 'https://api.massive.com';
const DAY_MS = 86_400_000;

interface Bar {
  T?: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  t?: number;
}
interface AggsResponse {
  results?: Bar[];
  resultsCount?: number;
  status?: string;
}

/** Waits so that no more than `limit` calls start in any `windowMs` (the free key allows 5 a minute). */
export class RateLimiter {
  private readonly starts: number[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const go = this.chain.then(async () => {
      for (;;) {
        const t = this.now();
        while (this.starts.length && t - (this.starts[0] ?? 0) >= this.windowMs) this.starts.shift();
        if (this.starts.length < this.limit) break;
        await this.sleep(this.windowMs - (t - (this.starts[0] ?? t)) + 50);
      }
      this.starts.push(this.now());
    });
    this.chain = go.catch(() => undefined);
    return go.then(task);
  }
}

/** Yahoo symbols → what stands in for them on Massive (stock-plan ETFs where the real thing is a paid index). */
const STAND_INS: Record<string, { ticker: string; label: string }> = {
  '^GSPC': { ticker: 'SPY', label: 'S&P 500 (SPY)' },
  '^DJI': { ticker: 'DIA', label: 'Dow Jones (DIA)' },
  'CL=F': { ticker: 'USO', label: 'Oil (USO fund)' },
  'GC=F': { ticker: 'GLD', label: 'Gold (GLD fund)' },
};

const dayOf = (key: string) => key.slice(key.indexOf(':') + 1);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Liquid enough to count as a "big mover": $500M+ traded and at least $5 a share. */
const MIN_DOLLAR_VOLUME = 500_000_000;
const MIN_PRICE = 5;

export interface MassiveOptions {
  apiKey: string;
  http?: HttpClient;
  limiter?: RateLimiter;
  now?: () => number;
}

export class MassiveEndOfDay implements BackupMarketSource {
  readonly name = 'Massive';
  private readonly http: HttpClient;
  private readonly limiter: RateLimiter;
  private readonly now: () => number;
  /** Closed days never change: kept until a newer day replaces them (3 days × 2 markets). */
  private readonly grouped = new Map<string, Map<string, Bar>>();
  private index: { at: number; bars: Bar[] } | null = null;

  constructor(private readonly options: MassiveOptions) {
    this.http = options.http ?? new HttpClient();
    this.limiter = options.limiter ?? new RateLimiter(5, 60_000);
    this.now = options.now ?? Date.now;
  }

  async fetchBackup(request: BackupMarketRequest): Promise<BackupMarketData> {
    const bars = await this.nasdaqBars();
    // The newest index bar can appear before the all-stocks file for that day is ready: then use the day before.
    let end = bars.length;
    let stocks = new Map<string, Bar>();
    let prevStocks = new Map<string, Bar>();
    let last: Bar | undefined;
    let before: Bar | undefined;
    for (let tries = 0; tries < 2; tries += 1) {
      last = bars[end - 1];
      before = bars[end - 2];
      if (!last?.t || !before?.t) break;
      stocks = await this.groupedDay('stocks', isoDay(last.t));
      if (stocks.size) {
        prevStocks = await this.groupedDay('stocks', isoDay(before.t));
        break;
      }
      end -= 1;
    }
    if (!last?.t || !before?.t) throw new Error('Massive: no recent index data');
    if (!stocks.size) throw new Error('Massive: no end-of-day stock data yet');
    const day = isoDay(last.t);
    // Crypto trades every day; compare with the calendar day before. Optional: a failure only drops Bitcoin.
    const crypto = await Promise.all([
      this.groupedDay('crypto', day),
      this.groupedDay('crypto', isoDay(Date.parse(`${day}T00:00:00Z`) - DAY_MS)),
    ]).catch(() => null);

    const items = new Map<string, SnapshotItem>();
    const fromBars = (symbol: string, label: string, today?: Bar, yesterday?: Bar): SnapshotItem | null => {
      if (today?.c == null) return null;
      const prev = yesterday?.c;
      const change = prev != null ? today.c - prev : null;
      return {
        symbol,
        label,
        price: round(today.c),
        changePct: change != null && prev ? round((change / prev) * 100) : null,
        change: change != null ? round(change) : null,
        currency: 'USD',
        open: today.o ?? null,
      };
    };

    for (const { symbol, label } of request.symbols) {
      if (symbol === request.indexSymbol) {
        const item = fromBars(symbol, label, last, before);
        if (item) items.set(symbol, item);
        continue;
      }
      if (symbol === 'BTC-USD') {
        const item = crypto ? fromBars(symbol, label, crypto[0].get('X:BTCUSD'), crypto[1].get('X:BTCUSD')) : null;
        if (item) items.set(symbol, item);
        continue;
      }
      const standIn = STAND_INS[symbol];
      const ticker = standIn?.ticker ?? symbol;
      if (!/^[A-Z.]{1,6}$/.test(ticker)) continue; // other indexes, futures, FX: not on the free plan
      const item = fromBars(symbol, standIn?.label ?? label, stocks.get(ticker), prevStocks.get(ticker));
      if (item) items.set(symbol, item);
    }

    // Across the whole US market: how many stocks rose/fell, and the biggest moves among liquid names.
    let up = 0;
    let down = 0;
    const movers: SnapshotItem[] = [];
    for (const [ticker, bar] of stocks) {
      const prev = prevStocks.get(ticker)?.c;
      if (bar.c == null || !prev) continue;
      if (bar.c > prev) up += 1;
      else if (bar.c < prev) down += 1;
      if (bar.c >= MIN_PRICE && bar.c * (bar.v ?? 0) >= MIN_DOLLAR_VOLUME) {
        const item = fromBars(ticker, ticker, bar, prevStocks.get(ticker));
        if (item) movers.push(item);
      }
    }
    movers.sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));

    const points: PricePoint[] = bars
      .slice(0, end)
      .filter((b) => b.t != null && b.c != null)
      .slice(-130)
      .map((b) => ({ date: isoDay(b.t ?? 0), close: round(b.c ?? 0) }));
    return {
      asOf: day,
      items,
      breadth: up + down > 0 ? { up, down } : null,
      marketMovers: movers.slice(0, 12),
      trend: points,
      source: 'Massive (end of day)',
    };
  }

  /** Nasdaq Composite daily bars for ~7 months; refreshed at most every 30 minutes. */
  private async nasdaqBars(): Promise<Bar[]> {
    if (this.index && this.now() - this.index.at < 30 * 60_000) return this.index.bars;
    const to = isoDay(this.now());
    const from = isoDay(this.now() - 214 * DAY_MS);
    const data = await this.get(`/v2/aggs/ticker/I:COMP/range/1/day/${from}/${to}?sort=asc&limit=500`);
    const bars = (data.results ?? []).filter((b) => b.c != null && b.t != null);
    this.index = { at: this.now(), bars };
    return bars;
  }

  private async groupedDay(market: 'stocks' | 'crypto', day: string): Promise<Map<string, Bar>> {
    const key = `${market}:${day}`;
    const cached = this.grouped.get(key);
    if (cached) return cached;
    const path =
      market === 'stocks'
        ? `/v2/aggs/grouped/locale/us/market/stocks/${day}?adjusted=true`
        : `/v2/aggs/grouped/locale/global/market/crypto/${day}?adjusted=true`;
    const data = await this.get(path);
    const byTicker = new Map<string, Bar>();
    for (const bar of data.results ?? []) if (bar.T) byTicker.set(bar.T, bar);
    if (byTicker.size) {
      this.grouped.set(key, byTicker);
      // Keep the 6 newest days only.
      const keys = [...this.grouped.keys()].sort((a, b) => dayOf(a).localeCompare(dayOf(b)));
      while (this.grouped.size > 6) this.grouped.delete(keys.shift() ?? '');
    }
    return byTicker;
  }

  private get(path: string): Promise<AggsResponse> {
    return this.limiter.run(async () => {
      try {
        return await this.http.getJson<AggsResponse>(`${BASE}${path}`, {
          Authorization: `Bearer ${this.options.apiKey}`,
        });
      } catch (error) {
        if (error instanceof UpstreamError && (error.status === 401 || error.status === 403)) {
          throw new UpstreamError(
            'Massive refused the request: check MASSIVE_API_KEY and its plan',
            'api.massive.com',
            error.status,
          );
        }
        throw error;
      }
    });
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
