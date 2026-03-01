import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  ProcessPool,
  killWithEscalation,
} from "../../src/services/process-pool.js";

/**
 * Creates a mock ChildProcess backed by EventEmitter.
 * kill() is a mock that records calls but does NOT auto-emit close.
 * Tests emit close events manually for full control with fake timers.
 */
function createMockChild(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  (emitter as { kill: (signal?: string) => boolean }).kill = vi.fn(() => true);
  return emitter;
}

describe("ProcessPool", () => {
  let pool: ProcessPool;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    pool?.destroy();
    vi.useRealTimers();
  });

  describe("acquire / release", () => {
    it("allows acquire up to maxConcurrent and tracks active count", async () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 10000,
      });

      expect(pool.active).toBe(0);
      await pool.acquire();
      expect(pool.active).toBe(1);
      await pool.acquire();
      expect(pool.active).toBe(2);
    });

    it("rejects with capacity error when all slots taken and queue times out", async () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 10000,
      });

      await pool.acquire();
      await pool.acquire();

      const third = pool.acquire();

      vi.advanceTimersByTime(5000);

      await expect(third).rejects.toThrow("capacity");
    });

    it("rejects queued waiter after queueTimeoutMs", async () => {
      pool = new ProcessPool({
        maxConcurrent: 1,
        queueTimeoutMs: 1000,
        shutdownTimeoutMs: 10000,
      });

      await pool.acquire();

      const queued = pool.acquire();

      vi.advanceTimersByTime(1000);

      await expect(queued).rejects.toThrow("capacity");
    });

    it("release wakes the oldest queued waiter", async () => {
      pool = new ProcessPool({
        maxConcurrent: 1,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 10000,
      });

      await pool.acquire();

      const queued = pool.acquire();

      pool.release();

      await expect(queued).resolves.toBeUndefined();
      expect(pool.active).toBe(1);
    });

    it("release decrements active count when no waiters", async () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 10000,
      });

      await pool.acquire();
      await pool.acquire();
      expect(pool.active).toBe(2);

      pool.release();
      expect(pool.active).toBe(1);

      pool.release();
      expect(pool.active).toBe(0);
    });

    it("release does not go below zero", () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 10000,
      });

      pool.release();
      pool.release();
      expect(pool.active).toBe(0);
    });

    it("pool slot is released in finally block even after error", async () => {
      pool = new ProcessPool({
        maxConcurrent: 1,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 10000,
      });

      try {
        await pool.acquire();
        throw new Error("simulated error");
      } catch {
        // expected
      } finally {
        pool.release();
      }

      await expect(pool.acquire()).resolves.toBeUndefined();
      expect(pool.active).toBe(1);
    });
  });

  describe("track / untrack", () => {
    it("auto-untracks child when close event fires", async () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 10000,
      });

      const child1 = createMockChild();
      const child2 = createMockChild();
      pool.track(child1);
      pool.track(child2);

      // child1 exits
      child1.emit("close", 0, null);

      // drainAll should only SIGTERM child2 (child1 already untracked)
      const drainPromise = pool.drainAll();

      expect(child1.kill).not.toHaveBeenCalled();
      expect(child2.kill).toHaveBeenCalledWith("SIGTERM");

      child2.emit("close", 0, "SIGTERM");
      await drainPromise;
    });

    it("manual untrack removes child from tracked set", async () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 10000,
      });

      const child = createMockChild();
      pool.track(child);
      pool.untrack(child);

      // drainAll resolves immediately — no children tracked
      await pool.drainAll();
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

  describe("drainAll", () => {
    it("SIGTERMs all tracked children and resolves when all exit", async () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 10000,
      });

      const child1 = createMockChild();
      const child2 = createMockChild();
      pool.track(child1);
      pool.track(child2);

      const drainPromise = pool.drainAll();

      expect(child1.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child2.kill).toHaveBeenCalledWith("SIGTERM");

      child1.emit("close", 0, "SIGTERM");
      child2.emit("close", 0, "SIGTERM");

      await drainPromise;
    });

    it("resolves immediately when no children are tracked", async () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 10000,
      });

      await pool.drainAll();
      expect(pool.isShuttingDown).toBe(true);
    });

    it("rejects all queued waiters with capacity error", async () => {
      pool = new ProcessPool({
        maxConcurrent: 1,
        queueTimeoutMs: 30000,
        shutdownTimeoutMs: 10000,
      });

      await pool.acquire();

      const waiter = pool.acquire();

      await pool.drainAll();

      await expect(waiter).rejects.toThrow("capacity");
    });

    it("SIGKILLs survivors after shutdownTimeoutMs", async () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 3000,
      });

      const child1 = createMockChild();
      const child2 = createMockChild();
      pool.track(child1);
      pool.track(child2);

      const drainPromise = pool.drainAll();

      // child1 exits promptly after SIGTERM
      child1.emit("close", 0, "SIGTERM");

      // child2 does NOT exit — advance to SIGKILL escalation
      vi.advanceTimersByTime(3000);

      // child2 should have received SIGKILL; child1 should not (already untracked)
      expect(child2.kill).toHaveBeenCalledWith("SIGKILL");
      expect(child1.kill).toHaveBeenCalledTimes(1); // only SIGTERM
      expect(child1.kill).not.toHaveBeenCalledWith("SIGKILL");

      // child2 finally exits after SIGKILL
      child2.emit("close", null, "SIGKILL");

      await drainPromise;
    });

    it("force-resolves after 2x shutdownTimeoutMs when child ignores SIGTERM and SIGKILL", async () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 3000,
      });

      const child = createMockChild();
      pool.track(child);

      const drainPromise = pool.drainAll();

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      // Child ignores SIGTERM — advance to SIGKILL escalation
      vi.advanceTimersByTime(3000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");

      // Child ignores SIGKILL — advance to hard-stop force-clear
      vi.advanceTimersByTime(3000);

      // drainAll should resolve despite child never emitting close
      await drainPromise;
    });

    it("clears escalation timer when all children exit before escalation", async () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 3000,
      });

      const child = createMockChild();
      pool.track(child);

      const drainPromise = pool.drainAll();

      // Child exits promptly
      child.emit("close", 0, "SIGTERM");
      await drainPromise;

      // Advance past escalation timeout — SIGKILL should NOT be sent
      vi.advanceTimersByTime(3000);
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    });

    it("is idempotent — second call returns same promise, no double-SIGTERM or double-rejection", async () => {
      pool = new ProcessPool({
        maxConcurrent: 1,
        queueTimeoutMs: 30000,
        shutdownTimeoutMs: 10000,
      });

      await pool.acquire();
      const child = createMockChild();
      pool.track(child);

      const waiter = pool.acquire();

      const drain1 = pool.drainAll();
      const drain2 = pool.drainAll();

      // Same promise returned
      expect(drain1).toBe(drain2);

      // SIGTERM called only once
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      // Waiter rejected
      await expect(waiter).rejects.toThrow("capacity");

      // Resolve drain
      child.emit("close", 0, "SIGTERM");
      await drain1;
    });
  });

  describe("shutdown behavior", () => {
    it("acquire rejects immediately when shutting down", async () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 10000,
      });

      await pool.drainAll();

      await expect(pool.acquire()).rejects.toThrow("capacity");
    });

    it("isShuttingDown is false initially and true after drainAll", async () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 10000,
      });

      expect(pool.isShuttingDown).toBe(false);

      await pool.drainAll();

      expect(pool.isShuttingDown).toBe(true);
    });
  });

  describe("destroy", () => {
    it("rejects queued waiters and resets state", async () => {
      pool = new ProcessPool({
        maxConcurrent: 1,
        queueTimeoutMs: 30000,
        shutdownTimeoutMs: 10000,
      });

      await pool.acquire();

      const queued = pool.acquire();

      pool.destroy();

      await expect(queued).rejects.toThrow("destroyed");
      expect(pool.active).toBe(0);
    });

    it("pool is reusable after destroy — can track and acquire again", async () => {
      pool = new ProcessPool({
        maxConcurrent: 2,
        queueTimeoutMs: 5000,
        shutdownTimeoutMs: 10000,
      });

      // Use the pool, then drain it (sets shuttingDown = true)
      const child1 = createMockChild();
      pool.track(child1);
      await pool.acquire();

      const drainPromise = pool.drainAll();
      child1.emit("close", 0, "SIGTERM");
      await drainPromise;

      expect(pool.isShuttingDown).toBe(true);

      // destroy resets everything
      pool.destroy();

      expect(pool.isShuttingDown).toBe(false);

      // Pool should be fully functional again
      await expect(pool.acquire()).resolves.toBeUndefined();
      expect(pool.active).toBe(1);

      const child2 = createMockChild();
      pool.track(child2);

      // Can drain again cleanly
      const drain2 = pool.drainAll();
      child2.emit("close", 0, "SIGTERM");
      await drain2;
    });
  });
});

describe("killWithEscalation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends SIGTERM and clears SIGKILL timer when child exits within timeout", () => {
    const child = createMockChild();

    killWithEscalation(child, 5000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    // Child exits before timeout
    child.emit("close", 0, "SIGTERM");

    // Advance past timeout
    vi.advanceTimersByTime(5000);

    // SIGKILL should NOT have been sent
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("sends SIGKILL after timeout when child does not exit", () => {
    const child = createMockChild();

    killWithEscalation(child, 5000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    // Advance past timeout without child exiting
    vi.advanceTimersByTime(5000);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.kill).toHaveBeenCalledTimes(2);
  });
});
