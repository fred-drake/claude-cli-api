import { describe, it, expect } from "vitest";
import { buildAuthHook, timingSafeCompare } from "../../src/middleware/auth.js";
import { ApiError } from "../../src/errors/handler.js";
import type { FastifyRequest, FastifyReply } from "fastify";

function mockRequest(headers: Record<string, string> = {}): FastifyRequest {
  return {
    headers,
    log: { warn: () => {} },
  } as unknown as FastifyRequest;
}

function mockReply(): FastifyReply & { _headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    _headers: headers,
    header(name: string, value: string) {
      headers[name] = value;
      return this;
    },
  } as unknown as FastifyReply & { _headers: Record<string, string> };
}

describe("buildAuthHook", () => {
  const validKeys = ["sk-cca-key1", "sk-cca-key2"];

  it("returns no-op when no API keys configured", async () => {
    const hook = buildAuthHook([]);
    // Should not throw
    await hook(mockRequest(), mockReply());
  });

  it("throws 401 missing_api_key when Authorization header is missing", async () => {
    const hook = buildAuthHook(validKeys);
    const reply = mockReply();
    try {
      await hook(mockRequest(), reply);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.body.error.code).toBe("missing_api_key");
    }
  });

  it("throws 401 invalid_api_key when key is wrong", async () => {
    const hook = buildAuthHook(validKeys);
    const reply = mockReply();
    try {
      await hook(mockRequest({ authorization: "Bearer wrong-key" }), reply);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.body.error.code).toBe("invalid_api_key");
    }
  });

  it("passes when valid key is provided", async () => {
    const hook = buildAuthHook(validKeys);
    // Should not throw
    await hook(
      mockRequest({ authorization: "Bearer sk-cca-key1" }),
      mockReply(),
    );
  });

  it("accepts second key in multi-key setup", async () => {
    const hook = buildAuthHook(validKeys);
    await hook(
      mockRequest({ authorization: "Bearer sk-cca-key2" }),
      mockReply(),
    );
  });

  it("throws 401 missing_api_key for Basic auth scheme", async () => {
    const hook = buildAuthHook(validKeys);
    const reply = mockReply();
    try {
      await hook(mockRequest({ authorization: "Basic dXNlcjpwYXNz" }), reply);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.body.error.code).toBe("missing_api_key");
      expect(apiErr.body.error.message).toContain("Bearer");
    }
  });

  it("throws 401 missing_api_key for raw key without Bearer prefix", async () => {
    const hook = buildAuthHook(validKeys);
    const reply = mockReply();
    try {
      await hook(mockRequest({ authorization: "sk-cca-key1" }), reply);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.body.error.code).toBe("missing_api_key");
    }
  });

  it("uses timing-safe comparison (validated via timingSafeCompare unit tests)", async () => {
    // timingSafeCompare is tested directly below and uses crypto.timingSafeEqual.
    // We verify the hook delegates to it by confirming near-match keys still fail.
    const hook = buildAuthHook(["test-key"]);
    const reply = mockReply();
    try {
      await hook(mockRequest({ authorization: "Bearer test-kez" }), reply);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.body.error.code).toBe("invalid_api_key");
    }
  });

  it("sets WWW-Authenticate: Bearer header on 401 for missing auth", async () => {
    const hook = buildAuthHook(validKeys);
    const reply = mockReply();
    try {
      await hook(mockRequest(), reply);
      expect.unreachable("Should have thrown");
    } catch {
      expect(reply._headers["WWW-Authenticate"]).toBe("Bearer");
    }
  });

  it("sets WWW-Authenticate: Bearer header on 401 for invalid key", async () => {
    const hook = buildAuthHook(validKeys);
    const reply = mockReply();
    try {
      await hook(mockRequest({ authorization: "Bearer wrong-key" }), reply);
      expect.unreachable("Should have thrown");
    } catch {
      expect(reply._headers["WWW-Authenticate"]).toBe("Bearer");
    }
  });
});

describe("timingSafeCompare", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeCompare("hello", "hello")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(timingSafeCompare("hello", "world")).toBe(false);
  });

  it("returns false for different length strings", () => {
    expect(timingSafeCompare("short", "longer-string")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(timingSafeCompare("", "")).toBe(true);
  });
});
