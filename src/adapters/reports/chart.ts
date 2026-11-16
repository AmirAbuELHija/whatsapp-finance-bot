/** A clean area + line chart of closing prices, as an SVG fragment. */
import type { PricePoint } from '../../core/types.js';
import { COLORS, formatPrice, text } from './svg.js';

interface ChartBox {
  x: number;
  y: number;
  width: number;
  height: number;
  currency?: string | null;
  /** Price labels on the right. */
  axis?: boolean;
  /** Colors for a dark background. */
  dark?: boolean;
}

export function chartSvg(points: PricePoint[], box: ChartBox): string {
  if (points.length < 2)
    return text(box.x, box.y + box.height / 2, 'Not enough data for a chart', { size: 24, color: COLORS.muted });
  const closes = points.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const pad = (max - min || Math.abs(max) || 1) * 0.08;
  const lo = min - pad;
  const hi = max + pad;
  const axisWidth = box.axis === false ? 0 : 120;
  const plotW = box.width - axisWidth;
  const first = closes[0] ?? 0;
  const last = closes.at(-1) ?? 0;
  const up = last >= first;
  const color = box.dark ? (up ? '#26A69A' : '#EF5350') : up ? COLORS.up : COLORS.down;
  const grid = box.dark ? '#2A2E39' : COLORS.grid;
  const label = box.dark ? '#9598A1' : COLORS.muted;
  const xs = (i: number) => box.x + (i / (points.length - 1)) * plotW;
  const ys = (v: number) => box.y + (1 - (v - lo) / (hi - lo)) * box.height;

  const parts: string[] = [];
  // Grid + price labels
  for (let i = 0; i <= 4; i++) {
    const value = lo + ((hi - lo) * i) / 4;
    const y = ys(value);
    parts.push(`<line x1="${box.x}" y1="${y}" x2="${box.x + plotW}" y2="${y}" stroke="${grid}" stroke-width="1"/>`);
    if (axisWidth)
      parts.push(text(box.x + plotW + 14, y + 8, formatPrice(value, box.currency), { size: 22, color: COLORS.muted }));
  }
  // Starting-price reference line
  parts.push(
    `<line x1="${box.x}" y1="${ys(first)}" x2="${box.x + plotW}" y2="${ys(first)}" stroke="${label}" stroke-width="1.5" stroke-dasharray="6 6" opacity="0.6"/>`,
  );
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)} ${ys(p.close).toFixed(1)}`).join(' ');
  const bottom = box.y + box.height;
  parts.push(
    `<path d="${line} L${xs(points.length - 1).toFixed(1)} ${bottom} L${box.x} ${bottom} Z" fill="${color}" opacity="0.12"/>`,
  );
  parts.push(
    `<path d="${line}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`,
  );
  parts.push(`<circle cx="${xs(points.length - 1)}" cy="${ys(last)}" r="8" fill="${color}"/>`);
  // Dates
  const dateY = bottom + 36;
  parts.push(text(box.x, dateY, points[0]?.date ?? '', { size: 22, color: label }));
  parts.push(text(box.x + plotW, dateY, points.at(-1)?.date ?? '', { size: 22, color: label, anchor: 'end' }));
  return parts.join('\n');
}
