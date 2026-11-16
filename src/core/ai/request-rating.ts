/**
 * Rates how much reasoning a request needs, from 1 (greeting, simple lookup) to 10 (deep multi-step analysis).
 * The Gemini router uses the score to pick a model before calling it.
 */

export const MIN_SCORE = 1;
export const MAX_SCORE = 10;
const BASE_SCORE = 4;

export interface RequestRater {
  /** Returns a score from 1 to 10. Never throws. */
  rate(text: string): Promise<RatedRequest>;
}

export interface RatedRequest {
  score: number;
  source: 'ai' | 'heuristic';
}

export const clampScore = (n: number): number => Math.min(MAX_SCORE, Math.max(MIN_SCORE, Math.round(n)));

/** Asking for reasoning: explanations, comparisons, analysis, plans, advice (English, Hebrew, Arabic). */
const REASONING =
  /\b(explain|why|compare|comparison|versus|vs\.?|analy[sz]e|analysis|strategy|pros and cons|difference|recommend|should i|plan|evaluate|in depth|step by step|think)\b|תסביר|הסבר|למה|מדוע|השווה|השוואה|תנתח|ניתוח|אסטרטגיה|כדאי|תכנן|اشرح|لماذا|قارن|مقارنة|حلل|تحليل|استراتيجية|هل يجب|خطة/i;

/** Asking for depth on top of reasoning. */
const DEEP =
  /\b(detailed|thorough|full analysis|deep dive|portfolio|forecast|scenario|risks?)\b|מפורט|לעומק|תיק השקעות|תחזית|سيناريو|بالتفصيل|محفظة|توقعات/i;

/** Quick lookups and small talk. */
const LOOKUP =
  /\b(price|quote|how much|convert|rate|news|hi|hello|hey|thanks|thank you|ok|good morning)\b|מחיר|כמה|שער|חדשות|היי|שלום|תודה|سعر|كم|أخبار|مرحبا|شكرا/i;

const SHORT_CHARS = 60;
const MEDIUM_CHARS = 150;
const LONG_CHARS = 280;

/** Instant, free estimate from the text alone. */
export function heuristicScore(text: string): number {
  const t = text.trim();
  let score = BASE_SCORE;
  if (REASONING.test(t)) score += 3;
  if (DEEP.test(t)) score += 2;
  if (t.length > MEDIUM_CHARS) score += 1;
  if (t.length > LONG_CHARS) score += 1;
  if ((t.match(/[?؟]/g) ?? []).length >= 2) score += 1;
  if (t.length <= SHORT_CHARS && LOOKUP.test(t) && !REASONING.test(t)) score -= 2;
  return clampScore(score);
}

export class HeuristicRater implements RequestRater {
  rate(text: string): Promise<RatedRequest> {
    return Promise.resolve({ score: heuristicScore(text), source: 'heuristic' });
  }
}

/** Reads the first whole number 1-10 from a model's reply, or null. */
export function parseScore(reply: string): number | null {
  const match = /\b(10|[1-9])\b/.exec(reply);
  return match ? Number(match[1]) : null;
}
