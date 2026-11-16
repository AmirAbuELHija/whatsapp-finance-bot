import { CRYPTO_CODES, FIAT_CODES, SYMBOL_ALIASES } from '../../config/reference-data.js';
import { UserInputError } from '../../core/errors.js';

const TICKER_CHARS = /^[A-Z0-9^=.\-/&]{1,20}$/;
const SLASH_PAIR = /^([A-Z]{3,5})\/([A-Z]{3})$/;
const JOINED_PAIR = /^([A-Z]{3})([A-Z]{3})$/;

export const isCrypto = (code: string): boolean => CRYPTO_CODES.has(code);

/** User input ("btc", "usd/ils", "teva.ta") → Yahoo Finance symbol. */
export function normalizeSymbol(input: unknown): string {
  const s = (typeof input === 'string' ? input : '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) throw new UserInputError('A ticker symbol is required');
  if (!TICKER_CHARS.test(s)) throw new UserInputError(`"${String(input)}" doesn't look like a ticker`);
  const alias = SYMBOL_ALIASES[s];
  if (alias) return alias;
  const pair = SLASH_PAIR.exec(s) ?? JOINED_PAIR.exec(s);
  if (pair) {
    const [, base = '', quote = ''] = pair;
    if (isCrypto(base)) return `${base}-${quote}`;
    if (FIAT_CODES.has(base) && FIAT_CODES.has(quote)) return `${base}${quote}=X`;
  }
  return s;
}

/** Yahoo symbol for converting between two currency codes. */
export const conversionSymbol = (from: string, to: string): string =>
  isCrypto(from) ? `${from}-${to}` : `${from}${to}=X`;
