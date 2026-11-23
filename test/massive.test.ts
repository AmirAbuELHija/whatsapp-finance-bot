import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpClient } from '../src/adapters/http/http-client.js';
import { MassiveEndOfDay, RateLimiter } from '../src/adapters/market/massive-eod.js';
import { summaryView } from '../src/adapters/reports/summary-view.js';
import { SUMMARY } from '../src/config/reference-data.js';
import type { MarketData } from '../src/core/types.js';
import { takeMarketSnapshot } from '../src/services/summary/market-snapshot.js';
import { parseMarketStory } from '../src/services/summary/market-story.js';
import { fakeFetch, fakeMarket, response } from './helpers.js';

const NOW = Date.parse('2026-11-23T20:00:00Z');
const ms = (day: string) => Date.parse(`${day}T05:00:00Z`);
const DAYS = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'];

function massiveApi({ newestReady = true } = {}) {
  const stocks = (day: string) => {
    const k = DAYS.indexOf(day);
    if (k === 3 && !newestReady) return [];
    const f = 1 + k / 100; // every day 1% higher
    return [
      { T: 'SPY', o: 600 * f, c: 610 * f, v: 1e8 },
      { T: 'DIA', o: 440 * f, c: 445 * f, v: 1e7 },
      { T: 'XLK', o: 250 * f, c: 255 * f, v: 1e7 },
      { T: 'USO', o: 70, c: k === 3 ? 66.5 : 70, v: 1e6 },
      { T: 'NVDA', o: 180, c: k === 3 ? 171 : 180, v: 3e8 },
      { T: 'TINY', o: 1, c: k === 3 ? 3 : 1, v: 1e6 },
    ];
  };
  return fakeFetch((url) => {
    if (url.includes('/I:COMP/')) {
      return response(200, {
        results: DAYS.map((d, i) => ({ t: ms(d), o: 20_000 + i * 100, c: 20_050 + i * 100 })),
      });
    }
    const day = /\/(\d{4}-\d{2}-\d{2})\?/.exec(url)?.[1] ?? '';
    if (url.includes('/market/crypto/')) {
      return response(200, { results: [{ T: 'X:BTCUSD', c: day === '2026-11-21' ? 66_000 : 60_000 }] });
    }
    return response(200, { results: stocks(day), resultsCount: stocks(day).length });
  });
}

const source = (f: ReturnType<typeof fakeFetch>) => {
  let clock = NOW;
  return new MassiveEndOfDay({
    apiKey: 'secret-key',
    http: new HttpClient({ fetchImpl: f.fetchImpl }),
    // A fake clock: waiting for the rate limit just moves time forward.
    limiter: new RateLimiter(
      5,
      60_000,
      () => clock,
      async (wait) => {
        clock += wait;
      },
    ),
    now: () => NOW,
  });
};

const request = {
  symbols: [...SUMMARY.indexes, ...SUMMARY.sectors, ...SUMMARY.assets, { symbol: 'NVDA', label: 'NVDA' }],
  indexSymbol: '^IXIC',
};

test('Massive: 5 calls give indexes (SPY/DIA stand-ins), sectors, assets, breadth and market movers; key only in a header', async () => {
  const api = massiveApi();
  const eod = await source(api).fetchBackup(request);
  assert.equal(api.calls.length, 5);
  for (const c of api.calls) {
    assert.doesNotMatch(c.url, /secret-key|apiKey/);
    assert.equal((c.init.headers as Record<string, string>).Authorization, 'Bearer secret-key');
  }
  assert.equal(eod.asOf, '2026-11-21');
  assert.equal(eod.items.get('^IXIC')?.price, 20_350);
  assert.equal(eod.items.get('^GSPC')?.label, 'S&P 500 (SPY)');
  assert.equal(eod.items.get('^GSPC')?.changePct, 0.98);
  assert.equal(eod.items.get('CL=F')?.changePct, -5);
  assert.equal(eod.items.get('BTC-USD')?.changePct, 10);
  assert.equal(eod.items.has('^VIX'), false);
  assert.deepEqual(eod.breadth, { up: 4, down: 2 });
  const movers = eod.marketMovers ?? [];
  assert.equal(movers[0]?.symbol, 'NVDA');
  assert.ok(!movers.some((m) => m.symbol === 'TINY' || m.symbol === 'USO')); // too small to count
  assert.equal(eod.trend.length, 4);

  // Closed days are cached: asking again costs nothing.
  const repeat = massiveApi();
  const one = source(repeat);
  await one.fetchBackup(request);
  await one.fetchBackup(request);
  assert.equal(repeat.calls.length, 5);
});

test("Massive: the newest day's file not ready yet → uses the day before", async () => {
  const eod = await source(massiveApi({ newestReady: false })).fetchBackup(request);
  assert.equal(eod.asOf, '2026-11-20');
  assert.equal(eod.trend.at(-1)?.date, '2026-11-20');
});

test('Massive: a refused key says what to check', async () => {
  const api = fakeFetch(() => response(403, { status: 'NOT_AUTHORIZED' }));
  await assert.rejects(source(api).fetchBackup(request), /check MASSIVE_API_KEY/);
});

test('rate limiter: the 6th call in a minute waits for the window', async () => {
  let now = 0;
  const waits: number[] = [];
  const limiter = new RateLimiter(
    5,
    60_000,
    () => now,
    async (ms) => {
      waits.push(ms);
      now += ms;
    },
  );
  for (let i = 0; i < 6; i++) await limiter.run(async () => i);
  assert.equal(waits.length, 1);
  assert.ok(now >= 60_000);
});

test('Yahoo blocked → the summary uses the last close from Massive, clearly labelled', async () => {
  const blocked: MarketData = {
    ...fakeMarket,
    getQuote: () => Promise.reject(new Error('HTTP 429 from query1.finance.yahoo.com')),
    getHistory: () => Promise.reject(new Error('HTTP 429')),
  };
  const snapshot = await takeMarketSnapshot(blocked, {
    backups: [source(massiveApi())],
    now: () => new Date(NOW),
  });
  assert.equal(snapshot.asOf, '2026-11-21');
  assert.equal(snapshot.moversScope, 'market');
  assert.deepEqual(
    snapshot.indexes.map((i) => i.label),
    ['Nasdaq Composite', 'S&P 500 (SPY)', 'Dow Jones (DIA)'],
  );
  const v = summaryView(snapshot, parseMarketStory('', [], new Date(NOW), 'UTC'), 'Asia/Jerusalem');
  assert.match(v.sub, /^Wall Street close · Sat, Nov 21, 2026/);
  assert.match(v.source1, /Massive \(end of day\).*Close of Sat, Nov 21, 2026/);
  assert.equal(v.breadth?.caption, 'of US stocks rose: 4 up, 2 down');
  assert.equal(v.slopeTitle, 'Open → close');
  assert.equal(v.moversTitle, 'Best and worst across US stocks');
  assert.equal(v.indexes[2]?.name, 'Dow Jones (DIA)');
});
