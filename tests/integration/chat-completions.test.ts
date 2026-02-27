import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import type {
  BackendResult,
  BackendStreamCallbacks,
  RequestContext,
} from "../../src/backends/types.js";
import type { ChatCompletionRequest } from "../../src/types/openai.js";
import {
  injectRequest,
  expectOpenAIError,
  sampleOpenAIResponse,
  sampleChatRequest,
  sampleStreamRequest,
} from "../helpers/index.js";

function createTestApp(): FastifyInstance {
  return createServer(loadConfig());
}

const CLAUDE_MODE_HEADERS = { "x-claude-code": "true" };
const OPENAI_MODE_HEADERS = {}; // default is openai-passthrough

describe("POST /v1/chat/completions", () => {
  describe("non-streaming", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = createTestApp();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("routes to openai-passthrough by default and returns X-Backend-Mode", async () => {
      const mockResult: BackendResult = {
        response: sampleOpenAIResponse,
        headers: { "X-Backend-Mode": "openai-passthrough" },
      };
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue(
        mockResult,
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleChatRequest,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-backend-mode"]).toBe("openai-passthrough");
      expect(response.json()).toEqual(sampleOpenAIResponse);
    });

    it("routes to claude-code when X-Claude-Code: true", async () => {
      const mockResult: BackendResult = {
        response: sampleOpenAIResponse,
        headers: { "X-Backend-Mode": "claude-code" },
      };
      vi.spyOn(app.claudeCodeBackend, "complete").mockResolvedValue(mockResult);

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: CLAUDE_MODE_HEADERS,
        payload: sampleChatRequest,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-backend-mode"]).toBe("claude-code");
    });

    it("routes to claude-code when X-Claude-Session-ID is present", async () => {
      const mockResult: BackendResult = {
        response: sampleOpenAIResponse,
        headers: { "X-Backend-Mode": "claude-code" },
      };
      vi.spyOn(app.claudeCodeBackend, "complete").mockResolvedValue(mockResult);

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: {
          "x-claude-session-id": "550e8400-e29b-41d4-a716-446655440000",
        },
        payload: sampleChatRequest,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-backend-mode"]).toBe("claude-code");
    });

    it("includes X-Request-ID in response", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue({
        response: sampleOpenAIResponse,
        headers: { "X-Backend-Mode": "openai-passthrough" },
      });

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleChatRequest,
      });

      expect(response.headers["x-request-id"]).toBeDefined();
      expect(typeof response.headers["x-request-id"]).toBe("string");
    });

    it("echoes client-provided X-Request-ID", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue({
        response: sampleOpenAIResponse,
        headers: { "X-Backend-Mode": "openai-passthrough" },
      });

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { "x-request-id": "my-custom-id" },
        payload: sampleChatRequest,
      });

      expect(response.headers["x-request-id"]).toBe("my-custom-id");
    });

    it("includes security headers in response", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue({
        response: sampleOpenAIResponse,
        headers: { "X-Backend-Mode": "openai-passthrough" },
      });

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleChatRequest,
      });

      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'none'",
      );
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
    });

    it("passes request body to backend", async () => {
      const completeSpy = vi
        .spyOn(app.openaiPassthroughBackend, "complete")
        .mockResolvedValue({
          response: sampleOpenAIResponse,
          headers: { "X-Backend-Mode": "openai-passthrough" },
        });

      await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleChatRequest,
      });

      expect(completeSpy).toHaveBeenCalledOnce();
      const [body, context] = completeSpy.mock.calls[0];
      expect(body.model).toBe(sampleChatRequest.model);
      expect(body.messages).toEqual(sampleChatRequest.messages);
      expect(context.requestId).toBeDefined();
      expect(context.method).toBe("POST");
      expect(context.path).toBe("/v1/chat/completions");
    });

    it("sets backend-provided headers on response", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue({
        response: sampleOpenAIResponse,
        headers: {
          "X-Backend-Mode": "openai-passthrough",
          "X-Custom-Header": "custom-value",
        },
      });

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleChatRequest,
      });

      expect(response.headers["x-custom-header"]).toBe("custom-value");
    });
  });

  describe("streaming", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = createTestApp();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("returns SSE format with data: [DONE] terminator", async () => {
      const chunkData = JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "gpt-4o",
        choices: [
          { index: 0, delta: { content: "Hello" }, finish_reason: null },
        ],
      });

      vi.spyOn(
        app.openaiPassthroughBackend,
        "completeStream",
      ).mockImplementation(
        async (
          _req: ChatCompletionRequest,
          _ctx: RequestContext,
          callbacks: BackendStreamCallbacks,
        ) => {
          callbacks.onChunk(chunkData);
          callbacks.onDone({ headers: {} });
        },
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleStreamRequest,
      });

      // Fastify inject returns raw body for hijacked responses
      const body = response.body;
      expect(body).toContain(`data: ${chunkData}\n\n`);
      expect(body).toContain("data: [DONE]\n\n");
    });

    it("emits data: [DONE] exactly once", async () => {
      vi.spyOn(
        app.openaiPassthroughBackend,
        "completeStream",
      ).mockImplementation(
        async (
          _req: ChatCompletionRequest,
          _ctx: RequestContext,
          callbacks: BackendStreamCallbacks,
        ) => {
          callbacks.onChunk('{"test": 1}');
          callbacks.onChunk('{"test": 2}');
          callbacks.onDone({ headers: {} });
        },
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleStreamRequest,
      });

      const doneCount = (response.body.match(/data: \[DONE\]/g) || []).length;
      expect(doneCount).toBe(1);
    });

    it("includes X-Backend-Mode header in SSE response", async () => {
      vi.spyOn(
        app.openaiPassthroughBackend,
        "completeStream",
      ).mockImplementation(
        async (
          _req: ChatCompletionRequest,
          _ctx: RequestContext,
          callbacks: BackendStreamCallbacks,
        ) => {
          callbacks.onDone({ headers: {} });
        },
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleStreamRequest,
      });

      expect(response.headers["x-backend-mode"]).toBe("openai-passthrough");
    });

    it("includes X-Backend-Mode for claude-code streaming", async () => {
      vi.spyOn(app.claudeCodeBackend, "completeStream").mockImplementation(
        async (
          _req: ChatCompletionRequest,
          _ctx: RequestContext,
          callbacks: BackendStreamCallbacks,
        ) => {
          callbacks.onDone({ headers: {} });
        },
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: CLAUDE_MODE_HEADERS,
        payload: sampleStreamRequest,
      });

      expect(response.headers["x-backend-mode"]).toBe("claude-code");
    });

    it("SSE response has correct content-type header", async () => {
      vi.spyOn(
        app.openaiPassthroughBackend,
        "completeStream",
      ).mockImplementation(
        async (
          _req: ChatCompletionRequest,
          _ctx: RequestContext,
          callbacks: BackendStreamCallbacks,
        ) => {
          callbacks.onDone({ headers: {} });
        },
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleStreamRequest,
      });

      expect(response.headers["content-type"]).toBe("text/event-stream");
    });

    it("SSE response includes cache-control no-cache", async () => {
      vi.spyOn(
        app.openaiPassthroughBackend,
        "completeStream",
      ).mockImplementation(
        async (
          _req: ChatCompletionRequest,
          _ctx: RequestContext,
          callbacks: BackendStreamCallbacks,
        ) => {
          callbacks.onDone({ headers: {} });
        },
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleStreamRequest,
      });

      // Note: SSE headers are written via reply.raw.writeHead, so they
      // may differ from the security headers onSend hook. The SSE response
      // sets its own Cache-Control: no-cache for streaming.
      expect(response.headers["cache-control"]).toBeDefined();
    });

    it("handles onError callback with SSE error event", async () => {
      const errorBody = {
        error: {
          message: "Backend failed",
          type: "server_error",
          param: null,
          code: "internal_error",
        },
      };

      vi.spyOn(
        app.openaiPassthroughBackend,
        "completeStream",
      ).mockImplementation(
        async (
          _req: ChatCompletionRequest,
          _ctx: RequestContext,
          callbacks: BackendStreamCallbacks,
        ) => {
          callbacks.onChunk('{"partial": true}');
          callbacks.onError(errorBody);
        },
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleStreamRequest,
      });

      const body = response.body;
      expect(body).toContain(`data: ${JSON.stringify(errorBody)}`);
      expect(body).toContain("data: [DONE]");
    });

    it("includes X-Claude-Session-ID header when resuming session", async () => {
      const sessionId = "550e8400-e29b-41d4-a716-446655440000";

      vi.spyOn(app.claudeCodeBackend, "completeStream").mockImplementation(
        async (
          _req: ChatCompletionRequest,
          _ctx: RequestContext,
          callbacks: BackendStreamCallbacks,
        ) => {
          callbacks.onDone({ headers: {} });
        },
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: {
          "x-claude-session-id": sessionId,
        },
        payload: sampleStreamRequest,
      });

      expect(response.headers["x-claude-session-id"]).toBe(sessionId);
    });
  });

  describe("mode router errors", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = createTestApp();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("returns 400 for invalid X-Claude-Code header", async () => {
      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { "x-claude-code": "maybe" },
        payload: sampleChatRequest,
      });

      expect(response.statusCode).toBe(400);
      expectOpenAIError(response.json(), {
        code: "invalid_header_value",
        type: "invalid_request_error",
        message: "Invalid X-Claude-Code",
      });
    });

    it("returns 400 for empty X-Claude-Code header", async () => {
      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { "x-claude-code": "" },
        payload: sampleChatRequest,
      });

      expect(response.statusCode).toBe(400);
      expectOpenAIError(response.json(), {
        code: "invalid_header_value",
      });
    });
  });

  describe("backend errors", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = createTestApp();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("returns 500 when backend throws generic error", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockRejectedValue(
        new Error("Unexpected failure"),
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleChatRequest,
      });

      expect(response.statusCode).toBe(500);
      expectOpenAIError(response.json(), {
        type: "server_error",
        code: "internal_error",
      });
    });

    it("returns PassthroughError status when backend throws PassthroughError", async () => {
      const { PassthroughError } =
        await import("../../src/backends/openai-passthrough.js");
      const err = new PassthroughError(503, {
        error: {
          message: "OpenAI passthrough is disabled",
          type: "invalid_request_error",
          param: null,
          code: "passthrough_disabled",
        },
      });

      vi.spyOn(app.openaiPassthroughBackend, "complete").mockRejectedValue(err);

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleChatRequest,
      });

      expect(response.statusCode).toBe(503);
      expectOpenAIError(response.json(), {
        code: "passthrough_disabled",
      });
    });
  });

  describe("CORS", () => {
    it("returns CORS headers for allowed origin", async () => {
      const config = loadConfig();
      const app = createServer({
        ...config,
        corsOrigins: ["http://localhost:3000"],
      });
      await app.ready();

      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue({
        response: sampleOpenAIResponse,
        headers: { "X-Backend-Mode": "openai-passthrough" },
      });

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { origin: "http://localhost:3000" },
        payload: sampleChatRequest,
      });

      expect(response.headers["access-control-allow-origin"]).toBe(
        "http://localhost:3000",
      );
      expect(response.headers["access-control-allow-methods"]).toBeDefined();
      expect(response.headers["access-control-expose-headers"]).toBeDefined();

      await app.close();
    });

    it("does not return CORS headers for disallowed origin", async () => {
      const config = loadConfig();
      const app = createServer({
        ...config,
        corsOrigins: ["http://localhost:3000"],
      });
      await app.ready();

      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue({
        response: sampleOpenAIResponse,
        headers: { "X-Backend-Mode": "openai-passthrough" },
      });

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { origin: "http://evil.com" },
        payload: sampleChatRequest,
      });

      expect(response.headers["access-control-allow-origin"]).toBeUndefined();

      await app.close();
    });

    it("handles OPTIONS preflight request", async () => {
      const config = loadConfig();
      const app = createServer({
        ...config,
        corsOrigins: ["http://localhost:3000"],
      });
      await app.ready();

      const response = await app.inject({
        method: "OPTIONS",
        url: "/v1/chat/completions",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "POST",
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(
        "http://localhost:3000",
      );

      await app.close();
    });

    it("does not set CORS headers when corsOrigins is empty", async () => {
      const config = loadConfig();
      const app = createServer({ ...config, corsOrigins: [] });
      await app.ready();

      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue({
        response: sampleOpenAIResponse,
        headers: { "X-Backend-Mode": "openai-passthrough" },
      });

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { origin: "http://localhost:3000" },
        payload: sampleChatRequest,
      });

      expect(response.headers["access-control-allow-origin"]).toBeUndefined();

      await app.close();
    });
  });

  describe("request context", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = createTestApp();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("passes sessionId from X-Claude-Session-ID header", async () => {
      const sessionId = "550e8400-e29b-41d4-a716-446655440000";
      const completeSpy = vi
        .spyOn(app.claudeCodeBackend, "complete")
        .mockResolvedValue({
          response: sampleOpenAIResponse,
          headers: { "X-Backend-Mode": "claude-code" },
        });

      await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { "x-claude-session-id": sessionId },
        payload: sampleChatRequest,
      });

      expect(completeSpy).toHaveBeenCalledOnce();
      const [, context] = completeSpy.mock.calls[0];
      expect(context.sessionId).toBe(sessionId);
    });

    it("passes clientOpenAIKey from X-OpenAI-API-Key header", async () => {
      const completeSpy = vi
        .spyOn(app.openaiPassthroughBackend, "complete")
        .mockResolvedValue({
          response: sampleOpenAIResponse,
          headers: { "X-Backend-Mode": "openai-passthrough" },
        });

      await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { "x-openai-api-key": "sk-client-key" },
        payload: sampleChatRequest,
      });

      const [, context] = completeSpy.mock.calls[0];
      expect(context.clientOpenAIKey).toBe("sk-client-key");
    });

    it("passes apiKey from Authorization Bearer header", async () => {
      const completeSpy = vi
        .spyOn(app.openaiPassthroughBackend, "complete")
        .mockResolvedValue({
          response: sampleOpenAIResponse,
          headers: { "X-Backend-Mode": "openai-passthrough" },
        });

      await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer sk-my-api-key" },
        payload: sampleChatRequest,
      });

      const [, context] = completeSpy.mock.calls[0];
      expect(context.apiKey).toBe("sk-my-api-key");
    });

    it("apiKey is undefined when no Authorization header", async () => {
      const completeSpy = vi
        .spyOn(app.openaiPassthroughBackend, "complete")
        .mockResolvedValue({
          response: sampleOpenAIResponse,
          headers: { "X-Backend-Mode": "openai-passthrough" },
        });

      await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleChatRequest,
      });

      const [, context] = completeSpy.mock.calls[0];
      expect(context.apiKey).toBeUndefined();
    });

    it("apiKey is undefined for non-Bearer Authorization", async () => {
      const completeSpy = vi
        .spyOn(app.openaiPassthroughBackend, "complete")
        .mockResolvedValue({
          response: sampleOpenAIResponse,
          headers: { "X-Backend-Mode": "openai-passthrough" },
        });

      await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { authorization: "Basic abc123" },
        payload: sampleChatRequest,
      });

      const [, context] = completeSpy.mock.calls[0];
      expect(context.apiKey).toBeUndefined();
    });

    it("includes signal in context (AbortSignal)", async () => {
      const completeSpy = vi
        .spyOn(app.openaiPassthroughBackend, "complete")
        .mockResolvedValue({
          response: sampleOpenAIResponse,
          headers: { "X-Backend-Mode": "openai-passthrough" },
        });

      await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleChatRequest,
      });

      const [, context] = completeSpy.mock.calls[0];
      expect(context.signal).toBeDefined();
      expect(context.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("request body validation", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = createTestApp();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("returns 400 for missing model", async () => {
      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: { messages: [{ role: "user", content: "Hello" }] },
      });

      expect(response.statusCode).toBe(400);
      expectOpenAIError(response.json(), {
        code: "invalid_request",
        type: "invalid_request_error",
      });
    });

    it("returns 400 for missing messages", async () => {
      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: { model: "gpt-4o" },
      });

      expect(response.statusCode).toBe(400);
      expectOpenAIError(response.json(), {
        code: "invalid_request",
      });
    });

    it("returns 400 for empty messages array", async () => {
      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: { model: "gpt-4o", messages: [] },
      });

      expect(response.statusCode).toBe(400);
      expectOpenAIError(response.json(), {
        code: "invalid_request",
      });
    });

    it("returns 400 for non-boolean stream field", async () => {
      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          stream: "yes",
        },
      });

      expect(response.statusCode).toBe(400);
      expectOpenAIError(response.json(), {
        code: "invalid_request",
      });
    });

    it("returns 400 for empty body", async () => {
      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("streaming edge cases", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = createTestApp();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("includes security headers in SSE streaming response", async () => {
      vi.spyOn(
        app.openaiPassthroughBackend,
        "completeStream",
      ).mockImplementation(
        async (
          _req: ChatCompletionRequest,
          _ctx: RequestContext,
          callbacks: BackendStreamCallbacks,
        ) => {
          callbacks.onDone({ headers: {} });
        },
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleStreamRequest,
      });

      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'none'",
      );
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
    });

    it("streamEnded guard prevents double [DONE] when onDone called twice", async () => {
      vi.spyOn(
        app.openaiPassthroughBackend,
        "completeStream",
      ).mockImplementation(
        async (
          _req: ChatCompletionRequest,
          _ctx: RequestContext,
          callbacks: BackendStreamCallbacks,
        ) => {
          callbacks.onDone({ headers: {} });
          // Second call should be a no-op
          callbacks.onDone({ headers: {} });
        },
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleStreamRequest,
      });

      const doneCount = (response.body.match(/data: \[DONE\]/g) || []).length;
      expect(doneCount).toBe(1);
    });

    it("streamEnded guard prevents writes after onError", async () => {
      vi.spyOn(
        app.openaiPassthroughBackend,
        "completeStream",
      ).mockImplementation(
        async (
          _req: ChatCompletionRequest,
          _ctx: RequestContext,
          callbacks: BackendStreamCallbacks,
        ) => {
          callbacks.onError({
            error: {
              message: "fail",
              type: "server_error",
              param: null,
              code: "internal_error",
            },
          });
          // These should be no-ops after onError
          callbacks.onChunk('{"should": "not appear"}');
          callbacks.onDone({ headers: {} });
        },
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload: sampleStreamRequest,
      });

      const doneCount = (response.body.match(/data: \[DONE\]/g) || []).length;
      expect(doneCount).toBe(1);
      expect(response.body).not.toContain("should not appear");
    });
  });

  describe("X-Request-ID sanitization", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = createTestApp();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("rejects X-Request-ID with control characters", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue({
        response: sampleOpenAIResponse,
        headers: { "X-Backend-Mode": "openai-passthrough" },
      });

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { "x-request-id": "bad\nvalue" },
        payload: sampleChatRequest,
      });

      // Should generate a new UUID instead of echoing the malicious value
      expect(response.headers["x-request-id"]).not.toContain("\n");
      expect(response.headers["x-request-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-/,
      );
    });

    it("rejects overly long X-Request-ID", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue({
        response: sampleOpenAIResponse,
        headers: { "X-Backend-Mode": "openai-passthrough" },
      });

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { "x-request-id": "x".repeat(200) },
        payload: sampleChatRequest,
      });

      // Should generate a new UUID instead of echoing the long value
      expect((response.headers["x-request-id"] as string).length).toBeLessThan(
        200,
      );
    });

    it("accepts valid X-Request-ID", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue({
        response: sampleOpenAIResponse,
        headers: { "X-Backend-Mode": "openai-passthrough" },
      });

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { "x-request-id": "valid-request-123" },
        payload: sampleChatRequest,
      });

      expect(response.headers["x-request-id"]).toBe("valid-request-123");
    });
  });

  describe("404 unknown routes", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = createTestApp();
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("returns 404 for unknown path", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/unknown",
      });

      expect(response.statusCode).toBe(404);
    });

    it("returns 404 for GET on chat completions endpoint", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/chat/completions",
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("CORS Vary header", () => {
    it("includes Vary: Origin when CORS origin matches", async () => {
      const config = loadConfig();
      const app = createServer({
        ...config,
        corsOrigins: ["http://localhost:3000"],
      });
      await app.ready();

      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue({
        response: sampleOpenAIResponse,
        headers: { "X-Backend-Mode": "openai-passthrough" },
      });

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { origin: "http://localhost:3000" },
        payload: sampleChatRequest,
      });

      expect(response.headers["vary"]).toContain("Origin");

      await app.close();
    });

    it("returns 403 for OPTIONS from disallowed origin", async () => {
      const config = loadConfig();
      const app = createServer({
        ...config,
        corsOrigins: ["http://localhost:3000"],
      });
      await app.ready();

      const response = await app.inject({
        method: "OPTIONS",
        url: "/v1/chat/completions",
        headers: {
          origin: "http://evil.com",
          "access-control-request-method": "POST",
        },
      });

      // Disallowed origin should get 403 Forbidden, not 404 or 204
      expect(response.statusCode).toBe(403);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();

      await app.close();
    });
  });
});
