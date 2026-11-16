/** Turns data into WhatsApp-friendly reply text. */
import { ago, arrow, money, num, pct, shortTime, signed } from '../../core/text/format.js';
import type { Conversion, NewsResult, PriceHistory, Quote } from '../../core/types.js';

export function formatQuote(q: Quote | { symbol: string; error: string }, timeZone: string): string {
  if ('error' in q) return `*${q.symbol}* — ⚠️ ${q.error}`;
  const change = q.change != null ? `${arrow(q.change)} ${signed(q.change)} (${pct(q.changePct)})` : '';
  const lines = [`*${q.symbol}* — ${q.name}`, `${money(q.price, q.currency)}  ${change}`.trim()];
  if (q.dayLow != null && q.dayHigh != null) lines.push(`Day: ${num(q.dayLow)} – ${num(q.dayHigh)}`);
  if (q.fiftyTwoWeekLow != null && q.fiftyTwoWeekHigh != null)
    lines.push(`52w: ${num(q.fiftyTwoWeekLow)} – ${num(q.fiftyTwoWeekHigh)}`);
  const meta = [q.exchange, shortTime(q.marketTime, timeZone)].filter(Boolean).join(' · ');
  if (meta) lines.push(`_${meta}_`);
  return lines.join('\n');
}

export function formatHistory(h: PriceHistory): string {
  const volatility = h.annualizedVolatilityPct != null ? ` · Volatility ${num(h.annualizedVolatilityPct, 1)}%/yr` : '';
  return [
    `*${h.symbol}* — ${h.range} (${h.from} → ${h.to})`,
    `${money(h.startPrice, h.currency)} → ${money(h.endPrice, h.currency)}  ${arrow(h.changePct)} ${pct(h.changePct)}`,
    `High ${num(h.high)} · Low ${num(h.low)}`,
    `Max drawdown ${pct(h.maxDrawdownPct)}${volatility}`,
  ].join('\n');
}

export function formatConversion(r: Conversion, timeZone: string): string {
  const date = r.date && r.date.length > 10 ? shortTime(r.date, timeZone) : r.date;
  return [
    `*${num(r.amount)} ${r.from} = ${num(r.result)} ${r.to}*`,
    `Rate: 1 ${r.from} = ${num(r.rate, 4)} ${r.to}`,
    `_${[r.source, date].filter(Boolean).join(' · ')}_`,
  ].join('\n');
}

export function formatNews(result: NewsResult, now: number = Date.now()): string {
  if (!result.items.length) return `📰 No recent news found for *${result.topic}*.`;
  const lines = [`📰 *${result.topic}*`];
  result.items.forEach((item, i) => {
    lines.push('', `${i + 1}. *${item.title}*`);
    const meta = [item.source, ago(item.publishedAt, now)].filter(Boolean).join(' · ');
    if (meta) lines.push(`_${meta}_`);
    if (item.url) lines.push(item.url);
  });
  lines.push('', `_via ${result.source}_`);
  return lines.join('\n');
}
