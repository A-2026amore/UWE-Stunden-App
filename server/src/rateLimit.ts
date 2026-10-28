/**
 * Fixed-window in-memory rate limiter.
 *
 * Single-instance only: counters live in this process. Running several API
 * instances behind a load balancer would need a shared store (e.g. a table in
 * PostgreSQL) – documented in server/README.md.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(limit: number, windowMs: number, maxKeys = 50_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  /** Seconds until the key may try again, or 0 if it is below the limit. */
  blockedFor(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) return 0;
    return h.count >= this.limit ? Math.ceil((h.resetAt - now) / 1000) : 0;
  }

  /** Counts one hit. */
  hit(key: string, now = Date.now()): void {
    let h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      if (this.hits.size >= this.maxKeys) this.sweep(now);
      h = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, h);
    }
    h.count++;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    // Still full (attack with many keys): drop the oldest entries.
    if (this.hits.size >= this.maxKeys) {
      const drop = Math.ceil(this.maxKeys / 10);
      let i = 0;
      for (const k of this.hits.keys()) {
        if (i++ >= drop) break;
        this.hits.delete(k);
      }
    }
  }
}
