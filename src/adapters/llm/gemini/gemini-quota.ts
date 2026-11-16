/**
 * Free-tier quota bookkeeping. Google AI Studio gives each model its own small allowance
 * (requests per minute and per day). Counting requests locally lets the router skip a model that is out of
 * quota without wasting a call (and a few seconds) on a 429.
 */
import { GEMINI } from '../../../config/constants.js';

export interface ModelLimit {
  /** Requests per minute. */
  rpm: number;
  /** Requests per day (resets at midnight Pacific time). */
  rpd: number;
}

/** Where today's counts are kept between restarts. */
export interface QuotaStore {
  load(): { day?: string; counts?: Record<string, number> };
  save(state: { day: string; counts: Record<string, number> }): void;
}

const MINUTE_MS = 60_000;

/** The quota day, which Google resets at midnight in California. */
export function quotaDay(time: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: GEMINI.quotaTimeZone }).format(time);
}

export class QuotaTracker {
  private day: string;
  private counts: Record<string, number>;
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly limits: Readonly<Record<string, ModelLimit>> = {},
    private readonly now: () => number = Date.now,
    private readonly store?: QuotaStore,
  ) {
    this.day = quotaDay(this.now());
    const saved = store?.load() ?? {};
    this.counts = saved.day === this.day ? { ...(saved.counts ?? {}) } : {};
  }

  limit(model: string): ModelLimit | undefined {
    return this.limits[model];
  }

  /** False when a model with known limits has no requests left this minute or today. Unknown models: true. */
  hasRoom(model: string): boolean {
    const limit = this.limit(model);
    if (!limit) return true;
    this.rollDay();
    if ((this.counts[model] ?? 0) >= limit.rpd) return false;
    return this.lastMinute(model).length < limit.rpm;
  }

  /** Requests left today (Infinity when the limit is unknown). */
  left(model: string): number {
    const limit = this.limit(model);
    if (!limit) return Infinity;
    this.rollDay();
    return Math.max(0, limit.rpd - (this.counts[model] ?? 0));
  }

  record(model: string): void {
    this.rollDay();
    this.counts[model] = (this.counts[model] ?? 0) + 1;
    this.recent.set(model, [...this.lastMinute(model), this.now()]);
    this.persist();
  }

  /** Google said the daily quota is used up (our count was off, e.g. requests from AI Studio itself). */
  exhaustToday(model: string): void {
    this.rollDay();
    this.counts[model] = Math.max(this.counts[model] ?? 0, this.limit(model)?.rpd ?? Number.MAX_SAFE_INTEGER);
    this.persist();
  }

  /** Google said the per-minute quota is used up. */
  exhaustMinute(model: string): void {
    const rpm = this.limit(model)?.rpm ?? 1;
    this.recent.set(
      model,
      Array.from({ length: rpm }, () => this.now()),
    );
  }

  /** Today's usage of every model with known limits (for the check script). */
  usage(): { model: string; used: number; limit: ModelLimit }[] {
    this.rollDay();
    return Object.entries(this.limits)
      .filter(([, limit]) => limit.rpd > 0)
      .map(([model, limit]) => ({ model, used: this.counts[model] ?? 0, limit }));
  }

  private lastMinute(model: string): number[] {
    const since = this.now() - MINUTE_MS;
    const times = (this.recent.get(model) ?? []).filter((t) => t > since);
    this.recent.set(model, times);
    return times;
  }

  private rollDay(): void {
    const today = quotaDay(this.now());
    if (today === this.day) return;
    this.day = today;
    this.counts = {};
    this.persist();
  }

  private persist(): void {
    this.store?.save({ day: this.day, counts: this.counts });
  }
}
