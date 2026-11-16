import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { StockReportRenderer } from '../src/adapters/reports/stock-report-renderer.js';
import { OfficeDocumentBuilder } from '../src/adapters/documents/office-document-builder.js';
import { BaileysTransport } from '../src/adapters/whatsapp/baileys-transport.js';
import { buildToolRegistry, TOOL, type ToolContext } from '../src/services/agent/tool-registry.js';
import type { MarketData, PriceHistory } from '../src/core/types.js';
import { fakeMarket } from './helpers.js';

const PNG = [0x89, 0x50, 0x4e, 0x47];
const points = Array.from({ length: 40 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10),
  close: 100 + i + Math.sin(i) * 3,
}));
const history = (symbol: string, range = '3mo'): PriceHistory => ({
  symbol,
  name: 'Test Co',
  currency: 'USD',
  range,
  from: points[0]!.date,
  to: points.at(-1)!.date,
  startPrice: 100,
  endPrice: 139,
  changePct: 39,
  high: 142,
  low: 98,
  maxDrawdownPct: 4.2,
  annualizedVolatilityPct: 30,
  bars: points.length,
  points,
  source: 'Test data',
});
const market: MarketData = { ...fakeMarket, getHistory: async (s, r) => history(s.toUpperCase(), r) };
const renderer = new StockReportRenderer();
const tools = () =>
  buildToolRegistry({
    market,
    reports: renderer,
    documents: new OfficeDocumentBuilder(renderer),
    timezone: 'Asia/Jerusalem',
    now: () => new Date('2026-11-17T08:00:00Z'),
  });

test('report card: a PNG picture with a caption that sums up the move', async () => {
  const quote = await market.getQuote('NVDA');
  const file = await renderer.stockCard({
    quote,
    history: history('NVDA'),
    highlights: ['Earnings beat estimates', 'המדד עלה בחדות', 'ارتفع السهم بعد النتائج'],
    generatedAt: new Date(),
    timeZone: 'UTC',
  });
  assert.equal(file.mimeType, 'image/png');
  assert.deepEqual([...file.data.slice(0, 4)], PNG);
  assert.ok(file.data.byteLength > 20_000);
  assert.match(file.caption ?? '', /Test Co \$123\.45 \(\+1\.19% today, \+39\.00% 3mo\)/);
  assert.deepEqual([...renderer.chartPng({ title: 'x', points }, 600, 300).slice(0, 4)], PNG);
});

test('stock_report tool: image by default, slides with a native chart on request', async () => {
  const context: ToolContext = { files: [] };
  const image = (await tools().call(TOOL.report, { symbol: 'nvda', highlights: ['a', '', 'b'] }, context)) as {
    format: string;
  };
  assert.equal(image.format, 'image');
  assert.equal(context.files[0]!.mimeType, 'image/png');

  await tools().call(TOOL.report, { symbol: 'nvda', format: 'pptx', range: '1y' }, context);
  const zip = await JSZip.loadAsync(context.files[1]!.data);
  assert.ok(
    Object.keys(zip.files).some((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f)),
    'deck has a real chart',
  );
});

test('create_document: chart_symbol adds real price charts (native in slides, a picture in Word)', async () => {
  const context: ToolContext = { files: [] };
  const sections = [{ heading: 'NVDA trend', chart_symbol: 'NVDA', chart_range: '6mo', bullets: ['Up 39%'] }];
  await tools().call(TOOL.document, { format: 'pptx', title: 'Deck', sections }, context);
  await tools().call(TOOL.document, { format: 'docx', title: 'Doc', sections }, context);
  const deck = await JSZip.loadAsync(context.files[0]!.data);
  assert.ok(Object.keys(deck.files).some((f) => f.startsWith('ppt/charts/')));
  const doc = await JSZip.loadAsync(context.files[1]!.data);
  assert.ok(
    Object.keys(doc.files).some((f) => /^word\/media\/.+\.png$/.test(f)),
    'Word file embeds the chart',
  );
});

test('get_price_history keeps chart points out of what the AI reads', async () => {
  const result = (await tools().call(TOOL.history, { symbol: 'NVDA' })) as Record<string, unknown>;
  assert.equal(result.points, undefined);
  assert.equal(result.changePct, 39);
});

test('WhatsApp: pictures are sent as images (inline), other files as documents', async () => {
  const messages: Record<string, unknown>[] = [];
  const transport = new BaileysTransport({
    user: { id: 'me' },
    sendPresenceUpdate: async () => {},
    sendMessage: async (_jid: string, content: Record<string, unknown>) => {
      messages.push(content);
      return { key: { id: 'M1' } };
    },
  });
  await transport.sendFile('chat', {
    fileName: 'a.png',
    mimeType: 'image/png',
    data: new Uint8Array([1]),
    caption: 'c',
  });
  await transport.sendFile('chat', { fileName: 'b.pptx', mimeType: 'application/x', data: new Uint8Array([1]) });
  assert.ok('image' in messages[0]! && messages[0].caption === 'c');
  assert.ok('document' in messages[1]! && messages[1].fileName === 'b.pptx');
});
