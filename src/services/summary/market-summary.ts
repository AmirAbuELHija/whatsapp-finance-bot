/**
 * "@bot summary": live market numbers + the latest headlines → one AI call for the words → two dashboard slides.
 * Cached briefly so a busy group asking at once costs one AI call.
 */
import { CACHE_TTL_MS, LIMITS } from '../../config/constants.js';
import { TtlCache } from '../../core/cache/ttl-cache.js';
import type {
  MarketData,
  MarketSnapshot,
  MarketStory,
  NewsItem,
  NewsSource,
  OutgoingFile,
  SummaryRenderer,
} from '../../core/types.js';
import { snapshotForPrompt, takeMarketSnapshot } from './market-snapshot.js';

export interface StoryWriter {
  writeMarketStory(input: { numbers: string; items: readonly NewsItem[]; language: string }): Promise<MarketStory>;
}

export interface MarketSummaryResult {
  text: string;
  files: OutgoingFile[];
}

export interface MarketSummaryOptions {
  market: MarketData;
  news: NewsSource;
  writer: StoryWriter;
  renderer: SummaryRenderer;
  timeZone: string;
  now?: () => number;
}

export class MarketSummaryService {
  private readonly cache: TtlCache<MarketSummaryResult>;

  constructor(private readonly options: MarketSummaryOptions) {
    this.cache = new TtlCache(CACHE_TTL_MS.summary, LIMITS.summaryCacheEntries, options.now);
  }

  async build(language: string): Promise<MarketSummaryResult> {
    const cached = this.cache.get(language);
    if (cached) return cached;
    const { market, news, writer, renderer, timeZone, now = Date.now } = this.options;

    const [snapshot, headlines] = await Promise.all([
      takeMarketSnapshot(market, { now: () => new Date(now()) }),
      news.getNews('', { limit: LIMITS.summaryHeadlines }).catch(() => ({ topic: '', items: [] as NewsItem[] })),
    ]);
    if (!snapshot.indexes.length) throw new Error('No market data right now');

    const story = await writer.writeMarketStory({
      numbers: snapshotForPrompt(snapshot),
      items: headlines.items,
      language,
    });
    const result = {
      text: summaryText(snapshot, story),
      files: await renderer.summarySlides(snapshot, story, timeZone),
    };
    this.cache.set(language, result);
    return result;
  }
}

/** The short chat message that goes with the slides. */
export function summaryText(snapshot: MarketSnapshot, story: MarketStory): string {
  const indexes = snapshot.indexes
    .map((i) => `${i.label} ${i.changePct == null ? '' : `${i.changePct >= 0 ? '+' : ''}${i.changePct.toFixed(2)}%`}`)
    .join(' · ');
  return [
    `📊 *${story.headline} ${story.accent}*`.replace(/\s+\*$/, '*'),
    story.subtitle,
    indexes,
    story.result ? `➡️ ${story.result}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
