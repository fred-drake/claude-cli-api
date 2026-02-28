import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";

describe("logging security", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not log full API keys in request headers", async () => {
    const config = {
      ...loadConfig(),
      apiKeys: ["sk-cca-supersecretkey12345"],
      logLevel: "info" as const,
      logFormat: "json" as const,
    };

    const server = createServer(config);
    await server.ready();

    // Mock the backend to avoid real API calls
    vi.spyOn(server.openaiPassthroughBackend, "complete").mockResolvedValue({
      response: {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1700000000,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hi" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      headers: { "X-Backend-Mode": "openai-passthrough" },
    });

    // Capture log output by spying on all log methods
    const logCalls: string[] = [];
    for (const level of [
      "fatal",
      "error",
      "warn",
      "info",
      "debug",
      "trace",
    ] as const) {
      vi.spyOn(server.log, level).mockImplementation((...args: unknown[]) => {
        logCalls.push(JSON.stringify(args));
      });
    }

    await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-cca-supersecretkey12345",
        "x-openai-api-key": "sk-openai-secret-key-xyz",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    await server.close();

    const allLogs = logCalls.join("\n");

    // Full API keys should not appear in logs
    expect(allLogs).not.toContain("sk-cca-supersecretkey12345");
    expect(allLogs).not.toContain("sk-openai-secret-key-xyz");
  });

  it("does not log prompt content in request body", async () => {
    const config = {
      ...loadConfig(),
      apiKeys: [],
      logLevel: "info" as const,
      logFormat: "json" as const,
    };

    const server = createServer(config);
    await server.ready();

    vi.spyOn(server.openaiPassthroughBackend, "complete").mockResolvedValue({
      response: {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1700000000,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hi" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      headers: { "X-Backend-Mode": "openai-passthrough" },
    });

    // Use a distinctive marker string we can search for
    const sensitiveContent = "ULTRA_SECRET_PROMPT_CONTENT_XYZ123";

    // Capture all log output
    const logCalls: string[] = [];
    for (const level of [
      "fatal",
      "error",
      "warn",
      "info",
      "debug",
      "trace",
    ] as const) {
      vi.spyOn(server.log, level).mockImplementation((...args: unknown[]) => {
        logCalls.push(JSON.stringify(args));
      });
    }

    await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: sensitiveContent }],
      },
    });

    await server.close();

    // Check that prompt content doesn't appear in any log call
    const allLogs = logCalls.join("\n");
    expect(allLogs).not.toContain(sensitiveContent);
  });

  it("does not expose API keys in error responses", async () => {
    const config = {
      ...loadConfig(),
      apiKeys: ["sk-cca-secret-test-key-999"],
      logLevel: "info" as const,
      logFormat: "json" as const,
    };

    const server = createServer(config);
    await server.ready();

    // Send a request with an invalid key
    const response = await server.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-key-attempt",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    await server.close();

    // Error response should not contain the valid server key
    const body = response.body;
    expect(body).not.toContain("sk-cca-secret-test-key-999");
    // Error response should not echo back the attempted key
    expect(body).not.toContain("wrong-key-attempt");
  });
});
