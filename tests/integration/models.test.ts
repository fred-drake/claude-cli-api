import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";

describe("GET /v1/models", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = createServer(loadConfig());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 200 with Claude model list", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(3);
  });

  it("includes claude-opus-4-6 model", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
    });

    const body = response.json();
    const opus = body.data.find(
      (m: { id: string }) => m.id === "claude-opus-4-6",
    );
    expect(opus).toBeDefined();
    expect(opus.object).toBe("model");
    expect(opus.owned_by).toBe("anthropic");
    expect(typeof opus.created).toBe("number");
  });

  it("includes claude-sonnet-4-6 model", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
    });

    const body = response.json();
    const sonnet = body.data.find(
      (m: { id: string }) => m.id === "claude-sonnet-4-6",
    );
    expect(sonnet).toBeDefined();
    expect(sonnet.object).toBe("model");
    expect(sonnet.owned_by).toBe("anthropic");
  });

  it("includes claude-haiku-4-5 model", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
    });

    const body = response.json();
    const haiku = body.data.find(
      (m: { id: string }) => m.id === "claude-haiku-4-5",
    );
    expect(haiku).toBeDefined();
    expect(haiku.object).toBe("model");
    expect(haiku.owned_by).toBe("anthropic");
  });

  it("all models have required OpenAI model fields", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
    });

    const body = response.json();
    for (const model of body.data) {
      expect(model).toHaveProperty("id");
      expect(model).toHaveProperty("object");
      expect(model).toHaveProperty("created");
      expect(model).toHaveProperty("owned_by");
      expect(model).toHaveProperty("permission");
      expect(model.object).toBe("model");
      expect(typeof model.id).toBe("string");
      expect(typeof model.created).toBe("number");
      expect(typeof model.owned_by).toBe("string");
      expect(Array.isArray(model.permission)).toBe(true);
    }
  });

  it("includes security headers", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
    });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'",
    );
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("includes X-Request-ID header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
    });

    expect(response.headers["x-request-id"]).toBeDefined();
    expect(typeof response.headers["x-request-id"]).toBe("string");
  });

  it("echoes back client-provided X-Request-ID", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        "x-request-id": "client-req-123",
      },
    });

    expect(response.headers["x-request-id"]).toBe("client-req-123");
  });
});
