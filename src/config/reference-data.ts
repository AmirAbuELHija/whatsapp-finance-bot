/** Reference data used to interpret user input: ticker shortcuts, currencies, news feeds and languages. */

/** Friendly names → Yahoo Finance symbols. */
export const SYMBOL_ALIASES: Readonly<Record<string, string>> = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
  XRP: 'XRP-USD',
  DOGE: 'DOGE-USD',
  SPX: '^GSPC',
  SP500: '^GSPC',
  'S&P500': '^GSPC',
  'S&P': '^GSPC',
  NASDAQ: '^IXIC',
  NDX: '^NDX',
  DOW: '^DJI',
  DJI: '^DJI',
  VIX: '^VIX',
  TA35: 'TA35.TA',
  'TA-35': 'TA35.TA',
  TA125: '^TA125.TA',
  'TA-125': '^TA125.TA',
  GOLD: 'GC=F',
  SILVER: 'SI=F',
  OIL: 'CL=F',
  BRENT: 'BZ=F',
};

export const CRYPTO_CODES: ReadonlySet<string> = new Set([
  'BTC',
  'ETH',
  'SOL',
  'XRP',
  'ADA',
  'DOGE',
  'BNB',
  'USDT',
  'USDC',
  'LTC',
  'DOT',
  'AVAX',
  'TRX',
  'LINK',
]);

export const FIAT_CODES: ReadonlySet<string> = new Set([
  'USD',
  'EUR',
  'ILS',
  'GBP',
  'JPY',
  'CHF',
  'CAD',
  'AUD',
  'NZD',
  'CNY',
  'HKD',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'TRY',
  'INR',
  'BRL',
  'MXN',
  'ZAR',
  'SGD',
  'KRW',
  'JOD',
  'EGP',
  'AED',
  'SAR',
  'CZK',
  'HUF',
  'RON',
  'THB',
]);

/** Yahoo quotes Tel Aviv stocks in agorot (ILA); 100 agorot = 1 shekel. */
export const MINOR_CURRENCIES: Readonly<Record<string, { major: string; factor: number }>> = {
  ILA: { major: 'ILS', factor: 0.01 },
};

/** Chart range → bar interval. */
export const HISTORY_RANGES = {
  '5d': '1d',
  '1mo': '1d',
  '3mo': '1d',
  '6mo': '1d',
  ytd: '1d',
  '1y': '1d',
  '2y': '1wk',
  '5y': '1wk',
  '10y': '1mo',
  max: '1mo',
} as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;
export const DEFAULT_HISTORY_RANGE: HistoryRange = '1mo';

export type NewsLanguage = 'en' | 'he' | 'ar';

export const NEWS_LOCALES: Readonly<Record<NewsLanguage, { hl: string; gl: string; ceid: string }>> = {
  en: { hl: 'en-US', gl: 'US', ceid: 'US:en' },
  he: { hl: 'he', gl: 'IL', ceid: 'IL:he' },
  ar: { hl: 'ar', gl: 'EG', ceid: 'EG:ar' },
};

export interface NewsPreset {
  label: string;
  query: string;
  lang: NewsLanguage;
}

/** "/news" alone, or "/news il" for the Tel Aviv market in Hebrew. */
export const NEWS_PRESETS: Readonly<Record<string, NewsPreset>> = {
  '': { label: 'Markets', query: 'stock market when:1d', lang: 'en' },
  market: { label: 'Markets', query: 'stock market when:1d', lang: 'en' },
  us: { label: 'US markets', query: 'Wall Street stocks when:1d', lang: 'en' },
  il: { label: 'בורסת תל אביב', query: 'בורסה תל אביב when:2d', lang: 'he' },
  tase: { label: 'בורסת תל אביב', query: 'בורסה תל אביב when:2d', lang: 'he' },
  crypto: { label: 'Crypto', query: 'crypto bitcoin when:1d', lang: 'en' },
};
export const NEWS_TOPIC_WINDOW = 'when:3d';

/** Words people may use to pick a language, mapped to the language name the AI understands. */
export const LANGUAGE_WORDS: Readonly<Record<string, string>> = {
  en: 'English',
  english: 'English',
  eng: 'English',
  he: 'Hebrew',
  heb: 'Hebrew',
  hebrew: 'Hebrew',
  עברית: 'Hebrew',
  בעברית: 'Hebrew',
  ar: 'Arabic',
  arabic: 'Arabic',
  عربي: 'Arabic',
  عربية: 'Arabic',
  بالعربي: 'Arabic',
  بالعربية: 'Arabic',
};

/** What "@bot summary" shows. Yahoo symbols; labels as printed on the slides. */
export const SUMMARY = {
  indexes: [
    { symbol: '^IXIC', label: 'Nasdaq Composite' },
    { symbol: '^GSPC', label: 'S&P 500' },
    { symbol: '^DJI', label: 'Dow Jones' },
  ],
  vix: { symbol: '^VIX', label: 'VIX' },
  /** Select Sector SPDR ETFs: the day's move of each S&P 500 sector. */
  sectors: [
    { symbol: 'XLK', label: 'Tech' },
    { symbol: 'XLC', label: 'Communication' },
    { symbol: 'XLY', label: 'Discretionary' },
    { symbol: 'XLF', label: 'Financials' },
    { symbol: 'XLV', label: 'Health care' },
    { symbol: 'XLI', label: 'Industrials' },
    { symbol: 'XLE', label: 'Energy' },
    { symbol: 'XLB', label: 'Materials' },
    { symbol: 'XLRE', label: 'Real estate' },
    { symbol: 'XLU', label: 'Utilities' },
    { symbol: 'XLP', label: 'Staples' },
  ],
  /** Default watchlist for "biggest moves" (SUMMARY_WATCHLIST overrides it). */
  watchlist: [
    'NVDA',
    'AAPL',
    'MSFT',
    'AMZN',
    'GOOGL',
    'META',
    'TSLA',
    'AVGO',
    'AMD',
    'NFLX',
    'PLTR',
    'INTC',
    'MU',
    'ORCL',
    'JPM',
    'LLY',
    'COST',
    'XOM',
    'TEVA',
    'COIN',
  ],
  assets: [
    { symbol: 'CL=F', label: 'Oil (WTI)' },
    { symbol: 'GC=F', label: 'Gold' },
    { symbol: 'BTC-USD', label: 'Bitcoin' },
    { symbol: '^TNX', label: '10-yr yield' },
    { symbol: 'USDILS=X', label: 'USD/ILS' },
  ],
  trend: { symbol: '^IXIC', label: 'Nasdaq', range: '6mo' },
  /** Parallel requests to the market-data source. */
  /** Quotes fetched at the same time (Yahoo throttles cloud servers that ask for too many at once). */
  concurrency: 4,
} as const;
