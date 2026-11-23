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
import { asSummaryCommand } from '../src/services/messaging/message-handler.js';
import { summaryView } from '../src/adapters/reports/summary-view.js';
import {
  BrowserSummaryRenderer,
  FallbackSummaryRenderer,
  findChromium,
  isSnapLauncher,
} from '../src/adapters/reports/browser-summary-renderer.js';
import { summaryRenderer } from '../src/app/container.js';

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

test('slides still render when the AI gave nothing usable', async () => {
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
  const files = await new StockReportRenderer().summarySlides(snapshot, story, 'UTC');
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
  assert.match(
    await commands.run('/ملخص', { chatId: 'c', files: none }),
    /Couldn't draw[\s\S]*Text summary of Global markets/,
  );
  assert.equal(none.length, 0);
});

test('"summary" without a slash: spellings, punctuation, filler and language words; real questions go to the AI', () => {
  assert.equal(asSummaryCommand('summery'), '/summary');
  assert.equal(asSummaryCommand('Summary?'), '/summary');
  assert.equal(asSummaryCommand('summary please'), '/summary');
  assert.equal(asSummaryCommand('סיכום היום בעברית'), '/summary בעברית');
  assert.equal(asSummaryCommand('ملخص اليوم'), '/summary');
  assert.equal(asSummaryCommand('summary he'), '/summary he');
  assert.equal(asSummaryCommand('summary of the fed meeting'), null);
  assert.equal(asSummaryCommand('what is a summary'), null);
});

// ── The artifact-style picture ───────────────────────────────────────────────

const it = (symbol: string, label: string, price: number, changePct: number, openPct?: number) => {
  const prev = price / (1 + changePct / 100);
  return {
    symbol,
    label,
    price,
    changePct,
    change: price - prev,
    currency: 'USD',
    open: openPct == null ? null : prev * (1 + openPct / 100),
  };
};
const fullSnapshot = {
  takenAt: new Date('2026-11-23T21:05:00Z'),
  indexes: [
    it('^IXIC', 'Nasdaq Composite', 24_509.76, -2.49, -1.3),
    it('^GSPC', 'S&P 500', 7416.59, -1.92, -0.9),
    it('^DJI', 'Dow Jones', 51_608.17, -1.41, -0.2),
  ],
  vix: it('^VIX', 'VIX', 22.9, 19),
  sectors: [it('XLK', 'Tech', 100, -3.2), it('XLP', 'Staples', 100, 0.3), it('XLE', 'Energy', 100, -2)],
  movers: [it('NVDA', 'NVDA', 182, -7.6), it('TSLA', 'TSLA', 401, 2.1), it('AMD', 'AMD', 230, -6.1)],
  assets: [
    it('CL=F', 'Oil (WTI)', 85.74, -3.2),
    it('BTC-USD', 'Bitcoin', 65_300, -0.02),
    it('^TNX', '10-yr yield', 5.12, 0.4),
  ],
  trend: { label: 'Nasdaq', points, fromHighPct: -3, high: 23_000 },
};

test('summary view: live numbers become the strings and sizes the template shows', () => {
  const story = parseMarketStory(storyJson, [], new Date(), 'UTC');
  const v = summaryView(fullSnapshot, story, 'Asia/Jerusalem');
  assert.equal(v.title, 'Tech Tumble');
  assert.match(v.sub, /Wall Street wrap · Mon, Nov 23, 2026 · Chips lead the drop/);
  assert.deepEqual(
    v.indexes.map((i) => [i.value, i.pct, i.tone]),
    [
      ['24,509.76', '−2.49%', 'down'],
      ['7,416.59', '−1.92%', 'down'],
      ['51,608.17', '−1.41%', 'down'],
    ],
  );
  assert.match(v.indexes[2]!.name, /Dow Jones · down 7\d\d pts/);
  assert.equal(v.indexes[0]!.meterW, Math.round((2.49 / 3) * 370));
  assert.equal(v.breadth?.big, '2 of 3');
  assert.equal(v.barsTitle, 'Who got hit hardest');
  assert.deepEqual(
    v.bars.map((b) => [b.name, b.pct, b.w]),
    [
      ['NVDA', '−7.6%', 180],
      ['TSLA', '+2.1%', 50],
      ['AMD', '−6.1%', 144],
    ],
  );
  assert.ok(v.slope);
  assert.equal(v.slope.closeLabels.at(0)?.text, 'Nasdaq −2.49%');
  assert.equal(v.slope.openLabels.at(2)?.text, '−0.2%');
  assert.equal(v.flow.title, 'Why it fell');
  assert.equal(v.flow.resultBold, 'Nasdaq −2.49%');
  assert.deepEqual(
    v.assets.map((a) => [a.value, a.change]),
    [
      ['$85.74', '−3.2%'],
      ['$65.3K', 'Flat'],
      ['5.12%', '+0.4%'],
    ],
  );
  assert.deepEqual(
    v.sectors.map((x) => x.name),
    ['Staples', 'Energy', 'Tech'],
  );
  assert.equal(v.sectors[2]!.negW, 105);
  assert.equal(v.trend?.points.split(' ').length, 60);
  assert.deepEqual(
    v.movers.map((m) => m.why),
    ['Up 2.1%', 'Down 7.6%', 'Down 6.1%'],
  );
  assert.match(v.source1, /Live at 23:05 Jerusalem time/);
});

test('summary view: no open prices → no open/close chart; a green day says "Why it rose"', () => {
  const green = {
    ...fullSnapshot,
    indexes: fullSnapshot.indexes.map((i) => ({ ...i, changePct: 1.2, change: 10, open: null })),
  };
  const v = summaryView(green, parseMarketStory(storyJson, [], new Date(), 'UTC'), 'UTC');
  assert.equal(v.slope, null);
  assert.equal(v.flow.title, 'Why it rose');
});

const chromium = findChromium();
test(
  'artifact picture: Chromium draws two 1920×1080 PNGs, offline',
  { skip: !chromium && 'no Chromium here' },
  async () => {
    const renderer = new BrowserSummaryRenderer({ executablePath: chromium ?? '' });
    const story = parseMarketStory(storyJson, [], new Date(), 'UTC');
    const files = await renderer.summarySlides(fullSnapshot, story, 'Asia/Jerusalem');
    assert.equal(files.length, 2);
    for (const f of files) {
      assert.deepEqual([...f.data.slice(0, 4)], PNG);
      const view = new DataView(f.data.buffer, f.data.byteOffset);
      assert.deepEqual([view.getUint32(16), view.getUint32(20)], [1920, 1080]);
    }
  },
);

test('if the browser fails, the built-in slides are sent instead', async () => {
  const warnings: string[] = [];
  const renderer = new FallbackSummaryRenderer(
    { summarySlides: () => Promise.reject(new Error('Chromium crashed')) },
    new StockReportRenderer(),
    { warn: (obj, msg) => warnings.push(`${msg}: ${JSON.stringify(obj)}`) },
  );
  const files = await renderer.summarySlides(fullSnapshot, parseMarketStory('', [], new Date(), 'UTC'), 'UTC');
  assert.equal(files.length, 2);
  assert.match(warnings[0] ?? '', /Chromium crashed/);
  const builtIn = new StockReportRenderer();
  assert.equal(summaryRenderer('off', builtIn), builtIn);
  assert.equal(summaryRenderer('/nope/chromium', builtIn), builtIn);
});

test('no index quotes at all → the error says why (so the log shows it)', async () => {
  const blocked: MarketData = {
    ...market,
    getQuote: () => Promise.reject(new Error('HTTP 429 from query1.finance.yahoo.com')),
  };
  await assert.rejects(
    takeMarketSnapshot(blocked),
    /No market data right now \(HTTP 429 from query1\.finance\.yahoo\.com ×\d+\)/,
  );
});

test("Ubuntu's Snap launcher for Chromium is skipped (it hangs headless)", async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfb-'));
  const launcher = path.join(dir, 'chromium');
  fs.writeFileSync(launcher, '#!/bin/sh\nexec /snap/bin/chromium "$@"\n');
  assert.equal(isSnapLauncher(launcher), true);
  const found = findChromium();
  if (found) assert.equal(isSnapLauncher(found), false);
});
