import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { OfficeDocumentBuilder } from '../src/adapters/documents/office-document-builder.js';
import { fileNameFor, isRtl, normalizeSpec } from '../src/adapters/documents/document-text.js';
import { DOCUMENTS } from '../src/config/constants.js';
import { buildToolRegistry, TOOL, type ToolContext } from '../src/services/agent/tool-registry.js';
import type { DocumentSpec } from '../src/core/types.js';
import { fakeMarket } from './helpers.js';

const spec = (format: 'docx' | 'pptx', extra: Partial<DocumentSpec> = {}): DocumentSpec => ({
  format,
  title: 'Nasdaq weekly review',
  subtitle: 'Week 46',
  sections: [
    { heading: 'Summary', paragraphs: ['Tech led the market higher.'], bullets: ['NVDA +4%', 'AAPL +1%'] },
    {
      heading: 'Prices',
      table: {
        headers: ['Symbol', 'Price'],
        rows: [
          ['NVDA', '190'],
          ['AAPL', '230'],
        ],
      },
    },
  ],
  ...extra,
});

const unzip = async (data: Uint8Array) => JSZip.loadAsync(data);

test('docx: a real Word file with title, headings, bullets and a table', async () => {
  const file = await new OfficeDocumentBuilder().build(spec('docx'));
  assert.equal(file.fileName, 'Nasdaq-weekly-review.docx');
  assert.equal(file.mimeType, DOCUMENTS.mimeTypes.docx);
  const xml = await (await unzip(file.data)).file('word/document.xml')!.async('string');
  for (const text of ['Nasdaq weekly review', 'Summary', 'Tech led the market higher.', 'NVDA +4%', 'AAPL', '230'])
    assert.ok(xml.includes(text), `missing ${text}`);
  assert.ok(xml.includes('<w:tbl>'), 'has a table');
});

test('pptx: title slide plus one slide per section; long sections continue on the next slide', async () => {
  const bullets = Array.from({ length: DOCUMENTS.bulletsPerSlide + 3 }, (_, i) => `Point ${i + 1}`);
  const file = await new OfficeDocumentBuilder().build(
    spec('pptx', {
      sections: [
        { heading: 'Drivers', bullets },
        { heading: 'Outlook', bullets: ['Rates'] },
      ],
    }),
  );
  assert.equal(file.mimeType, DOCUMENTS.mimeTypes.pptx);
  const zip = await unzip(file.data);
  const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  assert.equal(slides.length, 4); // cover + Drivers + Drivers (cont.) + Outlook
  const all = (await Promise.all(slides.map((s) => zip.file(s)!.async('string')))).join('');
  assert.ok(all.includes('Drivers (cont.)') && all.includes('Point 10') && all.includes('Outlook'));
});

test('Hebrew and Arabic are laid out right to left', async () => {
  assert.equal(isRtl('סיכום שבועי'), true);
  assert.equal(isRtl('ملخص السوق'), true);
  assert.equal(isRtl('Weekly summary'), false);
  const file = await new OfficeDocumentBuilder().build({
    format: 'docx',
    title: 'סיכום שבועי',
    sections: [{ heading: 'שוק', bullets: ['המדד עלה'] }],
  });
  const xml = await (await unzip(file.data)).file('word/document.xml')!.async('string');
  assert.ok(xml.includes('<w:bidi/>') && xml.includes('<w:rtl/>'));
  assert.equal(file.fileName, 'סיכום-שבועי.docx');
});

test('whatever the AI sends is bounded and cleaned; empty documents are refused', async () => {
  const messy = normalizeSpec({
    format: 'docx',
    title: '  ',
    sections: [
      ...Array.from({ length: DOCUMENTS.maxSections + 5 }, (_, i) => ({ heading: `S${i}`, bullets: ['x'] })),
      { heading: '' },
    ],
  });
  assert.equal(messy.title, 'Document');
  assert.equal(messy.sections.length, DOCUMENTS.maxSections);
  assert.equal(fileNameFor('Q3: Results / 2026!', 'pptx'), 'Q3-Results-2026.pptx');
  await assert.rejects(new OfficeDocumentBuilder().build({ format: 'pptx', title: 'x', sections: [] }), /no content/);
});

test('create_document tool: puts the file in the request outbox and tells the AI it will be sent', async () => {
  const tools = buildToolRegistry({ market: fakeMarket, documents: new OfficeDocumentBuilder() });
  assert.ok(tools.names.includes(TOOL.document));
  const context: ToolContext = { files: [] };
  const result = (await tools.call(TOOL.document, { ...spec('pptx'), format: 'pptx' }, context)) as { created: string };
  assert.equal(result.created, 'Nasdaq-weekly-review.pptx');
  assert.equal(context.files.length, 1);
  // Without a document builder the tool is not offered at all.
  assert.ok(!buildToolRegistry({ market: fakeMarket }).names.includes(TOOL.document));
});
