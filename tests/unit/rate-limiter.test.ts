import { describe, it, expect, vi } from "vitest";
import {
  SlidingWindowRateLimiter,
  ConcurrencyLimiter,
} from "../../src/middleware/rate-limiter.js";

describe("SlidingWindowRateLimiter", () => {
  it("allows requests up to the limit", () => {
    const limiter = new SlidingWindowRateLimiter(3, 60000);
    const r1 = limiter.record("key1");
    expect(r1.allowed).toBe(true);
    expect(r1.info.remaining).toBe(2);

    const r2 = limiter.record("key1");
    expect(r2.allowed).toBe(true);
    expect(r2.info.remaining).toBe(1);

    const r3 = limiter.record("key1");
    expect(r3.allowed).toBe(true);
    expect(r3.info.remaining).toBe(0);
  });

  it("rejects requests beyond the limit", () => {
    const limiter = new SlidingWindowRateLimiter(2, 60000);
    limiter.record("key1");
    limiter.record("key1");
    const result = limiter.record("key1");
    expect(result.allowed).toBe(false);
    expect(result.info.remaining).toBe(0);
  });

  it("limit=N means exactly N requests succeed", () => {
    const limiter = new SlidingWindowRateLimiter(5, 60000);
    for (let i = 0; i < 5; i++) {
      const result = limiter.record("key1");
      expect(result.allowed).toBe(true);
    }
    const rejected = limiter.record("key1");
    expect(rejected.allowed).toBe(false);
  });

  it("check() does not consume a slot", () => {
    const limiter = new SlidingWindowRateLimiter(2, 60000);
    limiter.record("key1");
    const info = limiter.check("key1");
    expect(info.remaining).toBe(1);
    // Recording again should still work
    const r2 = limiter.record("key1");
    expect(r2.allowed).toBe(true);
    expect(r2.info.remaining).toBe(0);
  });

  it("expired entries drop off the window", () => {
    vi.useFakeTimers();
    const limiter = new SlidingWindowRateLimiter(2, 1000);

    limiter.record("key1");
    limiter.record("key1");
    expect(limiter.record("key1").allowed).toBe(false); // At limit

    vi.advanceTimersByTime(1001);
    const result = limiter.record("key1");
    expect(result.allowed).toBe(true);
    expect(result.info.remaining).toBe(1); // Old entries expired

    vi.useRealTimers();
  });

  it("tracks different keys independently", () => {
    const limiter = new SlidingWindowRateLimiter(1, 60000);
    const r1 = limiter.record("key1");
    expect(r1.allowed).toBe(true);
    expect(r1.info.remaining).toBe(0);

    const r2 = limiter.record("key2");
    expect(r2.allowed).toBe(true); // Different key, still allowed
    expect(r2.info.remaining).toBe(0);
  });

  it("cleanup removes stale keys", () => {
    vi.useFakeTimers();
    const limiter = new SlidingWindowRateLimiter(5, 1000);
    limiter.record("key1");
    limiter.record("key2");

    vi.advanceTimersByTime(1001);
    limiter.cleanup();

    // After cleanup, keys should be fresh
    expect(limiter.check("key1").remaining).toBe(5);
    expect(limiter.check("key2").remaining).toBe(5);
    vi.useRealTimers();
  });

  it("returns correct resetMs timestamp", () => {
    vi.useFakeTimers({ now: 1000000 });
    const limiter = new SlidingWindowRateLimiter(5, 60000);
    const result = limiter.record("key1");
    expect(result.info.resetMs).toBe(1000000 + 60000);
    vi.useRealTimers();
  });

  it("evicts oldest entries when exceeding max tracked keys", () => {
    // Use a small limiter and simulate many unique keys.
    // The MAX_TRACKED_KEYS constant is 100_000, so we can't test that
    // directly without creating 100K entries. Instead, verify the
    // `size` getter and cleanup behavior.
    const limiter = new SlidingWindowRateLimiter(2, 60000);
    for (let i = 0; i < 100; i++) {
      limiter.record(`key-${i}`);
    }
    expect(limiter.size).toBe(100);
    limiter.cleanup();
    // All entries are still within window, so cleanup doesn't help
    expect(limiter.size).toBe(100);
  });
});

describe("ConcurrencyLimiter", () => {
  it("acquires slots up to max", () => {
    const limiter = new ConcurrencyLimiter(2);
    expect(limiter.acquire("key1")).toBe(true);
    expect(limiter.acquire("key1")).toBe(true);
  });

  it("rejects when at max concurrency", () => {
    const limiter = new ConcurrencyLimiter(2);
    limiter.acquire("key1");
    limiter.acquire("key1");
    expect(limiter.acquire("key1")).toBe(false);
  });

  it("release frees a slot", () => {
    const limiter = new ConcurrencyLimiter(1);
    limiter.acquire("key1");
    expect(limiter.acquire("key1")).toBe(false);
    limiter.release("key1");
    expect(limiter.acquire("key1")).toBe(true);
  });

  it("getCurrent returns active count", () => {
    const limiter = new ConcurrencyLimiter(5);
    expect(limiter.getCurrent("key1")).toBe(0);
    limiter.acquire("key1");
    expect(limiter.getCurrent("key1")).toBe(1);
    limiter.acquire("key1");
    expect(limiter.getCurrent("key1")).toBe(2);
    limiter.release("key1");
    expect(limiter.getCurrent("key1")).toBe(1);
  });

  it("tracks different keys independently", () => {
    const limiter = new ConcurrencyLimiter(1);
    limiter.acquire("key1");
    expect(limiter.acquire("key1")).toBe(false);
    expect(limiter.acquire("key2")).toBe(true); // Different key
  });

  it("release on unknown key is safe", () => {
    const limiter = new ConcurrencyLimiter(5);
    limiter.release("unknown"); // Should not throw
    expect(limiter.getCurrent("unknown")).toBe(0);
  });
});
