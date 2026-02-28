export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetMs: number; // Unix milliseconds timestamp when current window resets
}

/**
 * Result from record(): `allowed` indicates whether the request was accepted
 * and recorded, or rejected (not recorded) because the limit was already reached.
 */
export interface RateLimitResult {
  allowed: boolean;
  info: RateLimitInfo;
}

/**
 * Maximum number of unique keys tracked before forced eviction.
 * Prevents unbounded memory growth under distributed attacks.
 */
const MAX_TRACKED_KEYS = 100_000;

/**
 * Sliding window rate limiter. Tracks request timestamps per key
 * and enforces a maximum number of requests within a time window.
 */
export class SlidingWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly requests = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /**
   * Peek at rate limit status without recording a request.
   */
  check(key: string): RateLimitInfo {
    const now = Date.now();
    const timestamps = this.getValidTimestamps(key, now);
    return {
      limit: this.limit,
      remaining: Math.max(0, this.limit - timestamps.length),
      resetMs:
        timestamps.length > 0
          ? timestamps[0]! + this.windowMs
          : now + this.windowMs,
    };
  }

  /**
   * Record a request and return whether it was allowed.
   * When `allowed` is true, the request was recorded and counted.
   * When `allowed` is false, the key is at capacity and the request
   * was NOT recorded — the caller should reject the request.
   */
  record(key: string): RateLimitResult {
    const now = Date.now();

    // Evict stale entries if map is getting large
    if (this.requests.size > MAX_TRACKED_KEYS) {
      this.cleanup();
      // If still over limit after cleanup, evict oldest entries
      if (this.requests.size > MAX_TRACKED_KEYS) {
        const toEvict = this.requests.size - MAX_TRACKED_KEYS + 1000;
        let evicted = 0;
        for (const evictKey of this.requests.keys()) {
          if (evicted >= toEvict) break;
          this.requests.delete(evictKey);
          evicted++;
        }
      }
    }

    const timestamps = this.getValidTimestamps(key, now);

    if (timestamps.length >= this.limit) {
      this.requests.set(key, timestamps);
      return {
        allowed: false,
        info: {
          limit: this.limit,
          remaining: 0,
          resetMs: timestamps[0]! + this.windowMs,
        },
      };
    }

    timestamps.push(now);
    this.requests.set(key, timestamps);
    return {
      allowed: true,
      info: {
        limit: this.limit,
        remaining: this.limit - timestamps.length,
        resetMs: timestamps[0]! + this.windowMs,
      },
    };
  }

  /**
   * Remove expired entries from all keys.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.requests) {
      const valid = timestamps.filter((t) => now - t < this.windowMs);
      if (valid.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, valid);
      }
    }
  }

  /** Number of unique keys currently tracked. Exposed for testing. */
  get size(): number {
    return this.requests.size;
  }

  destroy(): void {
    this.requests.clear();
  }

  private getValidTimestamps(key: string, now: number): number[] {
    const timestamps = this.requests.get(key) ?? [];
    return timestamps.filter((t) => now - t < this.windowMs);
  }
}

/**
 * Concurrency limiter. Tracks active requests per key
 * and enforces a maximum concurrent request count.
 */
export class ConcurrencyLimiter {
  private readonly maxConcurrent: number;
  private readonly active = new Map<string, number>();

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Try to acquire a concurrency slot. Returns true if successful.
   */
  acquire(key: string): boolean {
    const current = this.active.get(key) ?? 0;
    if (current >= this.maxConcurrent) {
      return false;
    }
    this.active.set(key, current + 1);
    return true;
  }

  /**
   * Release a concurrency slot.
   */
  release(key: string): void {
    const current = this.active.get(key) ?? 0;
    if (current <= 1) {
      this.active.delete(key);
    } else {
      this.active.set(key, current - 1);
    }
  }

  getCurrent(key: string): number {
    return this.active.get(key) ?? 0;
  }

  destroy(): void {
    this.active.clear();
  }
}
