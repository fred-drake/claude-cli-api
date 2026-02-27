import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RequestContext } from "../../src/backends/types.js";
import { ClaudeCodeBackend } from "../../src/backends/claude-code.js";
import type { ClaudeCodeOptions } from "../../src/backends/claude-code.js";
import { SessionManager } from "../../src/services/session-manager.js";
import {
  sampleNdjsonStream,
  sampleStreamRequest,
  createStreamingMockChildProcess,
  collectCallbacks,
} from "../helpers/index.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

function defaultOptions(): ClaudeCodeOptions {
  return { cliPath: "/usr/bin/claude", enabled: true };
}

function defaultSessionManager(): SessionManager {
  return new SessionManager({
    sessionTtlMs: 3_600_000,
    maxSessionAgeMs: 86_400_000,
    cleanupIntervalMs: 60_000,
  });
}

function defaultContext(
  overrides: Partial<RequestContext> = {},
): RequestContext {
  return {
    requestId: "req-001",
    clientIp: "127.0.0.1",
    method: "POST",
    path: "/v1/chat/completions",
    apiKey: "test-key",
    ...overrides,
  };
}

describe("client disconnect → SIGTERM", () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionManager = defaultSessionManager();
  });

  afterEach(() => {
    sessionManager?.destroy();
  });

  it("abort signal kills the child process with SIGTERM", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const controller = new AbortController();
    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const { callbacks } = collectCallbacks();

    const streamPromise = backend.completeStream(
      sampleStreamRequest,
      defaultContext({ signal: controller.signal }),
      callbacks,
    );

    // Abort immediately — triggers SIGTERM
    controller.abort();

    await streamPromise;

    expect(child.killed).toBe(true);
  });

  it("abort after process already exited is a no-op", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const controller = new AbortController();
    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const { callbacks } = collectCallbacks();

    // Wait for stream to complete normally
    await backend.completeStream(
      sampleStreamRequest,
      defaultContext({ signal: controller.signal }),
      callbacks,
    );

    // Abort after process has exited — should be no-op
    controller.abort();

    // No error should have been thrown
    expect(child.killed).toBe(false);
  });

  it("abort listener is cleaned up on process close", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const controller = new AbortController();
    const removeListenerSpy = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const { callbacks } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext({ signal: controller.signal }),
      callbacks,
    );

    expect(removeListenerSpy).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
  });

  it("completeStream works without signal (no abort wiring)", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const { callbacks, getDoneMetadata } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(), // no signal
      callbacks,
    );

    expect(getDoneMetadata()).toBeDefined();
  });
});
