/** Turns the AI's JSON into slide text that fits its boxes; falls back to headlines if the JSON is unusable. */
import type { MarketStory, NewsItem } from '../../core/types.js';

const clip = (value: unknown, max: number): string => {
  const text = (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const strings = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);

/** Finds the JSON object in a reply that may be wrapped in ```json fences or chatter. */
function extractJson(reply: string): Record<string, unknown> | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseMarketStory(reply: string, items: readonly NewsItem[], now: Date, timeZone: string): MarketStory {
  const json = extractJson(reply) ?? {};
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(now);
  const news = strings(json.news)
    .map((n) => {
      const entry = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>;
      return { title: clip(entry.title, 34), detail: clip(entry.detail, 80) };
    })
    .filter((n) => n.title)
    .slice(0, 6);
  // Without usable news from the AI, show the raw headlines (still real, just not rewritten).
  const fallbackNews = items.slice(0, 6).map((h) => ({ title: clip(h.title, 34), detail: clip(h.source ?? '', 80) }));
  const causes = strings(json.causes)
    .map((c) => clip(c, 26))
    .filter(Boolean)
    .slice(0, 3);
  return {
    headline: clip(json.headline, 22) || 'Market Wrap',
    accent: clip(json.accent, 12) || weekday,
    subtitle: clip(json.subtitle, 80),
    causes,
    effect: clip(json.effect, 28),
    result: clip(json.result, 70),
    news: news.length ? news : fallbackNews,
    nextUp: strings(json.nextUp)
      .map((n) => clip(n, 24))
      .filter(Boolean)
      .slice(0, 2),
  };
}
