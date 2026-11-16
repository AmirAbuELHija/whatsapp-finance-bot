/**
 * The "@bot summary" dashboard: two 1920×1080 dark slides (market wrap + under the hood), drawn as SVG and
 * rendered to PNG. Every number comes from the MarketSnapshot; the words come from the MarketStory.
 */
import type { MarketSnapshot, MarketStory, SnapshotItem } from '../../core/types.js';
import { chartSvg } from './chart.js';
import { escapeXml, text, wrap } from './svg.js';

const W = 1920;
const H = 1080;
const P = 80;
const C = {
  bg: '#131722',
  card: '#1E222D',
  border: '#363A45',
  track: '#2A2E39',
  text: '#D1D4DC',
  bright: '#F0F3FA',
  muted: '#9598A1',
  accent: '#5B9CF6',
  blue: '#2962FF',
  up: '#26A69A',
  upBg: '#1E3A36',
  down: '#EF5350',
  downBg: '#3A2329',
  amber: '#F7A600',
} as const;

const tone = (pct: number | null | undefined) => ((pct ?? 0) >= 0 ? C.up : C.down);
const pct = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}%`;
const num = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function assetValue(item: SnapshotItem): string {
  if (item.symbol === '^TNX') return `${num(item.price)}%`;
  if (item.symbol === 'USDILS=X') return `₪${num(item.price, 3)}`;
  if (item.symbol === 'BTC-USD') return `$${num((item.price ?? 0) / 1000, 1)}K`;
  return `$${num(item.price)}`;
}

const card = (x: number, y: number, w: number, h: number, fill: string = C.card, stroke: string = C.border) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;

const pill = (x: number, y: number, label: string, color: string, bg: string) => {
  const w = label.length * 16 + 26;
  return (
    `<rect x="${x - w}" y="${y - 32}" width="${w}" height="44" rx="6" fill="${bg}"/>` +
    text(x - w / 2, y, label, { size: 26, weight: 700, color, anchor: 'middle' })
  );
};

function header(title: string, accent: string, sub: string): string {
  const titleSvg =
    `<text x="${P}" y="${P + 56}" font-family="'Noto Sans'" font-size="64" font-weight="700" fill="${C.bright}">` +
    `${escapeXml(title)} <tspan fill="${C.accent}">${escapeXml(accent)}</tspan></text>`;
  return titleSvg + text(P, P + 100, sub, { size: 24, color: C.muted, maxWidth: 1200 });
}

const footer = (sources: string) => text(P, H - 44, sources, { size: 22, color: C.muted });

function stamp(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(date);
}

// ── Slide 1: the wrap ────────────────────────────────────────────────────────

function wrapSlide(s: MarketSnapshot, story: MarketStory, timeZone: string): string {
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="${C.bg}"/>`];
  const date = stamp(s.takenAt, timeZone);
  parts.push(
    header(story.headline, story.accent, `Market wrap · ${date}${story.subtitle ? ` · ${story.subtitle}` : ''}`),
  );

  // VIX gauge (10 = calm … 40 = fear)
  if (s.vix?.price != null) {
    const gx = W - P - 400;
    const pos = Math.max(0, Math.min(1, (s.vix.price - 10) / 30)) * 392;
    parts.push(
      `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${C.up}"/><stop offset="0.5" stop-color="${C.amber}"/><stop offset="1" stop-color="${C.down}"/></linearGradient></defs>`,
      text(gx, P + 30, `Fear gauge: VIX ${num(s.vix.price, 1)}, ${pct(s.vix.changePct, 1)}`, {
        size: 24,
        weight: 700,
        color: C.bright,
      }),
      `<rect x="${gx}" y="${P + 50}" width="400" height="18" rx="4" fill="url(#g)"/>`,
      `<rect x="${gx + pos}" y="${P + 42}" width="8" height="34" rx="4" fill="${C.bright}"/>`,
      text(gx, P + 104, 'Calm', { size: 22, color: C.muted }),
      text(gx + 400, P + 104, 'Fear', { size: 22, color: C.muted, anchor: 'end' }),
    );
  }

  // Index cards + sector breadth donut
  const top = 240;
  const cardW = (W - 2 * P - 3 * 18) / 4;
  s.indexes.slice(0, 3).forEach((idx, i) => {
    const x = P + i * (cardW + 18);
    const color = tone(idx.changePct);
    const fill = Math.min(1, Math.abs(idx.changePct ?? 0) / 4) * (cardW - 46);
    parts.push(
      card(x, top, cardW, 150),
      text(x + 23, top + 42, idx.label, { size: 24, weight: 700, color: C.muted }),
      text(x + 23, top + 96, num(idx.price), { size: 40, weight: 700, color: C.bright }),
      pill(x + cardW - 23, top + 94, pct(idx.changePct), color, (idx.changePct ?? 0) >= 0 ? C.upBg : C.downBg),
      `<rect x="${x + 23}" y="${top + 120}" width="${cardW - 46}" height="8" rx="4" fill="${C.track}"/>`,
      `<rect x="${x + 23}" y="${top + 120}" width="${fill}" height="8" rx="4" fill="${color}"/>`,
    );
  });
  if (s.sectors.length) {
    const x = P + 3 * (cardW + 18);
    const down = s.sectors.filter((x) => (x.changePct ?? 0) < 0).length;
    const share = down / s.sectors.length;
    const majorityDown = share >= 0.5;
    const circumference = 2 * Math.PI * 44;
    parts.push(
      card(x, top, cardW, 150),
      `<circle cx="${x + 79}" cy="${top + 75}" r="44" fill="none" stroke="${C.up}" stroke-width="20"/>`,
      `<circle cx="${x + 79}" cy="${top + 75}" r="44" fill="none" stroke="${C.down}" stroke-width="20" stroke-dasharray="${(share * circumference).toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 ${x + 79} ${top + 75})"/>`,
      text(x + 150, top + 70, `${majorityDown ? down : s.sectors.length - down} of ${s.sectors.length}`, {
        size: 44,
        weight: 700,
        color: majorityDown ? C.down : C.up,
      }),
      text(x + 150, top + 108, `sectors ${majorityDown ? 'fell' : 'rose'} today`, { size: 24, color: C.text }),
    );
  }

  // Biggest moves | Why it moved
  const mid = 420;
  const midH = 440;
  const leftW = 620;
  parts.push(
    card(P, mid, leftW, midH),
    text(P + 30, mid + 52, 'Biggest moves', { size: 28, weight: 700, color: C.accent }),
  );
  const movers = s.movers.slice(0, 7);
  const maxAbs = Math.max(1, ...movers.map((m) => Math.abs(m.changePct ?? 0)));
  movers.forEach((m, i) => {
    const y = mid + 100 + i * 50;
    const w = (Math.abs(m.changePct ?? 0) / maxAbs) * 260;
    parts.push(
      text(P + 30, y + 22, m.symbol, { size: 24, weight: 700, color: C.bright }),
      `<rect x="${P + 170}" y="${y}" width="260" height="28" rx="4" fill="${C.track}"/>`,
      `<rect x="${P + 170}" y="${y}" width="${w.toFixed(1)}" height="28" rx="4" fill="${tone(m.changePct)}"/>`,
      text(P + leftW - 30, y + 22, pct(m.changePct, 1), {
        size: 24,
        weight: 700,
        color: tone(m.changePct),
        anchor: 'end',
      }),
    );
  });

  const fx = P + leftW + 18;
  const fw = W - P - fx;
  parts.push(
    card(fx, mid, fw, midH),
    text(fx + 30, mid + 52, 'Why it moved', { size: 28, weight: 700, color: C.accent }),
  );
  const causes = story.causes.length ? story.causes : ['—'];
  const boxW = (fw - 60 - (causes.length - 1) * 24) / causes.length;
  const causeTop = mid + 90;
  const busY = causeTop + 110;
  causes.forEach((cause, i) => {
    const x = fx + 30 + i * (boxW + 24);
    const lines = wrap(cause, boxW - 24, 26, 2);
    parts.push(
      `<rect x="${x}" y="${causeTop}" width="${boxW}" height="86" rx="8" fill="${C.track}" stroke="${C.amber}" stroke-width="1.5"/>`,
    );
    lines.forEach((line, l) =>
      parts.push(
        text(x + boxW / 2, causeTop + 38 + l * 32 + (lines.length === 1 ? 14 : 0), line, {
          size: 26,
          weight: 700,
          color: C.bright,
          anchor: 'middle',
        }),
      ),
    );
    parts.push(
      `<line x1="${x + boxW / 2}" y1="${causeTop + 86}" x2="${x + boxW / 2}" y2="${busY}" stroke="${C.muted}" stroke-width="3"/>`,
    );
  });
  const centerX = fx + fw / 2;
  const firstX = fx + 30 + boxW / 2;
  const lastX = fx + 30 + (causes.length - 1) * (boxW + 24) + boxW / 2;
  const effectY = busY + 40;
  parts.push(
    `<line x1="${firstX}" y1="${busY}" x2="${lastX}" y2="${busY}" stroke="${C.muted}" stroke-width="3"/>`,
    `<line x1="${centerX}" y1="${busY}" x2="${centerX}" y2="${effectY}" stroke="${C.muted}" stroke-width="3"/>`,
  );
  if (story.effect)
    parts.push(
      `<rect x="${centerX - 240}" y="${effectY}" width="480" height="56" rx="8" fill="${C.downBg}" stroke="${C.down}" stroke-width="1.5"/>`,
      text(centerX, effectY + 38, story.effect, {
        size: 26,
        weight: 700,
        color: C.bright,
        anchor: 'middle',
        maxWidth: 450,
      }),
      `<line x1="${centerX}" y1="${effectY + 56}" x2="${centerX}" y2="${effectY + 84}" stroke="${C.muted}" stroke-width="3"/>`,
    );
  if (story.result) {
    const lines = wrap(story.result, 820, 28, 2);
    parts.push(`<rect x="${centerX - 440}" y="${effectY + 84}" width="880" height="96" rx="8" fill="${C.blue}"/>`);
    lines.forEach((line, l) =>
      parts.push(
        text(centerX, effectY + 128 + l * 34 + (lines.length === 1 ? 14 : 0), line, {
          size: 28,
          weight: l === 0 ? 700 : 400,
          color: '#FFFFFF',
          anchor: 'middle',
        }),
      ),
    );
  }

  // Other assets + next up
  const bottom = 880;
  const assets = s.assets
    .filter((a) => (story.nextUp.length ? a.symbol !== 'USDILS=X' : true))
    .slice(0, story.nextUp.length ? 4 : 5);
  const slots = assets.length + (story.nextUp.length ? 2 : 0);
  const slotW = (W - 2 * P - (slots - 1) * 18) / slots;
  assets.forEach((a, i) => {
    const x = P + i * (slotW + 18);
    parts.push(
      card(x, bottom, slotW, 110),
      text(x + 20, bottom + 40, a.label, { size: 24, color: C.muted }),
      text(x + slotW - 20, bottom + 40, pct(a.changePct, 1), {
        size: 24,
        weight: 700,
        color: tone(a.changePct),
        anchor: 'end',
      }),
      text(x + 20, bottom + 88, assetValue(a), { size: 34, weight: 700, color: C.bright }),
    );
  });
  if (story.nextUp.length) {
    const x = P + assets.length * (slotW + 18);
    const w = W - P - x;
    parts.push(
      card(x, bottom, w, 110, C.blue, C.blue),
      text(x + 24, bottom + 40, 'Next up', { size: 26, weight: 700, color: '#FFFFFF' }),
      text(x + 24, bottom + 86, story.nextUp.join('   ›   '), {
        size: 24,
        weight: 700,
        color: '#FFFFFF',
        maxWidth: w - 48,
      }),
    );
  }

  parts.push(footer(`Data: Yahoo Finance · news: Google News · ${date} · Not financial advice`));
  return parts.join('\n');
}

// ── Slide 2: under the hood ──────────────────────────────────────────────────

function moreSlide(s: MarketSnapshot, story: MarketStory, timeZone: string): string {
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="${C.bg}"/>`];
  const date = stamp(s.takenAt, timeZone);
  parts.push(
    header('Under the', 'Hood', 'The bigger picture: sectors, the Nasdaq trend, movers and the day’s top news'),
  );
  const pillW = date.length * 15 + 44;
  parts.push(
    `<rect x="${W - P - pillW}" y="${P + 30}" width="${pillW}" height="52" rx="6" fill="${C.track}" stroke="${C.border}"/>`,
    text(W - P - pillW / 2, P + 66, date, { size: 26, weight: 700, color: C.bright, anchor: 'middle' }),
  );

  const top = 240;
  const h = 760;
  // Sector scoreboard (diverging bars around a zero line)
  const sw = 560;
  parts.push(
    card(P, top, sw, h),
    text(P + 30, top + 52, 'Sector scoreboard', { size: 28, weight: 700, color: C.accent }),
  );
  const sectors = [...s.sectors].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
  const maxAbs = Math.max(0.5, ...sectors.map((x) => Math.abs(x.changePct ?? 0)));
  const zero = P + 30 + 180 + 130;
  sectors.forEach((sec, i) => {
    const y = top + 90 + i * 52;
    const v = sec.changePct ?? 0;
    const w = (Math.abs(v) / maxAbs) * 120;
    parts.push(
      text(P + 30, y + 22, sec.label, { size: 24, weight: 700, color: C.text }),
      `<rect x="${v >= 0 ? zero : zero - w}" y="${y}" width="${w.toFixed(1)}" height="28" rx="4" fill="${tone(v)}"/>`,
      text(P + sw - 30, y + 22, pct(v, 1), { size: 24, weight: 700, color: tone(v), anchor: 'end' }),
    );
  });
  parts.push(
    `<line x1="${zero}" y1="${top + 84}" x2="${zero}" y2="${top + 90 + sectors.length * 52 - 18}" stroke="${C.muted}" stroke-width="3"/>`,
  );
  const up = sectors.filter((x) => (x.changePct ?? 0) > 0).length;
  parts.push(
    text(P + 30, top + h - 30, `Select Sector SPDR ETFs · ${up} of ${sectors.length} rose`, {
      size: 22,
      color: C.muted,
    }),
  );

  // Trend chart + movers
  const mx = P + sw + 18;
  const mw = 600;
  const trendH = 400;
  parts.push(card(mx, top, mw, trendH));
  if (s.trend) {
    const label =
      s.trend.fromHighPct != null
        ? `${s.trend.label} · 6 months · ${pct(s.trend.fromHighPct, 1)} vs high`
        : `${s.trend.label} · 6 months`;
    parts.push(
      text(mx + 30, top + 52, label, { size: 28, weight: 700, color: C.accent, maxWidth: mw - 60 }),
      chartSvg(s.trend.points, { x: mx + 30, y: top + 90, width: mw - 60, height: 240, axis: false, dark: true }),
    );
  }
  const moversTop = top + trendH + 18;
  const moversH = h - trendH - 18;
  parts.push(
    card(mx, moversTop, mw, moversH),
    text(mx + 30, moversTop + 52, 'Movers', { size: 28, weight: 700, color: C.accent }),
  );
  const gainers = s.movers.filter((m) => (m.changePct ?? 0) > 0).slice(0, 3);
  const losers = s.movers.filter((m) => (m.changePct ?? 0) < 0).slice(0, 3);
  [...gainers, ...losers].slice(0, 5).forEach((m, i) => {
    const y = moversTop + 96 + i * 50;
    const isUp = (m.changePct ?? 0) >= 0;
    const tri = isUp
      ? `M${mx + 30} ${y + 4} L${mx + 42} ${y - 18} L${mx + 54} ${y + 4} Z`
      : `M${mx + 30} ${y - 18} L${mx + 42} ${y + 4} L${mx + 54} ${y - 18} Z`;
    parts.push(
      `<path d="${tri}" fill="${tone(m.changePct)}"/>`,
      text(mx + 72, y, m.symbol, { size: 26, weight: 700, color: C.bright }),
      text(mx + 240, y, num(m.price), { size: 24, color: C.muted }),
      text(mx + mw - 30, y, pct(m.changePct), { size: 26, weight: 700, color: tone(m.changePct), anchor: 'end' }),
    );
  });

  // Top news
  const nx = mx + mw + 18;
  const nw = W - P - nx;
  parts.push(
    card(nx, top, nw, h),
    text(nx + 30, top + 52, 'Top market news', { size: 28, weight: 700, color: C.accent }),
  );
  let ny = top + 92;
  const newsBottom = top + h - 20;
  for (const [i, n] of story.news.slice(0, 6).entries()) {
    const lines = wrap(n.detail, nw - 96, 21, 2);
    const itemH = 40 + lines.length * 27 + 16;
    if (ny + itemH > newsBottom) break; // never spill out of the card
    parts.push(
      `<rect x="${nx + 30}" y="${ny}" width="40" height="40" rx="6" fill="${C.blue}"/>`,
      text(nx + 50, ny + 29, String(i + 1), { size: 24, weight: 700, color: '#FFFFFF', anchor: 'middle' }),
      text(nx + 86, ny + 28, n.title, { size: 24, weight: 700, color: C.bright, maxWidth: nw - 116 }),
    );
    lines.forEach((line, l) => parts.push(text(nx + 86, ny + 58 + l * 27, line, { size: 21, color: C.text })));
    ny += itemH;
  }

  parts.push(footer(`Data: Yahoo Finance (sector ETFs, quotes) · news: Google News · ${date} · Not financial advice`));
  return parts.join('\n');
}

const svgDoc = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;

export function summarySvgs(snapshot: MarketSnapshot, story: MarketStory, timeZone: string): [string, string] {
  return [svgDoc(wrapSlide(snapshot, story, timeZone)), svgDoc(moreSlide(snapshot, story, timeZone))];
}
