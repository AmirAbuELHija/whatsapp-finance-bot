/**
 * Designed PNG images for WhatsApp: a stock report card (price, change, chart, stats, highlights) and plain charts.
 * SVG is drawn here and rasterized with resvg (Rust, no browser). Fonts are bundled in assets/fonts.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import type {
  ChartSeries,
  MarketSnapshot,
  MarketStory,
  OutgoingFile,
  ReportRenderer,
  StockReport,
  SummaryRenderer,
} from '../../core/types.js';
import { summarySvgs } from './summary-slides.js';
import { fileNameFor, isRtl } from '../documents/document-text.js';
import { chartSvg } from './chart.js';
import { COLORS, FONT, formatPct, formatPrice, text, wrap } from './svg.js';

const FONT_DIR = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));
const WIDTH = 1080;
const PAD = 56;

let fontFiles: string[] | undefined;
const fonts = (): string[] =>
  (fontFiles ??= readdirSync(FONT_DIR)
    .filter((f) => f.endsWith('.ttf'))
    .map((f) => FONT_DIR + f));

function toPng(svg: string, width: number): Uint8Array {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: 'Noto Sans' },
    background: '#FFFFFF',
  });
  return resvg.render().asPng();
}

export class StockReportRenderer implements ReportRenderer, SummaryRenderer {
  summarySlides(snapshot: MarketSnapshot, story: MarketStory, timeZone: string): Promise<OutgoingFile[]> {
    const day = snapshot.takenAt.toISOString().slice(0, 10);
    return Promise.resolve(
      summarySvgs(snapshot, story, timeZone).map((svg, i) => ({
        fileName: `market-summary-${day}-${i + 1}.png`,
        mimeType: 'image/png',
        data: toPng(svg, 1920),
      })),
    );
  }

  stockCard(report: StockReport): Promise<OutgoingFile> {
    const { quote, history, highlights } = report;
    const up = (quote.changePct ?? 0) >= 0;
    const periodUp = (history.changePct ?? 0) >= 0;
    const parts: string[] = [];
    let y = PAD;

    // Header: name, symbol line
    parts.push(text(PAD, (y += 48), quote.name || quote.symbol, { size: 46, weight: 700 }));
    const meta = [quote.symbol, quote.exchange, quote.currency].filter(Boolean).join(' · ');
    parts.push(text(PAD, (y += 42), meta, { size: 26, color: COLORS.muted }));

    // Price + today's change pill
    y += 92;
    const priceText = formatPrice(quote.price, quote.currency);
    parts.push(text(PAD, y, priceText, { size: 76, weight: 700 }));
    const change = `${formatPct(quote.changePct)} today`;
    const pillX = PAD + priceText.length * 44 + 28;
    const pillW = change.length * 16 + 84;
    const tone = up ? COLORS.up : COLORS.down;
    const ty = y - 21; // triangle centre
    const triangle = up
      ? `M${pillX + 30} ${ty + 9} L${pillX + 42} ${ty - 11} L${pillX + 54} ${ty + 9} Z`
      : `M${pillX + 30} ${ty - 9} L${pillX + 42} ${ty + 11} L${pillX + 54} ${ty - 9} Z`;
    parts.push(
      `<rect x="${pillX}" y="${y - 50}" width="${pillW}" height="58" rx="29" fill="${up ? COLORS.upBg : COLORS.downBg}"/>`,
      `<path d="${triangle}" fill="${tone}"/>`,
      text(pillX + 66, y - 11, change, { size: 28, weight: 700, color: tone }),
    );

    // Chart panel
    y += 40;
    const chartTop = y + 28;
    parts.push(
      `<rect x="${PAD - 16}" y="${y}" width="${WIDTH - 2 * PAD + 32}" height="470" rx="20" fill="${COLORS.panel}"/>`,
    );
    parts.push(
      text(PAD + 8, chartTop + 12, `${history.range} · ${formatPct(history.changePct)}`, {
        size: 26,
        weight: 700,
        color: periodUp ? COLORS.up : COLORS.down,
      }),
    );
    parts.push(
      chartSvg(history.points ?? [], {
        x: PAD + 8,
        y: chartTop + 40,
        width: WIDTH - 2 * PAD - 16,
        height: 340,
        currency: quote.currency,
      }),
    );
    y += 470 + 40;

    // Stats grid
    const stats: [string, string][] = [
      ['Day range', `${formatPrice(quote.dayLow)} – ${formatPrice(quote.dayHigh)}`],
      ['52-week range', `${formatPrice(quote.fiftyTwoWeekLow)} – ${formatPrice(quote.fiftyTwoWeekHigh)}`],
      [`${history.range} high / low`, `${formatPrice(history.high)} / ${formatPrice(history.low)}`],
      ['Max drawdown', formatPct(history.maxDrawdownPct == null ? null : -Math.abs(history.maxDrawdownPct))],
    ];
    const cellW = (WIDTH - 2 * PAD) / 2;
    stats.forEach(([label, value], i) => {
      const x = PAD + (i % 2) * cellW;
      const rowY = y + Math.floor(i / 2) * 96;
      parts.push(text(x, rowY + 24, label, { size: 24, color: COLORS.muted }));
      parts.push(text(x, rowY + 66, value, { size: 32, weight: 700 }));
    });
    y += 2 * 96 + 24;

    // Highlights (written by the AI from the news)
    if (highlights.length) {
      parts.push(
        `<line x1="${PAD}" y1="${y}" x2="${WIDTH - PAD}" y2="${y}" stroke="${COLORS.grid}" stroke-width="2"/>`,
      );
      parts.push(text(PAD, (y += 58), 'Highlights', { size: 32, weight: 700, color: COLORS.accent }));
      y += 14;
      for (const item of highlights.slice(0, 5)) {
        const rtl = isRtl(item);
        const lines = wrap(item, WIDTH - 2 * PAD - 44, 28);
        lines.forEach((line, i) => {
          y += 42;
          if (i === 0)
            parts.push(
              `<circle cx="${rtl ? WIDTH - PAD - 8 : PAD + 8}" cy="${y - 10}" r="6" fill="${COLORS.accent}"/>`,
            );
          parts.push(text(rtl ? WIDTH - PAD - 32 : PAD + 32, y, line, { size: 28, anchor: rtl ? 'end' : 'start' }));
        });
        y += 10;
      }
    }

    // Footer
    const stamp = report.generatedAt.toLocaleString('en-GB', {
      timeZone: report.timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    y += 56;
    parts.push(text(PAD, y, `${history.source} · ${stamp} · Not investment advice`, { size: 20, color: COLORS.muted }));
    const height = y + PAD - 16;

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="${FONT}">` +
      `<rect width="100%" height="100%" fill="#FFFFFF"/>` +
      `<rect width="100%" height="10" fill="${up ? COLORS.up : COLORS.down}"/>` +
      parts.join('\n') +
      `</svg>`;
    const caption = `${quote.name || quote.symbol} ${formatPrice(quote.price, quote.currency)} (${formatPct(quote.changePct)} today, ${formatPct(history.changePct)} ${history.range})`;
    return Promise.resolve({
      fileName: fileNameFor(`${quote.symbol}-report`, 'png'),
      mimeType: 'image/png',
      data: toPng(svg, WIDTH),
      caption,
    });
  }

  chartPng(chart: ChartSeries, width: number, height: number): Uint8Array {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<rect width="100%" height="100%" fill="#FFFFFF"/>` +
      text(24, 44, chart.title, { size: 28, weight: 700 }) +
      chartSvg(chart.points, { x: 24, y: 72, width: width - 48, height: height - 140 }) +
      `</svg>`;
    return toPng(svg, width);
  }
}
