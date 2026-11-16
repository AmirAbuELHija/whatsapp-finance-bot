import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StockReportRenderer } from '../src/adapters/reports/stock-report-renderer.js';
import { ConversationHistory } from '../src/services/conversation/history.js';
import { CommandRouter } from '../src/services/commands/command-router.js';
import { takeMarketSnapshot, snapshotForPrompt } from '../src/services/summary/market-snapshot.js';
import { parseMarketStory } from '../src/services/summary/market-story.js';
import { MarketSummaryService, type StoryWriter } from '../src/services/summary/market-summary.js';
import type { MarketData, NewsSource, OutgoingFile } from '../src/core/types.js';
import { fakeMarket } from './helpers.js';

const PNG = [0x89, 0x50, 0x4e, 0x47];
const moves: Record<string, number> = { NVDA: -4.3, TSLA: 3.8, AAPL: 0.5, '^IXIC': -1.6, XLK: -2, XLE: 1.1 };
const points = Array.from({ length: 60 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10),
  close: 20_000 + i * 40,
}));
const market: MarketData = {
  ...fakeMarket,
  getQuote: async (s) => ({ ...(await fakeMarket.getQuote(s)), changePct: moves[s.toUpperCase()] ?? 0.2 }),
  getHistory: async (symbol, range = '6mo') => ({
    symbol,
    name: 'Nasdaq',
    currency: 'USD',
    range,
    from: points[0]!.date,
    to: points.at(-1)!.date,
    startPrice: 20_000,
    endPrice: 22_360,
    changePct: 11.8,
    high: 23_000,
    low: 20_000,
    maxDrawdownPct: 1,
    annualizedVolatilityPct: 20,
    bars: points.length,
    points,
    source: 'test',
  }),
};
const news: NewsSource = {
  getNews: async () => ({
    topic: 'Markets',
    items: [{ title: 'Chip stocks slide', source: 'Reuters', url: 'https://x.y/1', publishedAt: null }],
    source: 'test',
  }),
};
const storyJson = JSON.stringify({
  headline: 'Tech Tumble',
  accent: 'Tuesday',
  subtitle: 'Chips lead the drop',
  causes: ['AI worries', 'Rates', 'Profit taking', 'one too many'],
  effect: 'Chip index -5%',
  result: 'Nasdaq -1.6%',
  news: [{ title: 'Chip stocks slide on AI worries and more words than fit', detail: 'Investors sold.' }],
  nextUp: ['Wed · Nvidia earnings'],
});

test('market story: JSON inside chatter is clipped to its boxes; junk falls back to headlines', () => {
  const now = new Date('2026-11-17T20:00:00Z');
  const s = parseMarketStory('Sure!\n```json\n' + storyJson + '\n```', [], now, 'UTC');
  assert.equal(s.headline, 'Tech Tumble');
  assert.equal(s.causes.length, 3);
  assert.ok(s.news[0]!.title.length <= 34 && s.news[0]!.title.endsWith('…'));
  const fallback = parseMarketStory(
    'no json here',
    [{ title: 'Real headline', source: 'AP', url: '', publishedAt: null }],
    now,
    'UTC',
  );
  assert.equal(fallback.headline, 'Market Wrap');
  assert.equal(fallback.accent, 'Tuesday');
  assert.deepEqual(fallback.news, [{ title: 'Real headline', detail: 'AP' }]);
});

test('market snapshot: indexes, sectors, movers by size of move, trend and prompt text', async () => {
  const s = await takeMarketSnapshot(market, { watchlist: ['AAPL', 'NVDA', 'TSLA'] });
  assert.equal(s.indexes.length, 3);
  assert.equal(s.sectors.length, 11);
  assert.deepEqual(
    s.movers.map((m) => m.symbol),
    ['NVDA', 'TSLA', 'AAPL'],
  );
  assert.equal(s.trend?.points.length, 60);
  assert.match(snapshotForPrompt(s), /NVDA/);
});

test('summary service: two PNG slides + chat text, one AI call per 10 minutes', async () => {
  let now = 0;
  let calls = 0;
  const writer: StoryWriter = {
    writeMarketStory: async ({ items }) => (calls++, parseMarketStory(storyJson, items, new Date(), 'UTC')),
  };
  const service = new MarketSummaryService({
    market,
    news,
    writer,
    renderer: new StockReportRenderer(),
    timeZone: 'Asia/Jerusalem',
    now: () => now,
  });
  const result = await service.build('English');
  assert.equal(result.files.length, 2);
  for (const f of result.files) assert.deepEqual([...f.data.slice(0, 4)], PNG);
  assert.match(result.text, /Tech Tumble Tuesday/);
  await service.build('English');
  assert.equal(calls, 1);
  now = 11 * 60_000;
  await service.build('English');
  assert.equal(calls, 2);
});

test('slides still render when the AI gave nothing usable', () => {
  const story = parseMarketStory('', [], new Date(), 'UTC');
  const snapshot = {
    takenAt: new Date(),
    indexes: [],
    vix: null,
    sectors: [],
    movers: [],
    assets: [],
    trend: null,
  };
  const files = new StockReportRenderer().summarySlides(snapshot, story, 'UTC');
  assert.equal(files.length, 2);
});

test('/summary: slides without a topic, text with a topic, text again if the slides fail', async () => {
  let fail = false;
  const commands = new CommandRouter({
    market,
    news,
    history: new ConversationHistory(4),
    summarizer: { summarize: async ({ topic }) => `Text summary of ${topic}` },
    dashboard: {
      build: async (language) => {
        if (fail) throw new Error('boom');
        return {
          text: `Slides in ${language}`,
          files: [{ fileName: 'a.png', mimeType: 'image/png', data: new Uint8Array([1]) }],
        };
      },
    },
    timezone: 'UTC',
  });
  const files: OutgoingFile[] = [];
  assert.equal(await commands.run('/summery', { chatId: 'c', files }), 'Slides in English');
  assert.equal(files.length, 1);
  assert.equal(await commands.run('/סיכום עברית', { chatId: 'c', files: [] }), 'Slides in Hebrew');
  assert.match(await commands.run('/summary il', { chatId: 'c', files: [] }), /Text summary of/);
  fail = true;
  const none: OutgoingFile[] = [];
  assert.equal(await commands.run('/ملخص', { chatId: 'c', files: none }), 'Text summary of Global markets');
  assert.equal(none.length, 0);
});
