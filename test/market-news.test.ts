import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpClient } from '../src/adapters/http/http-client.js';
import { normalizeSymbol } from '../src/adapters/market/symbols.js';
import { YahooMarketData } from '../src/adapters/market/yahoo-market.js';
import { NewsService } from '../src/adapters/news/news-service.js';
import { parseRss } from '../src/adapters/news/rss.js';
import { UserInputError } from '../src/core/errors.js';
import { formatNews } from '../src/services/commands/formatters.js';
import { fakeFetch, response } from './helpers.js';

const day = (iso: string) => Date.parse(`${iso}T14:30:00Z`) / 1000;
const market = (route: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(route);
  return {
    market: new YahooMarketData(new HttpClient({ fetchImpl: f.fetchImpl, cacheTtlMs: 60_000 }), async () => {}),
    calls: f.calls,
  };
};
const chart = (result: unknown) => response(200, { chart: { result: [result] } });

test('normalizeSymbol: aliases, FX and crypto pairs, validation', () => {
  assert.equal(normalizeSymbol('aapl'), 'AAPL');
  assert.equal(normalizeSymbol('btc'), 'BTC-USD');
  assert.equal(normalizeSymbol('USD/ILS'), 'USDILS=X');
  assert.equal(normalizeSymbol('eurusd'), 'EURUSD=X');
  assert.equal(normalizeSymbol('BTC/EUR'), 'BTC-EUR');
  assert.equal(normalizeSymbol('teva.ta'), 'TEVA.TA');
  assert.equal(normalizeSymbol('s&p500'), '^GSPC');
  assert.throws(() => normalizeSymbol(''), /required/);
  assert.throws(() => normalizeSymbol('<script>'), /ticker/);
});

test('quote: previous close from the prior daily bar during the session', async () => {
  const { market: m } = market(() =>
    chart({
      meta: {
        currency: 'USD',
        longName: 'Apple Inc.',
        regularMarketPrice: 110,
        regularMarketTime: day('2026-11-11'),
        exchangeTimezoneName: 'America/New_York',
        chartPreviousClose: 90,
      },
      timestamp: [day('2026-11-09'), day('2026-11-10'), day('2026-11-11')],
      indicators: { quote: [{ close: [95, 100, 110] }] },
    }),
  );
  const q = await m.getQuote('aapl');
  assert.equal(q.price, 110);
  assert.equal(q.previousClose, 100);
  assert.equal(q.change, 10);
  assert.equal(q.changePct, 10);
  assert.equal(q.name, 'Apple Inc.');
});

test('quote: Tel Aviv prices in agorot are converted to shekels', async () => {
  const { market: m } = market(() =>
    chart({
      meta: { currency: 'ILA', regularMarketPrice: 6500, previousClose: 6400, regularMarketTime: day('2026-11-11') },
      timestamp: [],
      indicators: { quote: [{ close: [] }] },
    }),
  );
  const q = await m.getQuote('TEVA.TA');
  assert.equal(q.currency, 'ILS');
  assert.equal(q.price, 65);
  assert.equal(q.change, 1);
});

test('quote: unknown symbol → helpful UserInputError; responses are cached', async () => {
  const { market: unknown } = market(() => response(404, { chart: { result: null } }));
  await assert.rejects(
    unknown.getQuote('NOPE'),
    (e) => e instanceof UserInputError && /Unknown symbol NOPE/.test(e.message),
  );

  const { market: m, calls } = market(() => chart({ meta: { currency: 'USD', regularMarketPrice: 1 } }));
  await m.getQuote('MSFT');
  await m.getQuote('MSFT');
  assert.equal(calls.length, 1);
});

test('history: change, drawdown, volatility, range validation', async () => {
  const closes = [100, 120, 90, 95, 100, 105, 110, 108, 112, 115, 130];
  const { market: m, calls } = market(() =>
    chart({
      meta: { currency: 'USD', regularMarketPrice: 130 },
      timestamp: closes.map((_, i) => day(`2026-10-${String(10 + i)}`)),
      indicators: { quote: [{ close: closes }] },
    }),
  );
  const h = await m.getHistory('NVDA', '1mo');
  assert.equal(h.changePct, 30);
  assert.equal(h.high, 130);
  assert.equal(h.low, 90);
  assert.equal(h.maxDrawdownPct, -25);
  assert.ok(h.annualizedVolatilityPct! > 0);
  assert.ok(calls[0]!.url.includes('range=1mo&interval=1d'));
  await assert.rejects(m.getHistory('NVDA', '7days'), /range must be one of/);
});

test('convert: ECB first, Yahoo fallback, crypto via Yahoo', async () => {
  const { market: m } = market((url) => {
    if (url.includes('base=USD&symbols=ILS')) return response(200, { date: '2026-11-11', rates: { ILS: 3.7 } });
    if (url.includes('base=USD&symbols=EGP')) return response(404, { message: 'not found' });
    if (url.includes('USDEGP%3DX'))
      return chart({ meta: { currency: 'EGP', regularMarketPrice: 50, regularMarketTime: day('2026-11-11') } });
    if (url.includes('BTC-ILS'))
      return chart({ meta: { currency: 'ILS', regularMarketPrice: 300000, regularMarketTime: day('2026-11-11') } });
    return response(404, {});
  });
  const a = await m.convertCurrency(100, 'usd', 'ils');
  assert.equal(a.result, 370);
  assert.match(a.source!, /ECB/);
  assert.equal((await m.convertCurrency(2, 'USD', 'EGP')).result, 100);
  assert.equal((await m.convertCurrency(0.5, 'BTC', 'ILS')).result, 150000);
  assert.equal((await m.convertCurrency(5, 'EUR', 'eur')).result, 5);
});

// ── News (shapes copied from real responses, Nov 2026) ───────────────────────

const rssItem = (title: string, source: string, date: string) =>
  `<item><title>${title} - ${source}</title><link>https://news.google.com/rss/articles/CBMabc?oc=5</link>` +
  `<pubDate>${date}</pubDate><description>&lt;a href="x"&gt;${title}&lt;/a&gt;</description><source url="https://example.com">${source}</source></item>`;
const rss = (items: string[]) => `<?xml version="1.0"?><rss><channel>${items.join('')}</channel></rss>`;
const googleEn = rss([
  rssItem('Older story &amp; more', 'Reuters', 'Thu, 12 Nov 2026 09:06:00 GMT'),
  rssItem('Anthropic’s IPO won’t dramatically alter the market', 'Morningstar', 'Thu, 12 Nov 2026 11:12:26 GMT'),
]);
const googleHe = rss([rssItem('מדדי הטכנולוגיה והבנקים מובילים בעליות', 'ביזפורטל', 'Thu, 12 Nov 2026 04:13:00 GMT')]);
const yahooNews = {
  news: [
    {
      title: 'Nvidia hires a firm to find a successor',
      publisher: '24/7 Wall St.',
      link: 'https://finance.yahoo.com/a1',
      providerPublishTime: 1794485844,
      relatedTickers: ['NVDA'],
    },
    {
      title: 'Apple vs. Alphabet',
      publisher: '24/7 Wall St.',
      link: 'https://finance.yahoo.com/a2',
      providerPublishTime: 1794485746,
      relatedTickers: ['AAPL'],
    },
    {
      title: 'Microsoft at $521',
      publisher: 'Trefis',
      link: 'https://finance.yahoo.com/a3',
      providerPublishTime: 1794484941,
      relatedTickers: ['MSFT', 'AAPL'],
    },
  ],
};
const newsService = (route: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(route);
  return { news: new NewsService(new HttpClient({ fetchImpl: f.fetchImpl, cacheTtlMs: 60_000 })), calls: f.calls };
};

test('parseRss strips " - Publisher" and decodes entities', () => {
  const items = parseRss(googleEn);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.title, 'Older story & more');
  assert.equal(items[0]!.source, 'Reuters');
  assert.equal(items[0]!.publishedAt, '2026-11-12T09:06:00.000Z');
});

test('ticker news from Yahoo, tagged stories first; Google fallback when Yahoo fails', async () => {
  const { news, calls } = newsService(() => response(200, yahooNews));
  const r = await news.getNews('aapl', { limit: 3 });
  assert.equal(r.source, 'Yahoo Finance');
  assert.deepEqual(
    r.items.map((i) => i.title.slice(0, 5)),
    ['Apple', 'Micro', 'Nvidi'],
  );
  assert.ok(calls[0]!.url.includes('v1/finance/search?q=AAPL'));

  const fallback = newsService((url) => (url.includes('yahoo') ? response(429, {}) : response(200, googleEn)));
  const g = await fallback.news.getNews('TEVA.TA');
  assert.equal(g.source, 'Google News');
  assert.ok(decodeURIComponent(fallback.calls[1]!.url).includes('q=TEVA stock when:3d'));
});

test('market preset is newest first; "il" uses the Hebrew edition; Hebrew topics search in Hebrew', async () => {
  const { news, calls } = newsService((url) => response(200, url.includes('hl=he') ? googleHe : googleEn));
  assert.equal((await news.getNews('')).items[0]!.source, 'Morningstar');
  assert.equal((await news.getNews('il')).items[0]!.source, 'ביזפורטל');
  await news.getNews('ריבית בנק ישראל');
  await news.getNews('ריבית בנק ישראל'); // cached
  assert.equal(calls.length, 3);
  assert.ok(decodeURIComponent(calls[2]!.url).includes('q=ריבית בנק ישראל when:3d'));
});

test('formatNews renders a WhatsApp list', () => {
  const out = formatNews(
    {
      topic: 'AAPL',
      source: 'Yahoo Finance',
      items: [{ title: 'Apple up', source: 'Reuters', url: 'https://x.y/1', publishedAt: '2026-11-12T10:00:00Z' }],
    },
    Date.parse('2026-11-12T12:30:00Z'),
  );
  assert.equal(out, '📰 *AAPL*\n\n1. *Apple up*\n_Reuters · 3h ago_\nhttps://x.y/1\n\n_via Yahoo Finance_');
  assert.match(formatNews({ topic: 'XYZ', source: 'Google News', items: [] }), /No recent news/);
});

test('quote: Yahoo rate limit (429) → waits and retries on the other host; 404 is never retried', async () => {
  let n = 0;
  const { market: m, calls } = market(() => {
    n += 1;
    if (n === 1) return response(429, 'Too Many Requests');
    return chart({
      meta: { currency: 'USD', regularMarketPrice: 5, previousClose: 4 },
      indicators: { quote: [{ open: [4.5] }] },
    });
  });
  const q = await m.getQuote('^IXIC');
  assert.equal(q.price, 5);
  assert.equal(q.open, 4.5);
  assert.match(calls[0]!.url, /query1\.finance/);
  assert.match(calls[1]!.url, /query2\.finance/);

  const { market: m404, calls: c404 } = market(() => response(404, {}));
  await assert.rejects(m404.getQuote('NOPE'), UserInputError);
  assert.equal(c404.length, 1);

  const { market: blocked, calls: cBlocked } = market(() => response(429, 'Too Many Requests'));
  await assert.rejects(blocked.getQuote('AAPL'), /HTTP 429 from query1\.finance\.yahoo\.com/);
  assert.equal(cBlocked.length, 3);
});
