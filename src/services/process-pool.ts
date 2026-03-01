import type { ChildProcess } from "node:child_process";

export interface ProcessPoolOptions {
  maxConcurrent: number;
  queueTimeoutMs: number;
  shutdownTimeoutMs: number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ProcessPool {
  private readonly maxConcurrent: number;
  private readonly queueTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private activeCount = 0;
  private readonly waitQueue: Waiter[] = [];
  private readonly tracked = new Set<ChildProcess>();
  private readonly closeListeners = new Map<ChildProcess, () => void>();
  private shuttingDown = false;
  private drainPromise: Promise<void> | null = null;
  private drainResolve: (() => void) | null = null;
  private escalationTimer: ReturnType<typeof setTimeout> | null = null;
  private hardStopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ProcessPoolOptions) {
    this.maxConcurrent = options.maxConcurrent;
    this.queueTimeoutMs = options.queueTimeoutMs;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get active(): number {
    return this.activeCount;
  }

  get queued(): number {
    return this.waitQueue.length;
  }

  acquire(): Promise<void> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("Server shutting down — no capacity"));
    }

    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waitQueue.indexOf(waiter);
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1);
        }
        reject(new Error("Pool queue timeout — no capacity"));
      }, this.queueTimeoutMs);
      timer.unref();

      const waiter: Waiter = { resolve, reject, timer };
      this.waitQueue.push(waiter);
    });
  }

  release(): void {
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve();
      return;
    }

    if (this.activeCount > 0) {
      this.activeCount--;
    }
  }

  track(child: ChildProcess): void {
    this.tracked.add(child);
    const onClose = () => {
      this.untrack(child);
    };
    this.closeListeners.set(child, onClose);
    child.once("close", onClose);
  }

  untrack(child: ChildProcess): void {
    const listener = this.closeListeners.get(child);
    if (listener) {
      child.removeListener("close", listener);
      this.closeListeners.delete(child);
    }
    this.tracked.delete(child);

    if (this.drainResolve && this.tracked.size === 0) {
      this.clearDrainTimers();
      this.drainResolve();
      this.drainResolve = null;
    }
  }

  private clearDrainTimers(): void {
    if (this.escalationTimer) {
      clearTimeout(this.escalationTimer);
      this.escalationTimer = null;
    }
    if (this.hardStopTimer) {
      clearTimeout(this.hardStopTimer);
      this.hardStopTimer = null;
    }
  }

  drainAll(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;

    this.shuttingDown = true;

    // Reject all queued waiters
    for (const waiter of this.waitQueue) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Server shutting down — no capacity"));
    }
    this.waitQueue.length = 0;

    // SIGTERM all tracked children
    for (const child of this.tracked) {
      child.kill("SIGTERM");
    }

    if (this.tracked.size === 0) {
      this.drainPromise = Promise.resolve();
      return this.drainPromise;
    }

    this.drainPromise = new Promise<void>((resolve) => {
      this.drainResolve = resolve;

      this.escalationTimer = setTimeout(() => {
        this.escalationTimer = null;
        for (const child of this.tracked) {
          child.kill("SIGKILL");
        }

        // Hard-stop: if children still haven't exited after another
        // shutdownTimeoutMs, force-clear tracked and resolve.
        this.hardStopTimer = setTimeout(() => {
          this.hardStopTimer = null;
          this.tracked.clear();
          if (this.drainResolve) {
            this.drainResolve();
            this.drainResolve = null;
          }
        }, this.shutdownTimeoutMs);
        this.hardStopTimer.unref();
      }, this.shutdownTimeoutMs);
      this.escalationTimer.unref();
    });

    return this.drainPromise;
  }

  destroy(): void {
    for (const waiter of this.waitQueue) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Pool destroyed"));
    }
    this.waitQueue.length = 0;

    for (const [child, listener] of this.closeListeners) {
      child.removeListener("close", listener);
    }
    this.closeListeners.clear();
    this.tracked.clear();
    this.activeCount = 0;
    this.clearDrainTimers();
    this.shuttingDown = false;
    this.drainPromise = null;
    this.drainResolve = null;
  }
}

export function killWithEscalation(
  child: ChildProcess,
  timeoutMs = 5000,
): void {
  child.kill("SIGTERM");

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref();

  child.once("close", () => {
    clearTimeout(timer);
  });
}
