import { LIMITS, TIMING } from '../../config/constants.js';

/** Sliding-window limiter per sender, protecting the free AI quota from spam. 0 = unlimited. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = TIMING.rateLimitWindowMs,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): boolean {
    if (this.limit <= 0) return true;
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    const allowed = recent.length < this.limit;
    if (allowed) recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > LIMITS.rateLimiterMaxKeys) {
      const oldest = this.hits.keys().next();
      if (!oldest.done) this.hits.delete(oldest.value);
    }
    return allowed;
  }
}
