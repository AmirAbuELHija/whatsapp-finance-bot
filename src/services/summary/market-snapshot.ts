/** Collects the live numbers for the summary slides. Instruments that fail are left out, never invented. */
import { SUMMARY } from '../../config/reference-data.js';
import type { MarketData, MarketSnapshot, Quote, SnapshotItem } from '../../core/types.js';

/** Runs tasks with at most `limit` in flight (be gentle with free data sources). */
async function pool<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array<R | null>(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await task(items[i] as T);
      } catch {
        results[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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
  { watchlist = SUMMARY.watchlist, now = () => new Date() }: { watchlist?: readonly string[]; now?: () => Date } = {},
): Promise<MarketSnapshot> {
  const labelled = [
    ...SUMMARY.indexes,
    SUMMARY.vix,
    ...SUMMARY.sectors,
    ...SUMMARY.assets,
    ...watchlist.map((symbol) => ({ symbol, label: symbol })),
  ];
  const [quotes, trendHistory] = await Promise.all([
    pool(labelled, SUMMARY.concurrency, (l) => market.getQuote(l.symbol)),
    market.getHistory(SUMMARY.trend.symbol, SUMMARY.trend.range).catch(() => null),
  ]);
  const bySymbol = new Map<string, SnapshotItem>();
  labelled.forEach((l, i) => {
    const quote = quotes[i];
    if (quote?.price != null) bySymbol.set(l.symbol, item(quote, l.label));
  });
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

/** The numbers the AI may use, as compact text (so it can't get them wrong). */
export function snapshotForPrompt(s: MarketSnapshot): string {
  const line = (i: SnapshotItem) =>
    `${i.label} (${i.symbol}): ${i.price ?? '?'}${i.changePct == null ? '' : ` ${i.changePct >= 0 ? '+' : ''}${i.changePct}%`}`;
  return [
    `Indexes: ${s.indexes.map(line).join('; ')}`,
    s.vix ? `VIX: ${line(s.vix)}` : '',
    `Sectors: ${s.sectors.map(line).join('; ')}`,
    `Biggest moves (watchlist): ${s.movers.slice(0, 8).map(line).join('; ')}`,
    `Other assets: ${s.assets.map(line).join('; ')}`,
    s.trend?.fromHighPct != null ? `Nasdaq vs 52-week high: ${s.trend.fromHighPct}%` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
