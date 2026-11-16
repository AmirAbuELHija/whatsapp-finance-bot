/** Small in-memory cache with a time-to-live and a size cap (oldest entries are dropped first). */
export class TtlCache<V> {
  private readonly entries = new Map<string, { at: number; value: V }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Remembers recent string keys (e.g. message ids) up to a fixed count. */
export class RecentSet {
  private readonly items = new Set<string>();

  constructor(private readonly capacity: number) {}

  add(key: string): void {
    this.items.add(key);
    if (this.items.size > this.capacity) {
      const oldest = this.items.values().next();
      if (!oldest.done) this.items.delete(oldest.value);
    }
  }

  has(key: string): boolean {
    return this.items.has(key);
  }
}
