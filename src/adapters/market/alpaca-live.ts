/**
 * Alpaca market data (free plan): live prices from the IEX exchange, 200 calls a minute. The live backup for
 * "@bot summary" when Yahoo can't be reached from the server. One summary costs 3 calls:
 *   1. stock snapshots for every symbol at once (sector ETFs, SPY/QQQ/DIA, oil/gold ETFs, the watchlist)
 *   2. a crypto snapshot (Bitcoin)
 *   3. QQQ daily bars for the 6-month trend chart (cached for an hour)
 * Real indexes, VIX, futures, yields and FX aren't on Alpaca: ETFs stand in (labelled), the rest is left out.
 * Keys go in Alpaca's headers, never in a URL.
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

const BASE = 'https://data.alpaca.markets';
const DAY_MS = 86_400_000;

interface Bar {
  t?: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}
interface Snapshot {
  latestTrade?: { p?: number; t?: string } | null;
  dailyBar?: Bar | null;
  prevDailyBar?: Bar | null;
}

/** Yahoo symbols → the Alpaca ETF that stands in for them. */
const STAND_INS: Record<string, { ticker: string; label: string }> = {
  '^IXIC': { ticker: 'QQQ', label: 'Nasdaq 100 (QQQ)' },
  '^GSPC': { ticker: 'SPY', label: 'S&P 500 (SPY)' },
  '^DJI': { ticker: 'DIA', label: 'Dow Jones (DIA)' },
  'CL=F': { ticker: 'USO', label: 'Oil (USO fund)' },
  'GC=F': { ticker: 'GLD', label: 'Gold (GLD fund)' },
};
const CRYPTO: Record<string, string> = { 'BTC-USD': 'BTC/USD' };

/** The New York calendar day of a timestamp (sessions are dated in New York time). */
const nyDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
const round = (n: number) => Math.round(n * 100) / 100;

export interface AlpacaOptions {
  keyId: string;
  secretKey: string;
  http?: HttpClient;
  now?: () => number;
  /** "iex" on the free plan (default); "sip" with a paid subscription. */
  feed?: string;
}

export class AlpacaLiveData implements BackupMarketSource {
  readonly name = 'Alpaca';
  private readonly http: HttpClient;
  private readonly now: () => number;
  private trendCache: { at: number; points: PricePoint[] } | null = null;

  constructor(private readonly options: AlpacaOptions) {
    this.http = options.http ?? new HttpClient();
    this.now = options.now ?? Date.now;
  }

  async fetchBackup(request: BackupMarketRequest): Promise<BackupMarketData> {
    const tickers = new Map<string, { symbol: string; label: string }>();
    const crypto = new Map<string, { symbol: string; label: string }>();
    for (const { symbol, label } of request.symbols) {
      if (CRYPTO[symbol]) {
        crypto.set(CRYPTO[symbol], { symbol, label });
        continue;
      }
      const standIn = STAND_INS[symbol];
      const ticker = standIn?.ticker ?? symbol;
      if (!/^[A-Z.]{1,6}$/.test(ticker)) continue; // other indexes, futures, yields, FX: not on Alpaca
      tickers.set(ticker, { symbol, label: standIn?.label ?? label });
    }

    const [stocks, coins, trend] = await Promise.all([
      this.stockSnapshots([...tickers.keys()]),
      crypto.size ? this.cryptoSnapshots([...crypto.keys()]).catch(() => ({})) : Promise.resolve({}),
      this.trend().catch(() => [] as PricePoint[]),
    ]);

    const items = new Map<string, SnapshotItem>();
    const add = (
      snaps: Record<string, Snapshot | null | undefined>,
      names: Map<string, { symbol: string; label: string }>,
    ) => {
      for (const [ticker, { symbol, label }] of names) {
        const item = toItem(symbol, label, snaps[ticker]);
        if (item) items.set(symbol, item);
      }
    };
    add(stocks, tickers);
    add(coins, crypto);
    if (!items.size) throw new Error('Alpaca: no prices returned');

    return {
      asOf: null,
      items,
      breadth: null,
      marketMovers: null,
      trend,
      trendLabel: 'Nasdaq 100 (QQQ)',
      source: `Alpaca (live, ${this.options.feed ?? 'iex'})`,
    };
  }

  private async stockSnapshots(tickers: string[]): Promise<Record<string, Snapshot | null>> {
    if (!tickers.length) return {};
    const feed = this.options.feed ?? 'iex';
    const data = await this.get<Record<string, Snapshot | null> & { snapshots?: Record<string, Snapshot | null> }>(
      `/v2/stocks/snapshots?symbols=${tickers.map(encodeURIComponent).join(',')}&feed=${feed}`,
    );
    return data.snapshots ?? data;
  }

  private async cryptoSnapshots(pairs: string[]): Promise<Record<string, Snapshot | null>> {
    const data = await this.get<{ snapshots?: Record<string, Snapshot | null> }>(
      `/v1beta3/crypto/us/snapshots?symbols=${pairs.map(encodeURIComponent).join(',')}`,
    );
    return data.snapshots ?? {};
  }

  /** QQQ daily closes for ~6 months; refreshed at most hourly (a day's close doesn't change). */
  private async trend(): Promise<PricePoint[]> {
    if (this.trendCache && this.now() - this.trendCache.at < 60 * 60_000) return this.trendCache.points;
    const start = new Date(this.now() - 190 * DAY_MS).toISOString().slice(0, 10);
    const data = await this.get<{ bars?: Record<string, Bar[] | undefined> }>(
      `/v2/stocks/bars?symbols=QQQ&timeframe=1Day&start=${start}&limit=1000&adjustment=split&feed=${this.options.feed ?? 'iex'}`,
    );
    const points = (data.bars?.QQQ ?? [])
      .filter((b) => b.t && b.c != null)
      .map((b) => ({ date: nyDay(b.t ?? ''), close: round(b.c ?? 0) }));
    this.trendCache = { at: this.now(), points };
    return points;
  }

  private async get<T>(path: string): Promise<T> {
    try {
      return await this.http.getJson<T>(`${BASE}${path}`, {
        'APCA-API-KEY-ID': this.options.keyId,
        'APCA-API-SECRET-KEY': this.options.secretKey,
      });
    } catch (error) {
      if (error instanceof UpstreamError && (error.status === 401 || error.status === 403)) {
        throw new UpstreamError(
          'Alpaca refused the request: check ALPACA_KEY_ID / ALPACA_SECRET_KEY',
          'data.alpaca.markets',
          error.status,
        );
      }
      throw error;
    }
  }
}

/**
 * Price = the latest trade. The previous close is the day before the latest trade's session: before the open
 * (latest trade from an older day than the daily bar's) it's the daily bar itself.
 */
export function toItem(symbol: string, label: string, snap: Snapshot | null | undefined): SnapshotItem | null {
  const price = snap?.latestTrade?.p ?? snap?.dailyBar?.c;
  if (price == null) return null;
  const tradeDay = snap?.latestTrade?.t ? nyDay(snap.latestTrade.t) : null;
  const barDay = snap?.dailyBar?.t ? nyDay(snap.dailyBar.t) : null;
  const sameSession = !tradeDay || !barDay || tradeDay === barDay;
  const prev = sameSession ? snap?.prevDailyBar?.c : snap?.dailyBar?.c;
  const change = prev != null ? price - prev : null;
  return {
    symbol,
    label,
    price: round(price),
    change: change != null ? round(change) : null,
    changePct: change != null && prev ? round((change / prev) * 100) : null,
    currency: 'USD',
    open: sameSession ? (snap?.dailyBar?.o ?? null) : null,
  };
}
