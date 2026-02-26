import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";

describe("GET /health", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = createServer(loadConfig());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns status ready", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", backends: {} });
  });
});
