import { vi, afterEach, beforeEach } from "vitest";

export function useFakeTimers() {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

export async function advanceTimersByMs(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

export async function runAllTimers(): Promise<void> {
  await vi.runAllTimersAsync();
}
