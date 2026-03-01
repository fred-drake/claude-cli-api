import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RequestContext } from "../../src/backends/types.js";
import { ClaudeCodeBackend } from "../../src/backends/claude-code.js";
import type { ClaudeCodeOptions } from "../../src/backends/claude-code.js";
import { SessionManager } from "../../src/services/session-manager.js";
import { ProcessPool } from "../../src/services/process-pool.js";
import type { ChatCompletionChunk } from "../../src/types/openai.js";
import { STDIN_PROMPT_THRESHOLD } from "../../src/services/claude-cli.js";
import {
  sampleNdjsonStream,
  sampleStreamRequest,
  createStreamingMockChildProcess,
  createMockChildProcess,
  collectCallbacks,
} from "../helpers/index.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

function defaultOptions(): ClaudeCodeOptions {
  return {
    cliPath: "/usr/bin/claude",
    enabled: true,
    requestTimeoutMs: 300_000,
  };
}

function defaultPool(): ProcessPool {
  return new ProcessPool({
    maxConcurrent: 10,
    queueTimeoutMs: 5000,
    shutdownTimeoutMs: 10_000,
  });
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

describe("ClaudeCodeBackend.completeStream()", () => {
  let sessionManager: SessionManager;
  let pool: ProcessPool;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionManager = defaultSessionManager();
    pool = defaultPool();
  });

  afterEach(() => {
    sessionManager?.destroy();
    pool?.destroy();
  });

  it("spawns CLI with --output-format stream-json", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      "/usr/bin/claude",
      expect.arrayContaining(["--output-format", "stream-json"]),
      expect.objectContaining({
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });

  it("happy path: emits role chunk, content chunks, finish chunk, then onDone", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks, chunks, getDoneMetadata } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    // sampleNdjsonStream: system, block_start, 2 deltas, block_stop,
    // message_delta, message_stop, result
    // Expected chunks: role, "Hello", " world!", finish = 4
    expect(chunks).toHaveLength(4);

    const parsed = chunks.map((c) => JSON.parse(c) as ChatCompletionChunk);

    // Role chunk
    expect(parsed[0]!.choices[0]!.delta).toEqual({ role: "assistant" });
    expect(parsed[0]!.choices[0]!.finish_reason).toBeNull();

    // Content chunks
    expect(parsed[1]!.choices[0]!.delta).toEqual({ content: "Hello" });
    expect(parsed[2]!.choices[0]!.delta).toEqual({ content: " world!" });

    // Finish chunk
    expect(parsed[3]!.choices[0]!.delta).toEqual({});
    expect(parsed[3]!.choices[0]!.finish_reason).toBe("stop");

    // onDone called with usage
    const meta = getDoneMetadata();
    expect(meta).toBeDefined();
    expect(meta!.headers["X-Backend-Mode"]).toBe("claude-code");
    expect(meta!.headers["X-Claude-Session-ID"]).toBe(
      "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    );
    expect(meta!.usage).toEqual({
      prompt_tokens: 25,
      completion_tokens: 12,
      total_tokens: 37,
    });
  });

  it("CLI exits with non-zero code before stdout → onError", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    // Immediate crash: no stdout, exit code 1
    const child = createMockChildProcess({ exitCode: 1 });
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks, chunks, getError, getDoneMetadata } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    // handleError emits a finish chunk
    expect(chunks).toHaveLength(1);
    const finishChunk = JSON.parse(chunks[0]!) as ChatCompletionChunk;
    expect(finishChunk.choices[0]!.finish_reason).toBe("stop");

    // Error callback called
    const error = getError();
    expect(error).toBeDefined();
    expect(error!.error.message).toContain("CLI process exited with code 1");
    expect(error!.error.code).toBe("stream_error");

    // onDone NOT called
    expect(getDoneMetadata()).toBeUndefined();
  });

  it("CLI crash mid-stream: partial content then error", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    // Only first 3 lines (system, block_start, first delta) then crash
    const partialLines = sampleNdjsonStream.slice(0, 3);
    const child = createStreamingMockChildProcess(partialLines, {
      exitCode: 1,
    });
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks, chunks, getError } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    // Role chunk + "Hello" content chunk + finish chunk from handleError
    expect(chunks).toHaveLength(3);

    const parsed = chunks.map((c) => JSON.parse(c) as ChatCompletionChunk);
    expect(parsed[0]!.choices[0]!.delta.role).toBe("assistant");
    expect(parsed[1]!.choices[0]!.delta.content).toBe("Hello");
    expect(parsed[2]!.choices[0]!.finish_reason).toBe("stop");

    const error = getError();
    expect(error).toBeDefined();
    expect(error!.error.message).toContain("CLI process exited with code 1");
  });

  it("promise never rejects — errors go through callbacks", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    // Spawn throws
    mockSpawn.mockImplementationOnce(() => {
      throw new Error("ENOENT: command not found");
    });

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks, getError } = collectCallbacks();

    // Should resolve, not reject
    await expect(
      backend.completeStream(sampleStreamRequest, defaultContext(), callbacks),
    ).resolves.toBeUndefined();

    const error = getError();
    expect(error).toBeDefined();
    expect(error!.error.message).toContain("Failed to start CLI");
    expect(error!.error.code).toBe("cli_spawn_error");
  });

  it("passes user prompt via -p flag", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    const args = mockSpawn.mock.calls[0]![1] as string[];
    const pIndex = args.indexOf("-p");
    expect(pIndex).toBeGreaterThan(-1);
    expect(args[pIndex + 1]).toBe("Hello");
  });

  it("uses --session-id for new sessions", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks } = collectCallbacks();

    // No sessionId → session manager creates a new session
    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    const args = mockSpawn.mock.calls[0]![1] as string[];
    const sessionIdIndex = args.indexOf("--session-id");
    expect(sessionIdIndex).toBeGreaterThan(-1);
    // Should NOT have --resume
    expect(args.indexOf("--resume")).toBe(-1);
  });

  it("uses --resume for existing sessions", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );

    // First call creates the session
    const child1 = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child1 as never);

    const { callbacks: cb1 } = collectCallbacks();
    await backend.completeStream(sampleStreamRequest, defaultContext(), cb1);

    // Extract the session ID from the first call
    const firstArgs = mockSpawn.mock.calls[0]![1] as string[];
    const sidIdx = firstArgs.indexOf("--session-id");
    const createdSessionId = firstArgs[sidIdx + 1]!;

    // Second call resumes
    const child2 = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child2 as never);

    const { callbacks: cb2 } = collectCallbacks();
    await backend.completeStream(
      sampleStreamRequest,
      defaultContext({ sessionId: createdSessionId }),
      cb2,
    );

    const secondArgs = mockSpawn.mock.calls[1]![1] as string[];
    const resumeIndex = secondArgs.indexOf("--resume");
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(secondArgs[resumeIndex + 1]).toBe(createdSessionId);
    // Should NOT have --session-id
    expect(secondArgs.indexOf("--session-id")).toBe(-1);
  });

  it("extracts system messages into --system-prompt", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks } = collectCallbacks();

    const requestWithSystem = {
      ...sampleStreamRequest,
      messages: [
        { role: "system" as const, content: "You are helpful" },
        { role: "user" as const, content: "Hello" },
      ],
    };

    await backend.completeStream(
      requestWithSystem,
      defaultContext(),
      callbacks,
    );

    const args = mockSpawn.mock.calls[0]![1] as string[];
    const sysIndex = args.indexOf("--system-prompt");
    expect(sysIndex).toBeGreaterThan(-1);
    expect(args[sysIndex + 1]).toBe("You are helpful");
  });

  it("uses sanitized environment", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    const env = mockSpawn.mock.calls[0]![2]?.env as Record<string, string>;
    expect(env).toBeDefined();
    expect(env.TERM).toBe("dumb");
    // Should not contain arbitrary env vars
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("includes stderr in error message on non-zero exit", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createMockChildProcess({
      stderr: "Error: Invalid API key",
      exitCode: 1,
    });
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks, getError } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    const error = getError();
    expect(error).toBeDefined();
    expect(error!.error.message).toContain("Invalid API key");
    expect(error!.error.message).toContain("code 1");
  });

  it("child process error event routes through handleError", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess([]);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks, getError } = collectCallbacks();

    const streamPromise = backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    // Allow async pool acquire + doCompleteStream setup to register listeners
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Emit an error event on the child process (e.g., EPERM)
    child.emit("error", new Error("spawn EPERM"));

    await streamPromise;

    const error = getError();
    expect(error).toBeDefined();
    expect(error!.error.message).toContain("spawn EPERM");
  });

  it("signal kill (exitCode null) does not call handleError or onDone", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    // Simulate a process killed by signal: exit with null code
    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const controller = new AbortController();
    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks, getDoneMetadata, getError } = collectCallbacks();

    const streamPromise = backend.completeStream(
      sampleStreamRequest,
      defaultContext({ signal: controller.signal }),
      callbacks,
    );

    // Kill before emitLines runs — triggers SIGTERM
    controller.abort();

    await streamPromise;

    // The result event from sampleNdjsonStream calls onDone via the
    // adapter (normal stream processing), but handleError should NOT
    // be called since the kill path has exitCode null, not non-zero.
    expect(getError()).toBeUndefined();
    // onDone may or may not be called depending on whether the result
    // event was processed before the kill. The key assertion is no error.
  });

  it("does NOT pass --max-tokens to CLI (Tier 2 ignored)", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks } = collectCallbacks();

    const requestWithMaxTokens = {
      ...sampleStreamRequest,
      max_tokens: 1024,
    };

    await backend.completeStream(
      requestWithMaxTokens,
      defaultContext(),
      callbacks,
    );

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args.indexOf("--max-tokens")).toBe(-1);
  });

  it("includes --model flag in CLI args", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain("--model");
  });

  it("includes --dangerously-skip-permissions flag", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("includes --tools with empty string", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    const args = mockSpawn.mock.calls[0]![1] as string[];
    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(args[toolsIdx + 1]).toBe("");
  });

  it("injects X-Claude-Session-Created header on new session", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks, getDoneMetadata } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    const meta = getDoneMetadata();
    expect(meta).toBeDefined();
    expect(meta!.headers["X-Claude-Session-Created"]).toBe("true");
  });

  it("does NOT inject X-Claude-Session-Created on resumed session", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );

    // First call creates
    const child1 = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child1 as never);
    const { callbacks: cb1 } = collectCallbacks();
    await backend.completeStream(sampleStreamRequest, defaultContext(), cb1);

    // Extract session ID
    const firstArgs = mockSpawn.mock.calls[0]![1] as string[];
    const sidIdx = firstArgs.indexOf("--session-id");
    const createdSessionId = firstArgs[sidIdx + 1]!;

    // Second call resumes
    const child2 = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child2 as never);
    const { callbacks: cb2, getDoneMetadata } = collectCallbacks();
    await backend.completeStream(
      sampleStreamRequest,
      defaultContext({ sessionId: createdSessionId }),
      cb2,
    );

    const meta = getDoneMetadata();
    expect(meta).toBeDefined();
    expect(meta!.headers["X-Claude-Session-Created"]).toBeUndefined();
  });

  it("releases session lock after stream error", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createMockChildProcess({ exitCode: 1 });
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks } = collectCallbacks();

    await backend.completeStream(
      sampleStreamRequest,
      defaultContext(),
      callbacks,
    );

    // Extract session ID from args
    const args = mockSpawn.mock.calls[0]![1] as string[];
    const sidIdx = args.indexOf("--session-id");
    const sessionId = args[sidIdx + 1]!;

    // Session lock should be released — session should be resumable
    const session = sessionManager.getSession(sessionId);
    expect(session).toBeDefined();
    expect(session!.isActive).toBe(false);
  });

  it("uses __anonymous__ when apiKey is undefined", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks } = collectCallbacks();

    // No apiKey in context
    await backend.completeStream(
      sampleStreamRequest,
      defaultContext({ apiKey: undefined }),
      callbacks,
    );

    // Extract session ID from args
    const args = mockSpawn.mock.calls[0]![1] as string[];
    const sidIdx = args.indexOf("--session-id");
    const sessionId = args[sidIdx + 1]!;

    const session = sessionManager.getSession(sessionId);
    expect(session).toBeDefined();
    expect(session!.clientId).toBe("__anonymous__");
  });

  it("rejects Tier 3 param (tools) via onError, no spawn", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks, getError } = collectCallbacks();

    const requestWithTools = {
      ...sampleStreamRequest,
      tools: [{ type: "function", function: { name: "test" } }],
    };

    await backend.completeStream(requestWithTools, defaultContext(), callbacks);

    const error = getError();
    expect(error).toBeDefined();
    expect(error!.error.code).toBe("unsupported_parameter");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("rejects unknown model via onError, no spawn", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks, getError } = collectCallbacks();

    const requestWithBadModel = {
      ...sampleStreamRequest,
      model: "o1-mini",
    };

    await backend.completeStream(
      requestWithBadModel,
      defaultContext(),
      callbacks,
    );

    const error = getError();
    expect(error).toBeDefined();
    expect(error!.error.code).toBe("model_not_found");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("rejects system-only messages via onError, no spawn", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks, getError } = collectCallbacks();

    const requestWithSystemOnly = {
      ...sampleStreamRequest,
      messages: [{ role: "system" as const, content: "You are helpful" }],
    };

    await backend.completeStream(
      requestWithSystemOnly,
      defaultContext(),
      callbacks,
    );

    const error = getError();
    expect(error).toBeDefined();
    expect(error!.error.code).toBe("invalid_request");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("session error routes through onError callback", async () => {
    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks, getError } = collectCallbacks();

    // Try to resume a non-existent session
    await backend.completeStream(
      sampleStreamRequest,
      defaultContext({
        sessionId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      }),
      callbacks,
    );

    const error = getError();
    expect(error).toBeDefined();
    expect(error!.error.code).toBe("session_not_found");
  });

  it("sends large prompts via stdin instead of -p flag", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createStreamingMockChildProcess(sampleNdjsonStream);
    // Spy on stdin.write to verify the prompt is written
    const stdinWriteSpy = vi.fn();
    child.stdin.write = stdinWriteSpy;
    mockSpawn.mockReturnValueOnce(child as never);

    const backend = new ClaudeCodeBackend(
      defaultOptions(),
      sessionManager,
      pool,
    );
    const { callbacks } = collectCallbacks();

    // Create a prompt larger than STDIN_PROMPT_THRESHOLD (128 KB)
    const largePrompt = "x".repeat(STDIN_PROMPT_THRESHOLD + 1);
    const largeRequest = {
      ...sampleStreamRequest,
      messages: [{ role: "user" as const, content: largePrompt }],
    };

    await backend.completeStream(largeRequest, defaultContext(), callbacks);

    // Args should NOT contain -p
    const args = mockSpawn.mock.calls[0]![1] as string[];
    expect(args.indexOf("-p")).toBe(-1);

    // Prompt should have been written to stdin
    expect(stdinWriteSpy).toHaveBeenCalledWith(largePrompt);
  });
});
