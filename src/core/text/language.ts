import type { NewsLanguage } from '../../config/reference-data.js';
import { LANGUAGE_WORDS } from '../../config/reference-data.js';

/** "" means "auto" (answer in the user's language); otherwise a language name such as "English". */
export function languageName(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!v || /^auto$/i.test(v)) return '';
  return LANGUAGE_WORDS[v.toLowerCase()] ?? v.charAt(0).toUpperCase() + v.slice(1);
}

/** Language word ("he", "עברית", "arabic"...) → language name, or undefined. */
export const languageFromWord = (word: string): string | undefined => LANGUAGE_WORDS[word.toLowerCase()];

/** Script-based guess, good enough to pick a news edition. */
export function detectScriptLanguage(text: string): NewsLanguage {
  if (/[֐-׿]/.test(text)) return 'he';
  if (/[؀-ۿ]/.test(text)) return 'ar';
  return 'en';
}

export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
