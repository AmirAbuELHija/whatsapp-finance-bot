/**
 * Turns the live snapshot + the AI's words into exactly what the HTML template shows: ready-made strings, bar
 * widths, chart coordinates. The template only places them (with textContent), so everything is testable here.
 */
import type { MarketSnapshot, MarketStory, SnapshotItem } from '../../core/types.js';

export type Tone = 'up' | 'down' | 'flat';

export interface SummaryView {
  title: string;
  accent: string;
  sub: string;
  date: string;
  vix: { label: string; pinX: number } | null;
  indexes: { name: string; value: string; pct: string; tone: Tone; meterW: number }[];
  breadth: { big: string; caption: string; downDash: number; tone: Tone; label: string } | null;
  barsTitle: string;
  bars: { name: string; pct: string; tone: Tone; w: number }[];
  slope: {
    lines: { color: string; y1: number; y2: number }[];
    openLabels: { text: string; y: number }[];
    closeLabels: { text: string; y: number }[];
  } | null;
  flow: { title: string; causes: string[]; effect: string; resultBold: string; resultText: string };
  assets: { name: string; value: string; change: string; tone: Tone }[];
  nextUp: string[];
  source1: string;
  sectors: { name: string; pct: string; tone: Tone; negW: number; posW: number }[];
  sectorNote: string;
  trend: {
    title: string;
    points: string;
    high: { x: number; y: number; label: string; labelX: number; labelY: number };
    now: { x: number; y: number; label: string; labelX: number; labelY: number };
    correction: { y: number; label: string } | null;
    low: { x: number; y: number } | null;
  } | null;
  moversTitle: string;
  movers: { name: string; why: string; tone: Tone }[];
  news: { title: string; detail: string }[];
  source2: string;
}

/** Sizes in the template (px). Kept here so the numbers and the layout agree. */
export const GEOMETRY = {
  meter: 370,
  bar: 180,
  sectorHalf: 105,
  vixTrack: 392,
  slope: { top: 30, bottom: 236, openX: 96, closeX: 236 },
  trend: { width: 512, height: 262, left: 14, right: 498, top: 44, bottom: 214 },
} as const;

const SLOPE_COLORS = ['#5B9CF6', '#F7A600', '#D1D4DC'];

const toneOf = (pct: number | null | undefined, flat = 0): Tone =>
  pct == null || Math.abs(pct) <= flat ? 'flat' : pct > 0 ? 'up' : 'down';

export const fmtPct = (v: number | null | undefined, digits = 2): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}%`;

export const fmtNum = (v: number | null | undefined, digits = 2): string =>
  v == null || !Number.isFinite(v)
    ? '—'
    : v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function assetValue(item: SnapshotItem): string {
  if (item.symbol === '^TNX') return `${fmtNum(item.price)}%`;
  if (item.symbol === 'USDILS=X') return `₪${fmtNum(item.price, 3)}`;
  if (item.symbol === 'BTC-USD') return `$${fmtNum((item.price ?? 0) / 1000, 1)}K`;
  if ((item.price ?? 0) >= 1000) return `$${fmtNum(item.price, 0)}`;
  return `$${fmtNum(item.price)}`;
}

function shortName(label: string): string {
  return label.replace(' Composite', '').replace('Dow Jones', 'Dow');
}

const dateFormat = (timeZone: string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { timeZone, ...options });

/** Percent move from the day's open to now, for each index (only when every index has an open). */
function slopeOf(indexes: SnapshotItem[]): SummaryView['slope'] {
  const rows = indexes.map((i) => {
    const prev = i.price != null && i.change != null ? i.price - i.change : null;
    const openPct = prev && i.open != null ? ((i.open - prev) / prev) * 100 : null;
    return { name: shortName(i.label), openPct, closePct: i.changePct };
  });
  if (!rows.length || rows.some((r) => r.openPct == null || r.closePct == null)) return null;
  const values = rows.flatMap((r) => [r.openPct ?? 0, r.closePct ?? 0, 0]);
  const hi = Math.max(...values);
  const lo = Math.min(...values);
  const { top, bottom } = GEOMETRY.slope;
  const y = (v: number) => round1(hi === lo ? (top + bottom) / 2 : top + ((hi - v) / (hi - lo)) * (bottom - top));
  /** Labels 30px tall: push them apart so they never overlap. */
  const spread = (ys: number[]) => {
    const order = ys.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const out = [...ys];
    let last = -Infinity;
    for (const { v, i } of order) {
      const placed = Math.max(v, last + 30);
      out[i] = placed;
      last = placed;
    }
    return out;
  };
  const opens = rows.map((r) => y(r.openPct ?? 0));
  const closes = rows.map((r) => y(r.closePct ?? 0));
  const openY = spread(opens);
  const closeY = spread(closes);
  return {
    lines: rows.map((_, i) => ({
      color: SLOPE_COLORS[i % SLOPE_COLORS.length] ?? '#D1D4DC',
      y1: opens[i] ?? 0,
      y2: closes[i] ?? 0,
    })),
    openLabels: rows.map((r, i) => ({ text: fmtPct(r.openPct, 1), y: (openY[i] ?? 0) - 15 })),
    closeLabels: rows.map((r, i) => ({ text: `${r.name} ${fmtPct(r.closePct)}`, y: (closeY[i] ?? 0) - 15 })),
  };
}

function trendOf(trend: MarketSnapshot['trend']): SummaryView['trend'] {
  const points = trend?.points ?? [];
  if (!trend || points.length < 2) return null;
  const { width, left, right, top, bottom } = GEOMETRY.trend;
  const closes = points.map((p) => p.close);
  const peak = Math.max(...closes);
  const high = Math.max(peak, trend.high ?? 0);
  const correctionLevel = high * 0.9;
  const lo = Math.min(...closes, correctionLevel);
  const hi = high;
  const x = (i: number) => round1(left + (i / (points.length - 1)) * (right - left));
  const y = (v: number) => round1(hi === lo ? (top + bottom) / 2 : top + ((hi - v) / (hi - lo)) * (bottom - top));
  const peakIndex = closes.indexOf(peak);
  const lastIndex = points.length - 1;
  const last = closes[lastIndex] ?? peak;
  const lowIndex = closes.indexOf(Math.min(...closes));
  const nowPct = ((last - high) / high) * 100;
  const peakDate = points[peakIndex]?.date;
  const peakLabel = peakDate
    ? dateFormat('UTC', { month: 'short', day: 'numeric' }).format(new Date(`${peakDate}T12:00:00Z`))
    : '';
  const highX = x(peakIndex);
  const nowX = x(lastIndex);
  const nowY = y(last);
  return {
    title: `${trend.label} · 6 months`,
    points: closes.map((c, i) => `${x(i)},${y(c)}`).join(' '),
    // Labels live in bands above and below the line, so they never sit on it.
    high: {
      x: highX,
      y: y(peak),
      label: `${peak >= high ? 'Record' : '6-month high'}${peakLabel ? ` ${peakLabel}` : ''}: ${fmtNum(peak, 0)}`,
      labelX: clamp(highX - 120, 0, width - 320),
      labelY: 2,
    },
    now: {
      x: nowX,
      y: nowY,
      label: `Now: ${fmtPct(nowPct, 1)}${peak >= high ? '' : ' vs 52-wk high'}`,
      labelX: width - 300,
      labelY: 230,
    },
    correction: lo <= correctionLevel ? { y: y(correctionLevel), label: '−10% = correction' } : null,
    low: lowIndex !== lastIndex && lowIndex !== peakIndex ? { x: x(lowIndex), y: y(closes[lowIndex] ?? lo) } : null,
  };
}

export function summaryView(s: MarketSnapshot, story: MarketStory, timeZone: string): SummaryView {
  const date = dateFormat(timeZone, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(
    s.takenAt,
  );
  const time = dateFormat(timeZone, { hour: '2-digit', minute: '2-digit', hour12: false }).format(s.takenAt);
  const zone = timeZone.split('/').pop()?.replace(/_/g, ' ') ?? timeZone;

  const lead = s.indexes[0];
  const leadDown = (lead?.changePct ?? 0) < 0;

  // Index cards: meters scaled so a 3% day fills most of the bar.
  const maxIndexMove = Math.max(3, ...s.indexes.map((i) => Math.abs(i.changePct ?? 0)));
  const indexes = s.indexes.map((i) => ({
    name:
      i.symbol === '^DJI' && i.change != null
        ? `${i.label} · ${i.change < 0 ? 'down' : 'up'} ${fmtNum(Math.abs(i.change), 0)} pts`
        : i.label,
    value: fmtNum(i.price),
    pct: fmtPct(i.changePct),
    tone: toneOf(i.changePct),
    meterW: Math.round((Math.abs(i.changePct ?? 0) / maxIndexMove) * GEOMETRY.meter),
  }));

  // Breadth: how many of the 11 sectors fell.
  const sectorMoves = s.sectors.filter((x) => x.changePct != null);
  const down = sectorMoves.filter((x) => (x.changePct ?? 0) < 0).length;
  const up = sectorMoves.length - down;
  const mostlyDown = down >= up;
  const circumference = 2 * Math.PI * 44;
  const breadth = sectorMoves.length
    ? {
        big: `${mostlyDown ? down : up} of ${sectorMoves.length}`,
        caption: mostlyDown ? `sectors fell · ${up} rose` : `sectors rose · ${down} fell`,
        downDash: round1((down / sectorMoves.length) * circumference),
        tone: (mostlyDown ? 'down' : 'up') as Tone,
        label: `Donut chart: ${down} of ${sectorMoves.length} sectors fell, ${up} rose`,
      }
    : null;

  // Biggest moves in the watchlist.
  const moves = s.movers.slice(0, 6);
  const maxMove = Math.max(1, ...moves.map((m) => Math.abs(m.changePct ?? 0)));
  const bars = moves.map((m) => ({
    name: m.label,
    pct: fmtPct(m.changePct, 1),
    tone: toneOf(m.changePct),
    w: Math.max(6, Math.round((Math.abs(m.changePct ?? 0) / maxMove) * GEOMETRY.bar)),
  }));
  const losers = moves.filter((m) => (m.changePct ?? 0) < 0).length;

  const assets = s.assets
    .filter((a) => a.symbol !== 'USDILS=X')
    .slice(0, 4)
    .map((a) => {
      const tone = toneOf(a.changePct, 0.05);
      return { name: a.label, value: assetValue(a), change: tone === 'flat' ? 'Flat' : fmtPct(a.changePct, 1), tone };
    });

  // Sector scoreboard: best at the top, bars diverge from a centre line.
  const maxSector = Math.max(0.5, ...sectorMoves.map((x) => Math.abs(x.changePct ?? 0)));
  const sectors = [...sectorMoves]
    .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
    .map((x) => {
      const v = x.changePct ?? 0;
      const w = Math.max(4, Math.round((Math.abs(v) / maxSector) * GEOMETRY.sectorHalf));
      return { name: x.label, pct: fmtPct(v, 1), tone: toneOf(v), negW: v < 0 ? w : 0, posW: v >= 0 ? w : 0 };
    });

  // Best and worst of the watchlist, with the size of the move as the reason.
  const sorted = [...s.movers].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
  const best = sorted.filter((m) => (m.changePct ?? 0) > 0).slice(0, 2);
  const worst = sorted
    .filter((m) => (m.changePct ?? 0) < 0)
    .reverse()
    .slice(0, 5 - best.length);
  const movers = [...best, ...worst].map((m) => ({
    name: m.label,
    why: `${(m.changePct ?? 0) >= 0 ? 'Up' : 'Down'} ${fmtNum(Math.abs(m.changePct ?? 0), 1)}%`,
    tone: toneOf(m.changePct),
  }));

  const stamp = `Live at ${time} ${zone} time, ${date}`;
  return {
    title: story.headline,
    accent: story.accent,
    sub: ['Wall Street wrap', date, story.subtitle].filter(Boolean).join(' · '),
    date,
    vix:
      s.vix?.price != null
        ? {
            label: `Fear gauge: VIX ${fmtNum(s.vix.price, 1)}${s.vix.changePct == null ? '' : `, ${s.vix.changePct >= 0 ? 'up' : 'down'} ${fmtNum(Math.abs(s.vix.changePct), 0)}%`}`,
            pinX: Math.round(clamp((s.vix.price - 10) / 30, 0, 1) * GEOMETRY.vixTrack),
          }
        : null,
    indexes,
    breadth,
    barsTitle: losers > moves.length / 2 ? 'Who got hit hardest' : losers === 0 ? 'Biggest gainers' : 'Biggest moves',
    bars,
    slope: slopeOf(s.indexes),
    flow: {
      title: leadDown ? 'Why it fell' : 'Why it rose',
      causes: story.causes.slice(0, 3),
      effect: story.effect,
      resultBold: lead ? `${shortName(lead.label)} ${fmtPct(lead.changePct)}` : '',
      resultText: story.result,
    },
    assets,
    nextUp: story.nextUp.slice(0, 2),
    source1: `Data: Yahoo Finance · News: Google News · ${stamp} · Not financial advice`,
    sectors,
    sectorNote: `Day's move of each Select Sector SPDR ETF. ${up === 0 ? 'None' : `${up} of ${sectorMoves.length}`} rose.`,
    trend: trendOf(s.trend),
    moversTitle: 'Best and worst on the watchlist',
    movers,
    news: story.news.slice(0, 6),
    source2: `Data: Yahoo Finance (sector ETFs, Nasdaq closes, watchlist) · Top news: Google News, summarized by AI · ${stamp} · Not financial advice`,
  };
}
