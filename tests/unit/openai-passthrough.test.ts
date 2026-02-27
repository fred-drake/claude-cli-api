import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
} from "openai";
import type { RequestContext } from "../../src/backends/types.js";
import {
  OpenAIPassthroughBackend,
  PassthroughError,
} from "../../src/backends/openai-passthrough.js";
import type { OpenAIPassthroughOptions } from "../../src/backends/openai-passthrough.js";
import {
  sampleChatRequest,
  sampleStreamRequest,
  sampleOpenAIResponse,
  sampleOpenAIError,
  createMockOpenAIStream,
  createErrorStream,
  createTypicalStreamChunks,
} from "../helpers/index.js";

// --- Mock setup ---

const mockCreate = vi.fn();

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  return {
    ...actual,
    default: vi.fn().mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    })),
  };
});

// --- Helpers ---

function defaultOptions(
  overrides: Partial<OpenAIPassthroughOptions> = {},
): OpenAIPassthroughOptions {
  return {
    apiKey: "sk-test-server-key",
    baseURL: "https://api.openai.com/v1",
    enabled: true,
    allowClientKey: true,
    ...overrides,
  };
}

function defaultContext(
  overrides: Partial<RequestContext> = {},
): RequestContext {
  return {
    requestId: "req-001",
    clientIp: "127.0.0.1",
    method: "POST",
    path: "/v1/chat/completions",
    ...overrides,
  };
}

function collectCallbacks() {
  const chunks: string[] = [];
  let doneMetadata:
    | { headers: Record<string, string>; usage?: unknown }
    | undefined;
  let error: unknown | undefined;

  return {
    callbacks: {
      onChunk: (chunk: string) => chunks.push(chunk),
      onDone: (meta: { headers: Record<string, string>; usage?: unknown }) => {
        doneMetadata = meta;
      },
      onError: (err: unknown) => {
        error = err;
      },
    },
    chunks,
    getDoneMetadata: () => doneMetadata,
    getError: () => error,
  };
}

// --- Tests ---

describe("OpenAIPassthroughBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("name property", () => {
    it('backend.name === "openai-passthrough"', () => {
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      expect(backend.name).toBe("openai-passthrough");
    });
  });

  describe("complete()", () => {
    it("forwards request and returns OpenAI response", async () => {
      mockCreate.mockResolvedValueOnce(sampleOpenAIResponse);
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      const result = await backend.complete(
        sampleChatRequest,
        defaultContext(),
      );

      expect(result.response).toEqual(sampleOpenAIResponse);
      expect(result.headers["X-Backend-Mode"]).toBe("openai-passthrough");
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: sampleChatRequest.model,
          messages: sampleChatRequest.messages,
          stream: false,
        }),
      );
    });

    it("overrides stream to false even if request has stream: true", async () => {
      mockCreate.mockResolvedValueOnce(sampleOpenAIResponse);
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      await backend.complete(sampleStreamRequest, defaultContext());

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ stream: false }),
      );
    });

    it("uses server key by default", async () => {
      const OpenAIMock = (await import("openai"))
        .default as unknown as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValueOnce(sampleOpenAIResponse);
      const backend = new OpenAIPassthroughBackend(defaultOptions());

      await backend.complete(sampleChatRequest, defaultContext());

      // Constructor called once during backend creation with server key
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "sk-test-server-key" }),
      );
    });

    it("client key override creates per-request client", async () => {
      const OpenAIMock = (await import("openai"))
        .default as unknown as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValueOnce(sampleOpenAIResponse);
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      OpenAIMock.mockClear();

      await backend.complete(
        sampleChatRequest,
        defaultContext({ clientOpenAIKey: "sk-client-key" }),
      );

      // New client created for the request with client key
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "sk-client-key",
          baseURL: "https://api.openai.com/v1",
        }),
      );
    });

    it("ALLOW_CLIENT_OPENAI_KEY=false ignores client key", async () => {
      const OpenAIMock = (await import("openai"))
        .default as unknown as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValueOnce(sampleOpenAIResponse);
      const backend = new OpenAIPassthroughBackend(
        defaultOptions({ allowClientKey: false }),
      );
      OpenAIMock.mockClear();

      await backend.complete(
        sampleChatRequest,
        defaultContext({ clientOpenAIKey: "sk-client-key" }),
      );

      // No new client created — uses default server client
      expect(OpenAIMock).not.toHaveBeenCalled();
    });

    it("no key (empty string) throws PassthroughError 503 passthrough_not_configured", async () => {
      const backend = new OpenAIPassthroughBackend(
        defaultOptions({ apiKey: "", allowClientKey: false }),
      );

      await expect(
        backend.complete(sampleChatRequest, defaultContext()),
      ).rejects.toThrow(PassthroughError);

      try {
        await backend.complete(sampleChatRequest, defaultContext());
      } catch (err) {
        expect(err).toBeInstanceOf(PassthroughError);
        const pe = err as PassthroughError;
        expect(pe.status).toBe(503);
        expect(pe.body.error.code).toBe("passthrough_not_configured");
      }
    });

    it("disabled throws PassthroughError 503 passthrough_disabled", async () => {
      const backend = new OpenAIPassthroughBackend(
        defaultOptions({ enabled: false }),
      );

      await expect(
        backend.complete(sampleChatRequest, defaultContext()),
      ).rejects.toThrow(PassthroughError);

      try {
        await backend.complete(sampleChatRequest, defaultContext());
      } catch (err) {
        const pe = err as PassthroughError;
        expect(pe.status).toBe(503);
        expect(pe.body.error.code).toBe("passthrough_disabled");
      }
    });

    it("forwards tools param unchanged", async () => {
      mockCreate.mockResolvedValueOnce(sampleOpenAIResponse);
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      const requestWithTools = {
        ...sampleChatRequest,
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather data",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      };

      await backend.complete(requestWithTools, defaultContext());

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ tools: requestWithTools.tools }),
      );
    });

    it("SDK APIError preserves status and body", async () => {
      const sdkError = new APIError(
        401,
        {
          message: "Invalid API key",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
        "Invalid API key",
        {},
      );
      mockCreate.mockRejectedValueOnce(sdkError);
      const backend = new OpenAIPassthroughBackend(defaultOptions());

      try {
        await backend.complete(sampleChatRequest, defaultContext());
        expect.unreachable("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PassthroughError);
        const pe = err as PassthroughError;
        expect(pe.status).toBe(401);
        expect(pe.body.error.message).toBe("Invalid API key");
        expect(pe.body.error.type).toBe("invalid_request_error");
        expect(pe.body.error.code).toBe("invalid_api_key");
        expect(pe.cause).toBe(sdkError);
      }
    });

    it("SDK APIConnectionError maps to 502", async () => {
      const connError = new APIConnectionError({
        message: "Connection refused",
        cause: new Error("ECONNREFUSED"),
      });
      mockCreate.mockRejectedValueOnce(connError);
      const backend = new OpenAIPassthroughBackend(defaultOptions());

      try {
        await backend.complete(sampleChatRequest, defaultContext());
        expect.unreachable("Should have thrown");
      } catch (err) {
        const pe = err as PassthroughError;
        expect(pe.status).toBe(502);
        expect(pe.body.error.code).toBe("connection_error");
      }
    });

    it("SDK APIConnectionTimeoutError maps to 504", async () => {
      const timeoutError = new APIConnectionTimeoutError();
      mockCreate.mockRejectedValueOnce(timeoutError);
      const backend = new OpenAIPassthroughBackend(defaultOptions());

      try {
        await backend.complete(sampleChatRequest, defaultContext());
        expect.unreachable("Should have thrown");
      } catch (err) {
        const pe = err as PassthroughError;
        expect(pe.status).toBe(504);
        expect(pe.body.error.code).toBe("timeout");
      }
    });
  });

  describe("completeStream()", () => {
    it("pipes chunks via onChunk as raw JSON", async () => {
      const streamChunks = createTypicalStreamChunks("Hi");
      mockCreate.mockResolvedValueOnce(createMockOpenAIStream(streamChunks));
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      const { callbacks, chunks } = collectCallbacks();

      await backend.completeStream(
        sampleStreamRequest,
        defaultContext(),
        callbacks,
      );

      expect(chunks.length).toBe(streamChunks.length);
      for (let i = 0; i < chunks.length; i++) {
        expect(JSON.parse(chunks[i]!)).toEqual(streamChunks[i]);
      }
    });

    it("overrides stream to true", async () => {
      const streamChunks = createTypicalStreamChunks("Hi");
      mockCreate.mockResolvedValueOnce(createMockOpenAIStream(streamChunks));
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      const { callbacks } = collectCallbacks();

      await backend.completeStream(
        sampleChatRequest,
        defaultContext(),
        callbacks,
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ stream: true }),
      );
    });

    it("never emits [DONE] — no chunk contains [DONE]", async () => {
      const streamChunks = createTypicalStreamChunks("Hello");
      mockCreate.mockResolvedValueOnce(createMockOpenAIStream(streamChunks));
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      const { callbacks, chunks } = collectCallbacks();

      await backend.completeStream(
        sampleStreamRequest,
        defaultContext(),
        callbacks,
      );

      for (const chunk of chunks) {
        expect(chunk).not.toContain("[DONE]");
      }
    });

    it("calls onDone with headers after stream ends", async () => {
      const streamChunks = createTypicalStreamChunks("Hi");
      mockCreate.mockResolvedValueOnce(createMockOpenAIStream(streamChunks));
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      const { callbacks, getDoneMetadata } = collectCallbacks();

      await backend.completeStream(
        sampleStreamRequest,
        defaultContext(),
        callbacks,
      );

      const meta = getDoneMetadata();
      expect(meta).toBeDefined();
      expect(meta!.headers["X-Backend-Mode"]).toBe("openai-passthrough");
    });

    it("passes usage from final chunk to onDone", async () => {
      const streamChunks = createTypicalStreamChunks("Hi");
      // Add usage to the final chunk
      const lastChunk = { ...streamChunks[streamChunks.length - 1]! };
      lastChunk.usage = {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      };
      streamChunks[streamChunks.length - 1] = lastChunk;

      mockCreate.mockResolvedValueOnce(createMockOpenAIStream(streamChunks));
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      const { callbacks, getDoneMetadata } = collectCallbacks();

      await backend.completeStream(
        sampleStreamRequest,
        defaultContext(),
        callbacks,
      );

      const meta = getDoneMetadata();
      expect(meta!.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      });
    });

    it("streaming error from OpenAI propagates via onError", async () => {
      const partialChunks = createTypicalStreamChunks("H").slice(0, 2);
      const sdkError = new APIError(
        500,
        sampleOpenAIError.error,
        sampleOpenAIError.error.message,
        {},
      );
      mockCreate.mockResolvedValueOnce(
        createErrorStream(partialChunks, sdkError),
      );
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      const { callbacks, chunks, getError } = collectCallbacks();

      // Should not reject
      await backend.completeStream(
        sampleStreamRequest,
        defaultContext(),
        callbacks,
      );

      // Some chunks were delivered before the error
      expect(chunks.length).toBe(2);
      // Error was routed through onError
      const err = getError();
      expect(err).toBeDefined();
    });

    it("pre-stream validation error routes through onError, not throw", async () => {
      const backend = new OpenAIPassthroughBackend(
        defaultOptions({ enabled: false }),
      );
      const { callbacks, getError } = collectCallbacks();

      // Should not reject
      const result = backend.completeStream(
        sampleStreamRequest,
        defaultContext(),
        callbacks,
      );

      await expect(result).resolves.toBeUndefined();

      const err = getError();
      expect(err).toBeDefined();
      expect((err as { error: { code: string } }).error.code).toBe(
        "passthrough_disabled",
      );
    });

    it("handles empty stream (zero chunks) gracefully", async () => {
      mockCreate.mockResolvedValueOnce(createMockOpenAIStream([]));
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      const { callbacks, chunks, getDoneMetadata } = collectCallbacks();

      await backend.completeStream(
        sampleStreamRequest,
        defaultContext(),
        callbacks,
      );

      expect(chunks.length).toBe(0);
      const meta = getDoneMetadata();
      expect(meta).toBeDefined();
      expect(meta!.headers["X-Backend-Mode"]).toBe("openai-passthrough");
      expect(meta!.usage).toBeUndefined();
    });

    it("captures usage when stream_options.include_usage triggers SDK usage field", async () => {
      const streamChunks = createTypicalStreamChunks("OK");
      // Simulate SDK behavior when stream_options.include_usage is true:
      // the final chunk includes a usage field
      const lastChunk = { ...streamChunks[streamChunks.length - 1]! };
      lastChunk.usage = {
        prompt_tokens: 20,
        completion_tokens: 2,
        total_tokens: 22,
      };
      streamChunks[streamChunks.length - 1] = lastChunk;

      mockCreate.mockResolvedValueOnce(createMockOpenAIStream(streamChunks));
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      const { callbacks, getDoneMetadata } = collectCallbacks();

      const requestWithUsage = {
        ...sampleStreamRequest,
        stream_options: { include_usage: true },
      };

      await backend.completeStream(
        requestWithUsage,
        defaultContext(),
        callbacks,
      );

      const meta = getDoneMetadata();
      expect(meta!.usage).toEqual({
        prompt_tokens: 20,
        completion_tokens: 2,
        total_tokens: 22,
      });
    });

    it("never rejects (Promise<void> resolves even on error)", async () => {
      // Test with various error types — all should resolve
      const backend = new OpenAIPassthroughBackend(
        defaultOptions({ apiKey: "", allowClientKey: false }),
      );
      const { callbacks } = collectCallbacks();

      // Should resolve, not reject
      await expect(
        backend.completeStream(
          sampleStreamRequest,
          defaultContext(),
          callbacks,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("healthCheck()", () => {
    it("ok when server key configured", async () => {
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      const health = await backend.healthCheck();
      expect(health).toEqual({ status: "ok" });
    });

    it("ok when no server key but client keys allowed", async () => {
      const backend = new OpenAIPassthroughBackend(
        defaultOptions({ apiKey: "", allowClientKey: true }),
      );
      const health = await backend.healthCheck();
      expect(health).toEqual({ status: "ok" });
    });

    it("disabled when passthrough disabled", async () => {
      const backend = new OpenAIPassthroughBackend(
        defaultOptions({ enabled: false }),
      );
      const health = await backend.healthCheck();
      expect(health).toEqual({ status: "disabled" });
    });

    it("no_key when no key source available", async () => {
      const backend = new OpenAIPassthroughBackend(
        defaultOptions({ apiKey: "", allowClientKey: false }),
      );
      const health = await backend.healthCheck();
      expect(health).toEqual({ status: "no_key" });
    });
  });

  describe("security", () => {
    it("baseURL always from server config for both server and client keys", async () => {
      const OpenAIMock = (await import("openai"))
        .default as unknown as ReturnType<typeof vi.fn>;
      mockCreate.mockResolvedValueOnce(sampleOpenAIResponse);
      const customBase = "https://my-proxy.example.com/v1";
      const backend = new OpenAIPassthroughBackend(
        defaultOptions({ baseURL: customBase }),
      );
      OpenAIMock.mockClear();

      await backend.complete(
        sampleChatRequest,
        defaultContext({ clientOpenAIKey: "sk-client" }),
      );

      // Client key used a per-request client, but baseURL is from server config
      expect(OpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "sk-client",
          baseURL: customBase,
        }),
      );
    });

    it("key not exposed via the public TypeScript API surface", () => {
      const backend = new OpenAIPassthroughBackend(defaultOptions());

      // The only public property is `name`; options and defaultClient are
      // private. TypeScript prevents compile-time access to private fields.
      const publicKeys = Object.keys(backend).filter((k) => !k.startsWith("_"));

      // Verify the only public-facing string property is `name`
      expect(publicKeys).toContain("name");
      expect(backend.name).toBe("openai-passthrough");

      // Verify that accessing `apiKey` through the public type is impossible
      // at compile-time (this is a runtime-level sanity check that the
      // property exists only on the internal options object, not as a
      // top-level field).
      expect("apiKey" in backend).toBe(false);

      // Note: TS `private` is compile-time only. JSON.stringify and
      // (backend as any).options would still expose the key at runtime.
      // True runtime encapsulation would require ES2022 #private fields.
      // This is acceptable for a server-side module that is never serialized
      // or exposed to client code.
    });

    // Task 3.19: Verify X-OpenAI-API-Key values are never logged.
    // Skipped until logger injection is implemented (deferred item).
    // When a logger is added to the backend, this test must verify that
    // client-provided OpenAI keys never appear in log output.
    it.skip("X-OpenAI-API-Key values are never logged (awaits logger injection)", () => {
      // TODO: Implement when logger is injected into the backend
    });
  });

  // Tasks 3.17/3.18: These test the full backend pipeline with mocked SDK.
  // True Fastify inject() integration tests will be added in Epic 7 when
  // the route handler wires the backend to HTTP endpoints.
  describe("integration — full pipeline", () => {
    it("non-streaming happy path: construct → resolve key → complete → result", async () => {
      mockCreate.mockResolvedValueOnce(sampleOpenAIResponse);
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      const ctx = defaultContext();

      const result = await backend.complete(sampleChatRequest, ctx);

      expect(result.response.id).toBe("chatcmpl-abc123");
      expect(result.response.choices[0]!.message.content).toBe(
        "Hello from OpenAI!",
      );
      expect(result.headers["X-Backend-Mode"]).toBe("openai-passthrough");
    });

    it("streaming happy path: construct → resolve key → stream → all chunks → onDone", async () => {
      const content = "Hello!";
      const streamChunks = createTypicalStreamChunks(content);
      // Add usage to final chunk
      const lastChunk = { ...streamChunks[streamChunks.length - 1]! };
      lastChunk.usage = {
        prompt_tokens: 5,
        completion_tokens: 6,
        total_tokens: 11,
      };
      streamChunks[streamChunks.length - 1] = lastChunk;

      mockCreate.mockResolvedValueOnce(createMockOpenAIStream(streamChunks));
      const backend = new OpenAIPassthroughBackend(defaultOptions());
      const { callbacks, chunks, getDoneMetadata } = collectCallbacks();

      await backend.completeStream(
        sampleStreamRequest,
        defaultContext(),
        callbacks,
      );

      // All chunks delivered
      expect(chunks.length).toBe(streamChunks.length);

      // Verify content chunks contain the expected characters
      const contentChunks = chunks
        .map((c) => JSON.parse(c))
        .filter(
          (c: { choices: Array<{ delta: { content?: string } }> }) =>
            c.choices[0]?.delta?.content,
        );
      const reassembled = contentChunks
        .map(
          (c: { choices: Array<{ delta: { content: string } }> }) =>
            c.choices[0].delta.content,
        )
        .join("");
      expect(reassembled).toBe(content);

      // onDone called with correct metadata
      const meta = getDoneMetadata();
      expect(meta).toBeDefined();
      expect(meta!.headers["X-Backend-Mode"]).toBe("openai-passthrough");
      expect(meta!.usage).toEqual({
        prompt_tokens: 5,
        completion_tokens: 6,
        total_tokens: 11,
      });
    });
  });
});
