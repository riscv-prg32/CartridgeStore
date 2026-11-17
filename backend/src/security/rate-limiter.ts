export interface RateLimitEntry {
  count: number;
  startedAt: number;
}

/**
 * A process-local fixed-window limiter with bounded memory.
 *
 * Active entries are never evicted to make room for a new key. Once the
 * bounded registry is full, a new key is rejected until an expired entry is
 * observed and removed. This prevents high-cardinality sources from evicting
 * an active source's protection.
 */
export class BoundedRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(
    private readonly max: number,
    private readonly windowSeconds: number,
    private readonly maxEntries: number
  ) {
    if (!Number.isSafeInteger(max) || max <= 0) throw new Error("rate limiter max must be positive");
    if (!Number.isSafeInteger(windowSeconds) || windowSeconds <= 0) throw new Error("rate limiter window must be positive");
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error("rate limiter capacity must be positive");
  }

  allow(key: string, now = Date.now()): boolean {
    this.removeExpired(now);
    const current = this.entries.get(key);
    if (!current) {
      if (this.entries.size >= this.maxEntries) return false;
      this.entries.set(key, { count: 1, startedAt: now });
      return true;
    }
    if (now - current.startedAt >= this.windowSeconds * 1000) {
      current.count = 1;
      current.startedAt = now;
      return true;
    }
    current.count += 1;
    return current.count <= this.max;
  }

  clear(now = Date.now()): void {
    this.removeExpired(now);
  }

  get size(): number {
    return this.entries.size;
  }

  private removeExpired(now: number): void {
    const windowMs = this.windowSeconds * 1000;
    for (const [key, entry] of this.entries) {
      if (now - entry.startedAt >= windowMs) this.entries.delete(key);
    }
  }
}
