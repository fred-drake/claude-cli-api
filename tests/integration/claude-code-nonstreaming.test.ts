import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import {
  injectRequest,
  expectOpenAIError,
  sampleCliResult,
  sampleCliErrorResult,
  sampleCliAuthFailureStderr,
} from "../helpers/index.js";

vi.mock("../../src/services/claude-cli.js", () => ({
  spawnCli: vi.fn(),
  STDIN_PROMPT_THRESHOLD: 128 * 1024,
}));

const CLAUDE_MODE_HEADERS = { "x-claude-code": "true" };

function createTestApp(): FastifyInstance {
  return createServer(loadConfig());
}

describe("POST /v1/chat/completions (claude-code non-streaming)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = createTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with OpenAI-format response", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const response = await injectRequest(app, {
      url: "/v1/chat/completions",
      headers: CLAUDE_MODE_HEADERS,
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("gpt-4o");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe(sampleCliResult.result);
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.prompt_tokens).toBe(sampleCliResult.usage.input_tokens);
    expect(body.usage.completion_tokens).toBe(
      sampleCliResult.usage.output_tokens,
    );
    expect(body.usage.total_tokens).toBe(
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

    const response = await injectRequest(app, {
      url: "/v1/chat/completions",
      headers: CLAUDE_MODE_HEADERS,
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.headers["x-backend-mode"]).toBe("claude-code");
  });

  it("includes X-Request-ID header", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const response = await injectRequest(app, {
      url: "/v1/chat/completions",
      headers: CLAUDE_MODE_HEADERS,
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.headers["x-request-id"]).toBeDefined();
  });

  it("includes X-Claude-Session-ID header", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const response = await injectRequest(app, {
      url: "/v1/chat/completions",
      headers: CLAUDE_MODE_HEADERS,
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.headers["x-claude-session-id"]).toBeDefined();
    expect(response.headers["x-claude-session-id"]).toMatch(
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

    const response = await injectRequest(app, {
      url: "/v1/chat/completions",
      headers: CLAUDE_MODE_HEADERS,
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.headers["x-claude-session-created"]).toBe("true");
  });

  it("includes X-Claude-Ignored-Params when Tier 2 params present", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const response = await injectRequest(app, {
      url: "/v1/chat/completions",
      headers: CLAUDE_MODE_HEADERS,
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 0.7,
        top_p: 0.9,
      },
    });

    expect(response.statusCode).toBe(200);
    const ignored = response.headers["x-claude-ignored-params"] as string;
    expect(ignored).toBeDefined();
    expect(ignored).toContain("temperature");
    expect(ignored).toContain("top_p");
  });

  it("returns 400 for Tier 3 param (tools)", async () => {
    const response = await injectRequest(app, {
      url: "/v1/chat/completions",
      headers: CLAUDE_MODE_HEADERS,
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        tools: [{ type: "function", function: { name: "test" } }],
      },
    });

    expect(response.statusCode).toBe(400);
    expectOpenAIError(response.json(), {
      code: "unsupported_parameter",
      type: "invalid_request_error",
    });
  });

  it("returns 400 for unknown model with valid model list", async () => {
    const response = await injectRequest(app, {
      url: "/v1/chat/completions",
      headers: CLAUDE_MODE_HEADERS,
      payload: {
        model: "o1-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expectOpenAIError(response.json(), {
      code: "model_not_found",
      message: "not supported",
    });

    // Should list valid models
    const body = response.json();
    expect(body.error.message).toContain("gpt-4o");
  });

  it("returns 500 for is_error: true from CLI", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliErrorResult),
      stderr: "",
      exitCode: 0,
    });

    const response = await injectRequest(app, {
      url: "/v1/chat/completions",
      headers: CLAUDE_MODE_HEADERS,
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(500);
    expectOpenAIError(response.json(), {
      code: "backend_error",
      type: "server_error",
    });
  });

  it("returns 401 for auth failure stderr", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: "",
      stderr: sampleCliAuthFailureStderr,
      exitCode: 1,
    });

    const response = await injectRequest(app, {
      url: "/v1/chat/completions",
      headers: CLAUDE_MODE_HEADERS,
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.statusCode).toBe(401);
    expectOpenAIError(response.json(), {
      code: "invalid_api_key",
    });
  });

  it("includes security headers in response", async () => {
    const { spawnCli } = await import("../../src/services/claude-cli.js");
    vi.mocked(spawnCli).mockResolvedValueOnce({
      stdout: JSON.stringify(sampleCliResult),
      stderr: "",
      exitCode: 0,
    });

    const response = await injectRequest(app, {
      url: "/v1/chat/completions",
      headers: CLAUDE_MODE_HEADERS,
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });
});
