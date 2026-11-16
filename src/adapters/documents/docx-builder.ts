/** Word (.docx) documents from a DocumentSpec. Right-to-left text (Hebrew, Arabic) is laid out right to left. */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { DOCUMENTS } from '../../config/constants.js';
import type { DocumentSpec, OutgoingFile, ReportRenderer } from '../../core/types.js';
import { fileNameFor, isRtl } from './document-text.js';

const text = (value: string, options: { bold?: boolean; size?: number; color?: string } = {}) =>
  new TextRun({ text: value, rightToLeft: isRtl(value), ...options });

const paragraph = (
  value: string,
  options: { heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel]; bullet?: boolean; bold?: boolean } = {},
) =>
  new Paragraph({
    children: [text(value, { ...(options.bold ? { bold: true } : {}) })],
    bidirectional: isRtl(value),
    ...(isRtl(value) ? { alignment: AlignmentType.RIGHT } : {}),
    ...(options.heading ? { heading: options.heading } : {}),
    ...(options.bullet ? { bullet: { level: 0 } } : {}),
    spacing: { after: 120 },
  });

function table(headers: string[], rows: string[][]): Table {
  const cell = (value: string, bold = false) =>
    new TableCell({
      children: [paragraph(value, { bold })],
      width: { size: 100 / headers.length, type: WidthType.PERCENTAGE },
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map((h) => cell(h, true)), tableHeader: true }),
      ...rows.map((row) => new TableRow({ children: headers.map((_, i) => cell(row[i] ?? '')) })),
    ],
  });
}

export async function buildDocx(spec: DocumentSpec, charts?: ReportRenderer): Promise<OutgoingFile> {
  const body: (Paragraph | Table)[] = [paragraph(spec.title, { heading: HeadingLevel.TITLE })];
  if (spec.subtitle) body.push(paragraph(spec.subtitle, { heading: HeadingLevel.HEADING_2 }));
  for (const section of spec.sections) {
    if (section.heading) body.push(paragraph(section.heading, { heading: HeadingLevel.HEADING_1 }));
    // Word has no live charts here: the chart is embedded as a picture.
    if (section.chart && charts)
      body.push(
        new Paragraph({
          children: [
            new ImageRun({
              type: 'png',
              data: charts.chartPng(section.chart, 1200, 600),
              transformation: { width: 600, height: 300 },
            }),
          ],
          spacing: { after: 160 },
        }),
      );
    for (const p of section.paragraphs ?? []) body.push(paragraph(p));
    for (const b of section.bullets ?? []) body.push(paragraph(b, { bullet: true }));
    if (section.table) body.push(table(section.table.headers, section.table.rows), paragraph(''));
  }
  const doc = new Document({
    creator: 'WhatsApp finance bot',
    title: spec.title,
    styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
    sections: [{ children: body }],
  });
  const data = await Packer.toBuffer(doc);
  return { fileName: fileNameFor(spec.title, 'docx'), mimeType: DOCUMENTS.mimeTypes.docx, data };
}
