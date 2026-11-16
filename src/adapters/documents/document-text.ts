/** Small helpers shared by the Word and PowerPoint builders. */
import { DOCUMENTS } from '../../config/constants.js';
import type { DocumentSection, DocumentSpec } from '../../core/types.js';

/** Hebrew, Arabic and other right-to-left scripts. */
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;
export const isRtl = (text: string): boolean => RTL.test(text);

const clip = (text: unknown, max: number = DOCUMENTS.maxTextChars): string => {
  const value = typeof text === 'string' ? text : typeof text === 'number' ? String(text) : '';
  return value.trim().slice(0, max);
};

const list = (value: unknown, max: number): string[] =>
  (Array.isArray(value) ? value : [])
    .map((v) => clip(v))
    .filter(Boolean)
    .slice(0, max);

/** Cleans whatever the AI sent into a bounded, well-formed spec. */
export function normalizeSpec(spec: DocumentSpec): DocumentSpec {
  const sections: DocumentSection[] = (Array.isArray(spec.sections) ? spec.sections : [])
    .slice(0, DOCUMENTS.maxSections)
    .map((s): DocumentSection => {
      const headers = list(s.table?.headers, DOCUMENTS.maxTableColumns);
      const rows = (Array.isArray(s.table?.rows) ? s.table.rows : [])
        .slice(0, DOCUMENTS.maxTableRows)
        .map((row) => list(row, headers.length || DOCUMENTS.maxTableColumns));
      return {
        heading: clip(s.heading, DOCUMENTS.maxTitleChars),
        paragraphs: list(s.paragraphs, DOCUMENTS.maxItemsPerSection),
        bullets: list(s.bullets, DOCUMENTS.maxItemsPerSection),
        ...(headers.length ? { table: { headers, rows } } : {}),
        ...(s.chart && s.chart.points.length > 1 ? { chart: s.chart } : {}),
      };
    })
    .filter((s) => s.heading || s.paragraphs?.length || s.bullets?.length || s.table || s.chart);
  const subtitle = clip(spec.subtitle, DOCUMENTS.maxTitleChars);
  return {
    format: spec.format,
    title: clip(spec.title, DOCUMENTS.maxTitleChars) || 'Document',
    ...(subtitle ? { subtitle } : {}),
    sections,
  };
}

/** "Q3 Market Review!" → "Q3-Market-Review.pptx" (letters in any language are kept). */
export function fileNameFor(title: string, extension: string): string {
  const base = title
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'document'}.${extension}`;
}
