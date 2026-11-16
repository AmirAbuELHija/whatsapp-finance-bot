/**
 * Free news headlines, no API keys:
 *  - Yahoo Finance search: news for one ticker
 *  - Google News RSS: market news and any topic, in English, Hebrew or Arabic
 */
import { ENDPOINTS, LIMITS } from '../../config/constants.js';
import { NEWS_LOCALES, NEWS_PRESETS, NEWS_TOPIC_WINDOW, type NewsLanguage } from '../../config/reference-data.js';
import { UserInputError } from '../../core/errors.js';
import { detectScriptLanguage } from '../../core/text/language.js';
import type { NewsItem, NewsResult, NewsSource } from '../../core/types.js';
import type { HttpClient } from '../http/http-client.js';
import { normalizeSymbol } from '../market/symbols.js';
import { parseRss } from './rss.js';

const SOURCE = { yahoo: 'Yahoo Finance', google: 'Google News' } as const;
const TICKER_LIKE = /^[\^]?[A-Za-z0-9]{1,6}([.\-=][A-Za-z0-9]{1,4})?$/;
const YAHOO_OVERFETCH = 2;
const YAHOO_MIN_FETCH = 8;

interface YahooSearchResponse {
  news?: {
    title?: string;
    publisher?: string;
    link?: string;
    providerPublishTime?: number;
    relatedTickers?: string[];
  }[];
}

const looksLikeTicker = (q: string): boolean => TICKER_LIKE.test(q) && !/^\d+$/.test(q);

export class NewsService implements NewsSource {
  constructor(private readonly http: HttpClient) {}

  /** query: "" (markets), a preset ("il", "us", "crypto"), a ticker ("AAPL") or any topic in any language. */
  async getNews(query = '', { limit = LIMITS.defaultHeadlines }: { limit?: number } = {}): Promise<NewsResult> {
    const q = query.trim();
    const n = Math.min(Math.max(Math.trunc(limit) || LIMITS.defaultHeadlines, 1), LIMITS.maxHeadlines);

    const preset = NEWS_PRESETS[q.toLowerCase()];
    if (preset)
      return {
        topic: preset.label,
        items: (await this.google(preset.query, preset.lang)).slice(0, n),
        source: SOURCE.google,
      };

    if (looksLikeTicker(q)) {
      const symbol = normalizeSymbol(q);
      try {
        const items = await this.yahoo(symbol, n);
        if (items.length) return { topic: symbol, items: items.slice(0, n), source: SOURCE.yahoo };
      } catch {
        // fall back to Google News
      }
      const name = symbol.replace(/^\^/, '').replace(/[.=-].*$/, '');
      return {
        topic: symbol,
        items: (await this.google(`${name} stock ${NEWS_TOPIC_WINDOW}`, 'en')).slice(0, n),
        source: SOURCE.google,
      };
    }

    if (q.length > LIMITS.maxNewsQueryChars) throw new UserInputError('News search is too long; use a few keywords');
    return {
      topic: q,
      items: (await this.google(`${q} ${NEWS_TOPIC_WINDOW}`, detectScriptLanguage(q))).slice(0, n),
      source: SOURCE.google,
    };
  }

  private async yahoo(symbol: string, limit: number): Promise<NewsItem[]> {
    const count = Math.max(limit * YAHOO_OVERFETCH, YAHOO_MIN_FETCH);
    const data = await this.http.getJson<YahooSearchResponse>(
      `${ENDPOINTS.yahooSearch}?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=${count}&enableFuzzyQuery=false`,
    );
    const tagged: NewsItem[] = [];
    const other: NewsItem[] = [];
    for (const n of data.news ?? []) {
      if (!n.title) continue;
      const item: NewsItem = {
        title: n.title,
        source: n.publisher ?? null,
        url: n.link ?? null,
        publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
      };
      // Stories actually tagged with this ticker first.
      (n.relatedTickers?.includes(symbol) ? tagged : other).push(item);
    }
    return [...tagged, ...other];
  }

  private async google(query: string, lang: NewsLanguage): Promise<NewsItem[]> {
    const { hl, gl, ceid } = NEWS_LOCALES[lang];
    const xml = await this.http.getText(
      `${ENDPOINTS.googleNewsRss}?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${encodeURIComponent(ceid)}`,
    );
    return parseRss(xml).sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  }
}
