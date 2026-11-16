import type { NewsItem } from '../../core/types.js';

const ENTITIES: readonly [RegExp, string][] = [
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&nbsp;/g, ' '],
  [/&amp;/g, '&'], // last, so "&amp;lt;" stays "&lt;"
];

export function decodeXml(s = ''): string {
  let out = s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
  for (const [pattern, replacement] of ENTITIES) out = out.replace(pattern, replacement);
  return out.trim();
}

/** Minimal RSS 2.0 item parser (title, link, pubDate, source). */
export function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const [, block = ''] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (name: string) => decodeXml(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block)?.[1] ?? '');
    const source = tag('source');
    let title = tag('title');
    // Google News appends " - Publisher" to every title.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const date = Date.parse(tag('pubDate'));
    if (title) {
      items.push({
        title,
        source: source || null,
        url: tag('link') || null,
        publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
      });
    }
  }
  return items;
}
