import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RequestContext } from "../../src/backends/types.js";
import { ClaudeCodeBackend } from "../../src/backends/claude-code.js";
import type { ClaudeCodeOptions } from "../../src/backends/claude-code.js";
import { SessionManager } from "../../src/services/session-manager.js";
import { ApiError } from "../../src/errors/handler.js";
import {
  sampleCliResult,
  sampleCliErrorResult,
  sampleCliEmptyResult,
  sampleCliAuthFailureStderr,
  sampleChatRequest,
} from "../helpers/index.js";

vi.mock("../../src/services/claude-cli.js", () => ({
  spawnCli: vi.fn(),
  STDIN_PROMPT_THRESHOLD: 128 * 1024,
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

describe("ClaudeCodeBackend.complete()", () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionManager = defaultSessionManager();
  });

  afterEach(() => {
    sessionManager?.destroy();
  });

  it("happy path: returns OpenAI-format response", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    const mockSpawnCli = vi.mocked(spawnCli);

    mockSpawnCli.mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const result = await backend.complete(sampleChatRequest, defaultContext());

    expect(result.response.id).toMatch(/^chatcmpl-/);
    expect(result.response.object).toBe("chat.completion");
    expect(result.response.model).toBe(sampleChatRequest.model);
    expect(result.response.choices).toHaveLength(1);
    expect(result.response.choices[0]!.message.role).toBe("assistant");
    expect(result.response.choices[0]!.message.content).toBe(
      sampleCliResult.result,
    );
    expect(result.response.choices[0]!.finish_reason).toBe("stop");
    expect(result.response.usage.prompt_tokens).toBe(
      sampleCliResult.usage.input_tokens,
    );
    expect(result.response.usage.completion_tokens).toBe(
      sampleCliResult.usage.output_tokens,
    );
    expect(result.response.usage.total_tokens).toBe(
      sampleCliResult.usage.input_tokens + sampleCliResult.usage.output_tokens,
    );
  });

  it("includes X-Backend-Mode header", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const result = await backend.complete(sampleChatRequest, defaultContext());

    expect(result.headers["X-Backend-Mode"]).toBe("claude-code");
  });

  it("includes X-Claude-Session-ID header", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const result = await backend.complete(sampleChatRequest, defaultContext());

    expect(result.headers["X-Claude-Session-ID"]).toBeDefined();
    expect(result.headers["X-Claude-Session-ID"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-/,
    );
  });

  it("sets X-Claude-Session-Created: true for new sessions", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const result = await backend.complete(sampleChatRequest, defaultContext());

    expect(result.headers["X-Claude-Session-Created"]).toBe("true");
  });

  it("does NOT set X-Claude-Session-Created for resumed sessions", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    const mockSpawnCli = vi.mocked(spawnCli);

    // First call creates
    mockSpawnCli.mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const firstResult = await backend.complete(
      sampleChatRequest,
      defaultContext(),
    );
    const sessionId = firstResult.headers["X-Claude-Session-ID"]!;

    // Second call resumes
    mockSpawnCli.mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const secondResult = await backend.complete(
      sampleChatRequest,
      defaultContext({ sessionId }),
    );

    expect(secondResult.headers["X-Claude-Session-Created"]).toBeUndefined();
  });

  it("passes --resume for existing sessions", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    const mockSpawnCli = vi.mocked(spawnCli);

    // First call creates
    mockSpawnCli.mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const firstResult = await backend.complete(
      sampleChatRequest,
      defaultContext(),
    );
    const sessionId = firstResult.headers["X-Claude-Session-ID"]!;

    // Second call resumes
    mockSpawnCli.mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    await backend.complete(sampleChatRequest, defaultContext({ sessionId }));

    // Check that spawnCli was called with --resume in args
    const secondCall = mockSpawnCli.mock.calls[1]!;
    expect(secondCall[0].args).toContain("--resume");
    expect(secondCall[0].args).not.toContain("--session-id");
  });

  it("is_error: true throws ApiError with backend_error code", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliErrorResult),
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);

    try {
      await backend.complete(sampleChatRequest, defaultContext());
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.body.error.code).toBe("backend_error");
    }
  });

  it("returns 401 for auth failure in stderr", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: "",
      stderr: sampleCliAuthFailureStderr,
      exitCode: 1,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);

    try {
      await backend.complete(sampleChatRequest, defaultContext());
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.body.error.code).toBe("invalid_api_key");
    }
  });

  it("returns 500 for non-zero exit code (non-auth)", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: "",
      stderr: "Error: Something went wrong",
      exitCode: 1,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);

    try {
      await backend.complete(sampleChatRequest, defaultContext());
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.body.error.code).toBe("backend_error");
      expect(apiErr.body.error.message).toContain("code 1");
      expect(apiErr.body.error.message).toContain("Something went wrong");
    }
  });

  it("returns 500 for JSON parse failure", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: "not-valid-json{{{",
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);

    try {
      await backend.complete(sampleChatRequest, defaultContext());
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.body.error.message).toContain("parse CLI output");
    }
  });

  it("rejects Tier 3 param with 400 (before lock)", async () => {
    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);

    const requestWithTools = {
      ...sampleChatRequest,
      tools: [{ type: "function", function: { name: "test" } }],
    };

    try {
      await backend.complete(requestWithTools, defaultContext());
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.body.error.code).toBe("unsupported_parameter");
    }
  });

  it("rejects unknown model with 400", async () => {
    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);

    const requestWithBadModel = {
      ...sampleChatRequest,
      model: "o1-mini",
    };

    try {
      await backend.complete(requestWithBadModel, defaultContext());
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.body.error.code).toBe("model_not_found");
    }
  });

  it("includes X-Claude-Ignored-Params header when Tier 2 params present", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);

    const requestWithIgnored = {
      ...sampleChatRequest,
      temperature: 0.7,
      top_p: 0.9,
    };

    const result = await backend.complete(requestWithIgnored, defaultContext());

    expect(result.headers["X-Claude-Ignored-Params"]).toBeDefined();
    expect(result.headers["X-Claude-Ignored-Params"]).toContain("temperature");
    expect(result.headers["X-Claude-Ignored-Params"]).toContain("top_p");
  });

  it("does NOT include X-Claude-Ignored-Params when no Tier 2 params", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const result = await backend.complete(sampleChatRequest, defaultContext());

    expect(result.headers["X-Claude-Ignored-Params"]).toBeUndefined();
  });

  it("releases session lock on success", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const result = await backend.complete(sampleChatRequest, defaultContext());

    const sessionId = result.headers["X-Claude-Session-ID"]!;
    const session = sessionManager.getSession(sessionId);
    expect(session).toBeDefined();
    expect(session!.isActive).toBe(false);
  });

  it("releases session lock on error", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: "bad-json",
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);

    try {
      await backend.complete(sampleChatRequest, defaultContext());
    } catch {
      // Expected — JSON parse failure
    }

    // Verify we can make another request (session lock released)
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    // This should succeed — proves lock was released
    const result = await backend.complete(sampleChatRequest, defaultContext());
    expect(result.response).toBeDefined();
  });

  it("model mapping integration: gpt-4o maps to sonnet", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    const mockSpawnCli = vi.mocked(spawnCli);

    mockSpawnCli.mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const result = await backend.complete(sampleChatRequest, defaultContext());

    // CLI should receive resolved model name
    const callArgs = mockSpawnCli.mock.calls[0]![0].args;
    const modelIdx = callArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(callArgs[modelIdx + 1]).toBe("sonnet");

    // Response should echo original model name
    expect(result.response.model).toBe("gpt-4o");
  });

  it("large prompt is delivered via stdin", async () => {
    const { spawnCli, STDIN_PROMPT_THRESHOLD } =
      await import("../../src/services/claude-cli.js");
    const mockSpawnCli = vi.mocked(spawnCli);

    mockSpawnCli.mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const bigPrompt = "A".repeat(STDIN_PROMPT_THRESHOLD + 1);
    const bigRequest = {
      ...sampleChatRequest,
      messages: [{ role: "user" as const, content: bigPrompt }],
    };

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    await backend.complete(bigRequest, defaultContext());

    const call = mockSpawnCli.mock.calls[0]![0];
    expect(call.useStdin).toBe(true);
    expect(call.args).not.toContain("-p");
  });

  it("passes AbortSignal to spawnCli", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    const mockSpawnCli = vi.mocked(spawnCli);

    mockSpawnCli.mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const controller = new AbortController();
    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    await backend.complete(
      sampleChatRequest,
      defaultContext({ signal: controller.signal }),
    );

    const call = mockSpawnCli.mock.calls[0]![0];
    expect(call.signal).toBe(controller.signal);
  });

  it("returns empty content for empty CLI result", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliEmptyResult),
      stderr: "",
      exitCode: 0,
    });

    const backend = new ClaudeCodeBackend(defaultOptions(), sessionManager);
    const result = await backend.complete(sampleChatRequest, defaultContext());

    expect(result.response.choices[0]!.message.content).toBe("");
  });
});
