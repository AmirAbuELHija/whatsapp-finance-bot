import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpClient } from '../src/adapters/http/http-client.js';
import { AlpacaLiveData, toItem } from '../src/adapters/market/alpaca-live.js';
import { summaryView } from '../src/adapters/reports/summary-view.js';
import { SUMMARY } from '../src/config/reference-data.js';
import type { BackupMarketSource, MarketData } from '../src/core/types.js';
import { takeMarketSnapshot } from '../src/services/summary/market-snapshot.js';
import { parseMarketStory } from '../src/services/summary/market-story.js';
import { fakeFetch, fakeMarket, response } from './helpers.js';

const NOW = Date.parse('2026-11-23T19:30:00Z'); // 14:30 in New York, market open
const snap = (price: number, open: number, prevClose: number, tradeDay = '2026-11-23', barDay = '2026-11-23') => ({
  latestTrade: { p: price, t: `${tradeDay}T19:29:58Z` },
  dailyBar: { t: `${barDay}T05:00:00Z`, o: open, c: price },
  prevDailyBar: { t: '2026-11-20T05:00:00Z', c: prevClose },
});

function alpacaApi() {
  return fakeFetch((url) => {
    if (url.includes('/v2/stocks/snapshots')) {
      return response(200, {
        QQQ: snap(495, 500, 505),
        SPY: snap(660, 664, 666),
        DIA: snap(460, 461, 462),
        XLK: snap(270, 275, 276),
        XLP: snap(80.4, 80, 80),
        USO: snap(70, 71, 72),
        NVDA: snap(176, 181, 182),
        TSLA: snap(410, 400, 400),
      });
    }
    if (url.includes('/crypto/us/snapshots'))
      return response(200, { snapshots: { 'BTC/USD': snap(66_000, 65_000, 64_000) } });
    if (url.includes('/v2/stocks/bars')) {
      return response(200, {
        bars: { QQQ: [400, 450, 520, 505].map((c, i) => ({ t: `2026-0${6 + i}-15T04:00:00Z`, c })) },
      });
    }
    return response(404, {});
  });
}
const alpaca = (f: ReturnType<typeof fakeFetch>) =>
  new AlpacaLiveData({
    keyId: 'key-id',
    secretKey: 'secret',
    http: new HttpClient({ fetchImpl: f.fetchImpl }),
    now: () => NOW,
  });
const request = {
  symbols: [...SUMMARY.indexes, SUMMARY.vix, ...SUMMARY.sectors, ...SUMMARY.assets, { symbol: 'NVDA', label: 'NVDA' }],
  indexSymbol: '^IXIC',
};

test('Alpaca: 3 calls give live ETF stand-ins, sectors, assets, Bitcoin and the QQQ trend; keys only in headers', async () => {
  const api = alpacaApi();
  const data = await alpaca(api).fetchBackup(request);
  assert.equal(api.calls.length, 3);
  for (const c of api.calls) {
    assert.doesNotMatch(c.url, /key-id|secret/);
    const h = c.init.headers as Record<string, string>;
    assert.equal(h['APCA-API-KEY-ID'], 'key-id');
    assert.equal(h['APCA-API-SECRET-KEY'], 'secret');
  }
  assert.match(api.calls[0]!.url, /symbols=QQQ,SPY,DIA,XLK.*&feed=iex/);
  assert.doesNotMatch(api.calls[0]!.url, /VIX|TNX|CL%3DF/);
  assert.equal(data.asOf, null);
  assert.equal(data.items.get('^IXIC')?.label, 'Nasdaq 100 (QQQ)');
  assert.equal(data.items.get('^IXIC')?.changePct, -1.98);
  assert.equal(data.items.get('^IXIC')?.open, 500);
  assert.equal(data.items.get('CL=F')?.label, 'Oil (USO fund)');
  assert.equal(data.items.get('BTC-USD')?.changePct, 3.13);
  assert.equal(data.items.has('^VIX'), false);
  assert.deepEqual(
    data.trend.map((p) => p.close),
    [400, 450, 520, 505],
  );

  // The trend is cached: the next summary costs 2 calls.
  const one = alpaca(alpacaApi());
  await one.fetchBackup(request);
  const again = alpacaApi();
  Object.assign(one as unknown as { http: HttpClient }, { http: new HttpClient({ fetchImpl: again.fetchImpl }) });
  await one.fetchBackup(request);
  assert.equal(again.calls.length, 2);
});

test('Alpaca: before the open, the change is measured from the last session (not two days back)', () => {
  // Latest trade on Tuesday pre-market; daily bar still Monday's.
  const pre = toItem('SPY', 'S&P 500 (SPY)', {
    latestTrade: { p: 670, t: '2026-11-24T13:00:00Z' },
    dailyBar: { t: '2026-11-23T05:00:00Z', o: 660, c: 664 },
    prevDailyBar: { t: '2026-11-20T05:00:00Z', c: 650 },
  });
  assert.ok(pre);
  assert.equal(pre.change, 6); // vs Monday's close (the daily bar), not Friday's
  assert.equal(pre.open, null);
  assert.equal(toItem('X', 'X', { latestTrade: null, dailyBar: null }), null);
});

test('Alpaca: refused keys say what to check', async () => {
  await assert.rejects(alpaca(fakeFetch(() => response(403, {}))).fetchBackup(request), /check ALPACA_KEY_ID/);
});

test('Yahoo blocked → Alpaca live prices; Yahoo is not retried for 35 symbols; Massive is not even asked', async () => {
  const yahooCalls: string[] = [];
  const blocked: MarketData = {
    ...fakeMarket,
    getQuote: (s) => {
      yahooCalls.push(s);
      return Promise.reject(new Error('HTTP 429 from query1.finance.yahoo.com'));
    },
    getHistory: () => Promise.reject(new Error('HTTP 429')),
  };
  let massiveAsked = false;
  const massive: BackupMarketSource = {
    name: 'Massive',
    fetchBackup: () => {
      massiveAsked = true;
      return Promise.reject(new Error('should not be needed'));
    },
  };
  const snapshot = await takeMarketSnapshot(blocked, {
    backups: [alpaca(alpacaApi()), massive],
    now: () => new Date(NOW),
    watchlist: ['NVDA', 'TSLA'],
  });
  assert.equal(yahooCalls.length, 4); // the 3 indexes + VIX, then it stops
  assert.equal(massiveAsked, false);
  assert.equal(snapshot.asOf, null);
  assert.equal(snapshot.source, 'Alpaca (live, iex)');
  assert.deepEqual(
    snapshot.movers.map((m) => m.symbol),
    ['NVDA', 'TSLA'],
  );
  assert.equal(snapshot.trend?.label, 'Nasdaq 100 (QQQ)');
  const v = summaryView(snapshot, parseMarketStory('', [], new Date(NOW), 'UTC'), 'Asia/Jerusalem');
  assert.match(v.source1, /^Data: Alpaca \(live, iex\) · News: Google News · Live at 21:30 Jerusalem time/);
  assert.equal(v.slopeTitle, 'Open → now');
  assert.equal(v.moversTitle, 'Best and worst on the watchlist');
  assert.equal(v.trend?.title, 'Nasdaq 100 (QQQ) · 6 months');
  assert.equal(v.indexes[2]?.name, 'Dow Jones (DIA)'); // no "down N pts": that's the fund, not the index
});

test('Alpaca down too → Massive (last close) is next', async () => {
  const blocked: MarketData = {
    ...fakeMarket,
    getQuote: () => Promise.reject(new Error('HTTP 429')),
    getHistory: () => Promise.reject(new Error('HTTP 429')),
  };
  const items = new Map([
    ['^IXIC', { symbol: '^IXIC', label: 'Nasdaq Composite', price: 1, changePct: 1, change: 1, currency: 'USD' }],
  ]);
  const massive: BackupMarketSource = {
    name: 'Massive',
    fetchBackup: () =>
      Promise.resolve({
        asOf: '2026-11-20',
        items,
        breadth: null,
        marketMovers: [],
        trend: [],
        source: 'Massive (end of day)',
      }),
  };
  const snapshot = await takeMarketSnapshot(blocked, {
    backups: [alpaca(fakeFetch(() => response(500, {}))), massive],
  });
  assert.equal(snapshot.asOf, '2026-11-20');
});
