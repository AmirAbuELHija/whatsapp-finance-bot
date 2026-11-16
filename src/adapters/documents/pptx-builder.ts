/** PowerPoint (.pptx) decks from a DocumentSpec: a title slide, then one slide per section (long sections continue). */
import pptxgenModule from 'pptxgenjs';
import { DOCUMENTS } from '../../config/constants.js';
import type { DocumentSection, DocumentSpec, OutgoingFile } from '../../core/types.js';
import { fileNameFor, isRtl } from './document-text.js';

// pptxgenjs is CommonJS with an ES-style default export in its types: at runtime the import is the class itself.
type PptxCtor = typeof pptxgenModule.default;
const PptxGenJS =
  (pptxgenModule as unknown as { default?: PptxCtor }).default ?? (pptxgenModule as unknown as PptxCtor);

const THEME = {
  accent: '1F6FEB',
  dark: '1F2328',
  muted: '59636E',
  up: '1A7F37',
  down: 'CF222E',
  font: 'Arial',
} as const;
const W = 13.33; // LAYOUT_WIDE, inches

const align = (value: string): 'left' | 'right' => (isRtl(value) ? 'right' : 'left');

/** Splits long sections so no slide gets more than a readable number of lines. */
function slidesFor(section: DocumentSection): DocumentSection[] {
  const lines = [...(section.paragraphs ?? []), ...(section.bullets ?? [])];
  // A chart slide keeps a few points under the chart; the rest continue on the next slide.
  if (section.chart) {
    const keep = DOCUMENTS.bulletsUnderChart;
    const rest = lines.slice(keep);
    return [
      { heading: section.heading, chart: section.chart, bullets: lines.slice(0, keep) },
      ...(rest.length || section.table
        ? slidesFor({
            heading: `${section.heading} (cont.)`,
            bullets: rest,
            ...(section.table ? { table: section.table } : {}),
          })
        : []),
    ];
  }
  if (lines.length <= DOCUMENTS.bulletsPerSlide) return [section];
  const pages: DocumentSection[] = [];
  for (let i = 0; i < lines.length; i += DOCUMENTS.bulletsPerSlide) {
    pages.push({
      heading: i ? `${section.heading} (cont.)` : section.heading,
      bullets: lines.slice(i, i + DOCUMENTS.bulletsPerSlide),
    });
  }
  if (section.table) pages.push({ heading: section.heading, table: section.table });
  return pages;
}

export async function buildPptx(spec: DocumentSpec): Promise<OutgoingFile> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = spec.title;
  pptx.author = 'WhatsApp finance bot';
  const rtlDeck = isRtl(spec.title);

  const cover = pptx.addSlide();
  cover.addShape('rect', { x: 0, y: 0, w: W, h: 0.25, fill: { color: THEME.accent }, line: { color: THEME.accent } });
  cover.addText(spec.title, {
    x: 0.8,
    y: 2.4,
    w: W - 1.6,
    h: 1.4,
    fontFace: THEME.font,
    fontSize: 40,
    bold: true,
    color: THEME.dark,
    align: align(spec.title),
    rtlMode: rtlDeck,
  });
  if (spec.subtitle)
    cover.addText(spec.subtitle, {
      x: 0.8,
      y: 3.9,
      w: W - 1.6,
      h: 0.8,
      fontFace: THEME.font,
      fontSize: 20,
      color: THEME.muted,
      align: align(spec.subtitle),
      rtlMode: isRtl(spec.subtitle),
    });

  for (const page of spec.sections.flatMap(slidesFor)) {
    const slide = pptx.addSlide();
    slide.addShape('rect', {
      x: 0,
      y: 0,
      w: 0.18,
      h: 7.5,
      fill: { color: THEME.accent },
      line: { color: THEME.accent },
    });
    const rtl = isRtl(page.heading) || rtlDeck;
    slide.addText(page.heading, {
      x: 0.6,
      y: 0.35,
      w: W - 1.2,
      h: 0.9,
      fontFace: THEME.font,
      fontSize: 28,
      bold: true,
      color: THEME.dark,
      align: rtl ? 'right' : 'left',
      rtlMode: rtl,
    });
    const lines = [...(page.paragraphs ?? []), ...(page.bullets ?? [])];
    let bodyY = 1.45;
    let bodyH = 5.4;
    if (page.chart && page.chart.points.length > 1) {
      const points = page.chart.points;
      const up = (points.at(-1)?.close ?? 0) >= (points[0]?.close ?? 0);
      slide.addChart(
        pptx.ChartType.line,
        [{ name: page.chart.title, labels: points.map((p) => p.date), values: points.map((p) => p.close) }],
        {
          x: 0.6,
          y: 1.35,
          w: W - 1.2,
          h: lines.length ? 3.9 : 5.6,
          chartColors: [up ? THEME.up : THEME.down],
          lineSize: 2,
          lineDataSymbol: 'none',
          showLegend: false,
          showTitle: true,
          title: page.chart.title,
          titleFontSize: 14,
          titleColor: THEME.muted,
          catAxisLabelFontSize: 10,
          catAxisLabelFrequency: String(Math.max(1, Math.ceil(points.length / 8))),
          valAxisLabelFontSize: 10,
          valGridLine: { color: 'E1E4E8', size: 0.5 },
          catGridLine: { style: 'none' },
        },
      );
      bodyY = 5.35;
      bodyH = 1.9;
    }
    if (lines.length)
      slide.addText(
        lines.map((line) => ({
          text: line,
          options: { bullet: true, breakLine: true, align: align(line), rtlMode: isRtl(line) },
        })),
        {
          x: 0.8,
          y: bodyY,
          w: W - 1.6,
          h: bodyH,
          fontFace: THEME.font,
          fontSize: page.chart ? 16 : 18,
          color: THEME.dark,
          valign: 'top',
          paraSpaceAfter: 8,
        },
      );
    const pageTable = page.table;
    if (pageTable && !lines.length) {
      const header = pageTable.headers.map((h) => ({
        text: h,
        options: { bold: true, color: 'FFFFFF', fill: { color: THEME.accent } },
      }));
      const rows = pageTable.rows.map((r) => pageTable.headers.map((_, i) => ({ text: r[i] ?? '' })));
      slide.addTable([header, ...rows], {
        x: 0.8,
        y: 1.45,
        w: W - 1.6,
        fontFace: THEME.font,
        fontSize: 14,
        color: THEME.dark,
        border: { type: 'solid', pt: 0.5, color: 'D0D7DE' },
        autoPage: true,
      });
    }
  }

  const data = (await pptx.write({ outputType: 'nodebuffer' })) as Uint8Array;
  return { fileName: fileNameFor(spec.title, 'pptx'), mimeType: DOCUMENTS.mimeTypes.pptx, data };
}
