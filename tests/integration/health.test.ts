import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import type { HealthStatus } from "../../src/backends/types.js";

describe("GET /health", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = createServer(loadConfig());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns §4.4 schema with version and checks", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    const body = response.json();
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("checks");
    expect(body.checks).toHaveProperty("claude_cli");
    expect(body.checks).toHaveProperty("anthropic_key");
    expect(body.checks).toHaveProperty("openai_passthrough");
    expect(body.checks).toHaveProperty("capacity");
  });

  it("returns version string", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    const body = response.json();
    expect(typeof body.version).toBe("string");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("returns capacity with active and max", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    const body = response.json();
    expect(body.checks.capacity).toHaveProperty("active");
    expect(body.checks.capacity).toHaveProperty("max");
    expect(typeof body.checks.capacity.active).toBe("number");
    expect(typeof body.checks.capacity.max).toBe("number");
  });

  it("includes security headers", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("includes X-Request-ID header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.headers["x-request-id"]).toBeDefined();
  });
});

describe("GET /health — backend status scenarios", () => {
  it("returns 200 when at least one backend is ok", async () => {
    const app = createServer(loadConfig());
    await app.ready();

    // Mock one backend ok
    vi.spyOn(app.claudeCodeBackend, "healthCheck").mockResolvedValue({
      status: "ok",
    } as HealthStatus);
    vi.spyOn(app.openaiPassthroughBackend, "healthCheck").mockResolvedValue({
      status: "error",
      message: "Connection failed",
    } as HealthStatus);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ready");
    expect(body.checks.claude_cli).toBe("ok");
    expect(body.checks.openai_passthrough).toBe("error");

    await app.close();
  });

  it("returns 200 when only openai passthrough is ok", async () => {
    const app = createServer(loadConfig());
    await app.ready();

    vi.spyOn(app.claudeCodeBackend, "healthCheck").mockResolvedValue({
      status: "missing",
    } as HealthStatus);
    vi.spyOn(app.openaiPassthroughBackend, "healthCheck").mockResolvedValue({
      status: "ok",
    } as HealthStatus);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ready");

    await app.close();
  });

  it("returns 503 when no backends are ok", async () => {
    const app = createServer(loadConfig());
    await app.ready();

    vi.spyOn(app.claudeCodeBackend, "healthCheck").mockResolvedValue({
      status: "missing",
    } as HealthStatus);
    vi.spyOn(app.openaiPassthroughBackend, "healthCheck").mockResolvedValue({
      status: "no_key",
    } as HealthStatus);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("unavailable");

    await app.close();
  });

  it("returns 503 when both backends disabled", async () => {
    const app = createServer(loadConfig());
    await app.ready();

    vi.spyOn(app.claudeCodeBackend, "healthCheck").mockResolvedValue({
      status: "disabled",
    } as HealthStatus);
    vi.spyOn(app.openaiPassthroughBackend, "healthCheck").mockResolvedValue({
      status: "disabled",
    } as HealthStatus);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("unavailable");
    expect(body.checks.claude_cli).toBe("disabled");
    expect(body.checks.openai_passthrough).toBe("disabled");

    await app.close();
  });

  it("reports anthropic_key as missing when not configured", async () => {
    const config = loadConfig();
    // loadConfig reads ANTHROPIC_API_KEY from env; default is ""
    const app = createServer({ ...config, anthropicApiKey: "" });
    await app.ready();

    vi.spyOn(app.claudeCodeBackend, "healthCheck").mockResolvedValue({
      status: "ok",
    } as HealthStatus);
    vi.spyOn(app.openaiPassthroughBackend, "healthCheck").mockResolvedValue({
      status: "ok",
    } as HealthStatus);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    const body = response.json();
    expect(body.checks.anthropic_key).toBe("missing");

    await app.close();
  });

  it("reports anthropic_key as ok when configured", async () => {
    const config = loadConfig();
    const app = createServer({ ...config, anthropicApiKey: "sk-ant-test" });
    await app.ready();

    vi.spyOn(app.claudeCodeBackend, "healthCheck").mockResolvedValue({
      status: "ok",
    } as HealthStatus);
    vi.spyOn(app.openaiPassthroughBackend, "healthCheck").mockResolvedValue({
      status: "ok",
    } as HealthStatus);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    const body = response.json();
    expect(body.checks.anthropic_key).toBe("ok");

    await app.close();
  });
});
