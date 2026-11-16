/** Tiny SVG helpers for report images (no DOM, no browser). */
import { isRtl } from '../documents/document-text.js';

export const FONT = "'Noto Sans', 'Noto Sans Hebrew', 'Noto Sans Arabic'";

export const COLORS = {
  text: '#1F2328',
  muted: '#59636E',
  grid: '#D8DEE4',
  panel: '#F6F8FA',
  up: '#1A7F37',
  upBg: '#DAFBE1',
  down: '#CF222E',
  downBg: '#FFEBE9',
  accent: '#0969DA',
} as const;

export const escapeXml = (text: string): string =>
  text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c);

interface TextOptions {
  size: number;
  color?: string;
  weight?: number;
  anchor?: 'start' | 'middle' | 'end';
  /** Shrink the text to fit this width (no wrapping). */
  maxWidth?: number;
}

/**
 * The script's own font goes first: the renderer only honours bold/regular for the first family, so Hebrew or
 * Arabic reached through fallback would always come out in one weight.
 */
function familyFor(value: string): string {
  if (/[\u0590-\u05FF\uFB1D-\uFB4F]/.test(value)) return "'Noto Sans Hebrew', 'Noto Sans'";
  if (/[\u0600-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/.test(value)) return "'Noto Sans Arabic', 'Noto Sans'";
  return FONT;
}

/** A text element; right-to-left text (Hebrew, Arabic) is shaped and anchored right to left. */
export function text(x: number, y: number, value: string, o: TextOptions): string {
  const rtl = isRtl(value);
  const anchor = o.anchor ?? 'start';
  const fit =
    o.maxWidth && value.length * o.size * 0.56 > o.maxWidth
      ? ` textLength="${o.maxWidth}" lengthAdjust="spacingAndGlyphs"`
      : '';
  return (
    `<text x="${x}" y="${y}" font-family="${familyFor(value)}" font-size="${o.size}" font-weight="${o.weight ?? 400}"${fit} ` +
    `fill="${o.color ?? COLORS.text}" text-anchor="${anchor}"${rtl ? ' direction="rtl" unicode-bidi="embed"' : ''}>` +
    `${escapeXml(value)}</text>`
  );
}

/** Greedy word wrap by an estimated character width (good enough for Noto Sans). */
export function wrap(value: string, width: number, size: number, maxLines = 3): string[] {
  const perLine = Math.max(8, Math.floor(width / (size * 0.54)));
  const lines: string[] = [];
  let line = '';
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > perLine && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${(kept[maxLines - 1] ?? '').replace(/\s+\S*$/, '')}…`;
    return kept;
  }
  return lines;
}

/** Compact price label: 1234.5 → "1,234.50", 0.00123 → "0.00123". */
export function formatPrice(value: number | null | undefined, currency?: string | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const digits = Math.abs(value) >= 1 ? 2 : 5;
  const number = value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const symbol = { USD: '$', EUR: '€', GBP: '£', ILS: '₪' }[currency ?? ''] ?? '';
  return symbol ? `${symbol}${number}` : `${number}${currency ? ` ${currency}` : ''}`;
}

export const formatPct = (value: number | null | undefined): string =>
  value == null || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
