import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import { injectRequest, expectOpenAIError } from "../helpers/index.js";

const mockBackendResult = {
  response: {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  },
  headers: { "X-Backend-Mode": "openai-passthrough" },
};

const payload = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
};

describe("Auth middleware (integration)", () => {
  describe("auth enabled (apiKeys configured)", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const config = {
        ...loadConfig(),
        apiKeys: ["sk-cca-test-key1", "sk-cca-test-key2"],
      };
      app = createServer(config);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("rejects missing Authorization header with 401 missing_api_key", async () => {
      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload,
      });

      expect(response.statusCode).toBe(401);
      expectOpenAIError(response.json(), {
        code: "missing_api_key",
        type: "invalid_request_error",
        message: "Missing Authorization header",
      });
    });

    it("includes WWW-Authenticate: Bearer header on 401", async () => {
      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload,
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe("Bearer");
    });

    it("rejects wrong Bearer token with 401 invalid_api_key", async () => {
      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer sk-cca-wrong-key" },
        payload,
      });

      expect(response.statusCode).toBe(401);
      expectOpenAIError(response.json(), {
        code: "invalid_api_key",
        type: "invalid_request_error",
        message: "Invalid API key",
      });
    });

    it("rejects non-Bearer authorization scheme with 401", async () => {
      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { authorization: "Basic abc123" },
        payload,
      });

      expect(response.statusCode).toBe(401);
      expectOpenAIError(response.json(), {
        code: "missing_api_key",
        type: "invalid_request_error",
      });
    });

    it("accepts valid key and proceeds to backend", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue(
        mockBackendResult,
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer sk-cca-test-key1" },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(mockBackendResult.response);
    });

    it("accepts second configured key", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue(
        mockBackendResult,
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer sk-cca-test-key2" },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(mockBackendResult.response);
    });

    it("health endpoint is accessible without auth", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);
    });

    it("models endpoint is accessible without auth", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe("auth disabled (no apiKeys configured)", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const config = {
        ...loadConfig(),
        apiKeys: [],
      };
      app = createServer(config);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("passes requests without Authorization header", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue(
        mockBackendResult,
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(mockBackendResult.response);
    });

    it("passes requests with any Authorization header", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue(
        mockBackendResult,
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer sk-anything" },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(mockBackendResult.response);
    });
  });
});

describe("Rate limiting (integration)", () => {
  describe("per-IP rate limit", () => {
    // Each test group gets a fresh server to avoid test coupling (m6).
    let app: FastifyInstance;
    const IP_LIMIT = 3;

    beforeAll(async () => {
      const config = {
        ...loadConfig(),
        apiKeys: [],
        rateLimitPerIp: IP_LIMIT,
        rateLimitPerSession: 100,
        maxConcurrentPerKey: 100,
        rateLimitWindowMs: 60000,
      };
      app = createServer(config);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("allows exactly N requests and then returns 429", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue(
        mockBackendResult,
      );

      // With limit=3, exactly 3 requests succeed (the Nth request is allowed).
      for (let i = 0; i < IP_LIMIT; i++) {
        const response = await injectRequest(app, {
          url: "/v1/chat/completions",
          payload,
        });
        expect(response.statusCode).toBe(200);
      }

      // The (N+1)th request is rejected
      const blocked = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload,
      });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
      expectOpenAIError(blocked.json(), {
        code: "rate_limit_exceeded",
        type: "rate_limit_error",
        message: "Rate limit exceeded",
      });
    });
  });

  describe("rate limit headers", () => {
    // Fresh server avoids coupling with other rate limit tests (m6).
    let app: FastifyInstance;
    const IP_LIMIT = 10;

    beforeAll(async () => {
      const config = {
        ...loadConfig(),
        apiKeys: [],
        rateLimitPerIp: IP_LIMIT,
        rateLimitPerSession: 100,
        maxConcurrentPerKey: 100,
        rateLimitWindowMs: 60000,
      };
      app = createServer(config);
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it("includes X-RateLimit-* headers on successful responses", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue(
        mockBackendResult,
      );

      const response = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-ratelimit-limit"]).toBe(String(IP_LIMIT));
      expect(response.headers["x-ratelimit-remaining"]).toBeDefined();
      expect(response.headers["x-ratelimit-reset"]).toBeDefined();
    });

    it("decrements remaining count with each request", async () => {
      vi.spyOn(app.openaiPassthroughBackend, "complete").mockResolvedValue(
        mockBackendResult,
      );

      const first = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload,
      });
      const firstRemaining = Number(first.headers["x-ratelimit-remaining"]);

      const second = await injectRequest(app, {
        url: "/v1/chat/completions",
        payload,
      });
      const secondRemaining = Number(second.headers["x-ratelimit-remaining"]);

      expect(secondRemaining).toBeLessThan(firstRemaining);
    });
  });
});
