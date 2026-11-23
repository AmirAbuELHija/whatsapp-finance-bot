/** Collects the live numbers for the summary slides. Instruments that fail are left out, never invented. */
import { SUMMARY } from '../../config/reference-data.js';
import type {
  BackupMarketData,
  BackupMarketSource,
  MarketData,
  MarketSnapshot,
  Quote,
  SnapshotItem,
} from '../../core/types.js';

/** Runs tasks with at most `limit` in flight (be gentle with free data sources). */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<{ results: (R | null)[]; errors: string[] }> {
  const results: (R | null)[] = new Array<R | null>(items.length).fill(null);
  const errors: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await task(items[i] as T);
      } catch (error) {
        results[i] = null;
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return { results, errors };
}

/** Thrown when not even the indexes could be fetched; says why (e.g. "HTTP 429 from query1.finance.yahoo.com"). */
export class NoMarketDataError extends Error {
  constructor(readonly reasons: string[]) {
    const counts = new Map<string, number>();
    for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2);
    super(`No market data right now${top.length ? ` (${top.map(([r, n]) => `${r} ×${n}`).join('; ')})` : ''}`);
    this.name = 'NoMarketDataError';
  }
}

const item = (quote: Quote, label: string): SnapshotItem => ({
  symbol: quote.symbol,
  label,
  price: quote.price,
  changePct: quote.changePct,
  change: quote.change,
  currency: quote.currency,
  open: quote.open ?? null,
});

export async function takeMarketSnapshot(
  market: MarketData,
  {
    watchlist = SUMMARY.watchlist,
    now = () => new Date(),
    backups = [],
  }: { watchlist?: readonly string[]; now?: () => Date; backups?: readonly BackupMarketSource[] } = {},
): Promise<MarketSnapshot> {
  const first = [...SUMMARY.indexes, SUMMARY.vix];
  const rest = [...SUMMARY.sectors, ...SUMMARY.assets, ...watchlist.map((symbol) => ({ symbol, label: symbol }))];
  const labelled = [...first, ...rest];
  // Indexes first: if Yahoo can't give even those, it's blocked, so don't spend ~20 s retrying 35 more symbols.
  const [head, trendHistory] = await Promise.all([
    pool(first, SUMMARY.concurrency, (l) => market.getQuote(l.symbol)),
    market.getHistory(SUMMARY.trend.symbol, SUMMARY.trend.range).catch(() => null),
  ]);
  const yahooUp = head.results.slice(0, SUMMARY.indexes.length).some((q) => q?.price != null);
  const tail = yahooUp
    ? await pool(rest, SUMMARY.concurrency, (l) => market.getQuote(l.symbol))
    : { results: rest.map(() => null), errors: [] as string[] };
  const quotes = [...head.results, ...tail.results];
  const errors = [...head.errors, ...tail.errors];
  const bySymbol = new Map<string, SnapshotItem>();
  labelled.forEach((l, i) => {
    const quote = quotes[i];
    if (quote?.price != null) bySymbol.set(l.symbol, item(quote, l.label));
  });
  // Live quotes mostly failed (Yahoo blocks some cloud servers): try the backups in order.
  const liveIndexes = SUMMARY.indexes.filter((l) => bySymbol.has(l.symbol)).length;
  const liveSectors = SUMMARY.sectors.filter((l) => bySymbol.has(l.symbol)).length;
  if (liveIndexes < SUMMARY.indexes.length || liveSectors < SUMMARY.sectors.length / 2) {
    for (const backup of backups) {
      try {
        const data = await backup.fetchBackup({ symbols: labelled, indexSymbol: SUMMARY.trend.symbol });
        if (SUMMARY.indexes.some((l) => data.items.has(l.symbol))) return fromBackup(data, watchlist, now());
        errors.push(`${backup.name}: no index data`);
      } catch (error) {
        errors.push(`${backup.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (!liveIndexes) throw new NoMarketDataError(errors);
  const pick = (list: readonly { symbol: string }[]) =>
    list.map((l) => bySymbol.get(l.symbol)).filter((x): x is SnapshotItem => x !== undefined);

  const trendQuote = bySymbol.get(SUMMARY.trend.symbol);
  const trendIndex = SUMMARY.indexes.findIndex((l) => l.symbol === SUMMARY.trend.symbol);
  const trendFull = trendIndex >= 0 ? quotes[trendIndex] : null;
  const high = trendFull?.fiftyTwoWeekHigh ?? trendHistory?.high ?? null;
  return {
    takenAt: now(),
    indexes: pick(SUMMARY.indexes),
    vix: bySymbol.get(SUMMARY.vix.symbol) ?? null,
    sectors: pick(SUMMARY.sectors),
    assets: pick(SUMMARY.assets),
    movers: pick(watchlist.map((symbol) => ({ symbol })))
      .filter((m) => m.changePct != null)
      .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0)),
    trend: trendHistory?.points?.length
      ? {
          label: SUMMARY.trend.label,
          points: trendHistory.points,
          high,
          fromHighPct:
            high && trendQuote?.price != null ? Math.round((trendQuote.price / high - 1) * 10_000) / 100 : null,
        }
      : null,
  };
}

/** A snapshot built from a backup source (live ETFs, or a previous close). */
function fromBackup(data: BackupMarketData, watchlist: readonly string[], takenAt: Date): MarketSnapshot {
  const pick = (list: readonly { symbol: string }[]) =>
    list.map((l) => data.items.get(l.symbol)).filter((x): x is SnapshotItem => x !== undefined);
  const closes = data.trend.map((p) => p.close);
  const high = closes.length ? Math.max(...closes) : null;
  const last = closes.at(-1);
  const watchlistMovers = pick(watchlist.map((symbol) => ({ symbol })))
    .filter((m) => m.changePct != null)
    .sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0));
  return {
    takenAt,
    asOf: data.asOf,
    source: data.source,
    breadth: data.breadth,
    moversScope: data.marketMovers ? 'market' : 'watchlist',
    indexes: pick(SUMMARY.indexes),
    vix: data.items.get(SUMMARY.vix.symbol) ?? null,
    sectors: pick(SUMMARY.sectors),
    assets: pick(SUMMARY.assets),
    movers: data.marketMovers ?? watchlistMovers,
    trend: data.trend.length
      ? {
          label: data.trendLabel ?? SUMMARY.trend.label,
          points: data.trend,
          high,
          fromHighPct: high && last != null ? Math.round((last / high - 1) * 10_000) / 100 : null,
        }
      : null,
  };
}

/** The numbers the AI may use, as compact text (so it can't get them wrong). */
export function snapshotForPrompt(s: MarketSnapshot): string {
  const line = (i: SnapshotItem) =>
    `${i.label} (${i.symbol}): ${i.price ?? '?'}${i.changePct == null ? '' : ` ${i.changePct >= 0 ? '+' : ''}${i.changePct}%`}`;
  return [
    s.asOf
      ? `IMPORTANT: these are closing numbers from ${s.asOf} (live data was unavailable). Say "at the close".`
      : '',
    s.breadth ? `US stocks that day: ${s.breadth.up} rose, ${s.breadth.down} fell` : '',
    `Indexes: ${s.indexes.map(line).join('; ')}`,
    s.vix ? `VIX: ${line(s.vix)}` : '',
    `Sectors: ${s.sectors.map(line).join('; ')}`,
    `Biggest moves (${s.moversScope === 'market' ? 'liquid US stocks' : 'watchlist'}): ${s.movers.slice(0, 8).map(line).join('; ')}`,
    `Other assets: ${s.assets.map(line).join('; ')}`,
    s.trend?.fromHighPct != null ? `Nasdaq vs 52-week high: ${s.trend.fromHighPct}%` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
