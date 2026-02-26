import { describe, it, expect } from "vitest";
import { resolveMode } from "../../src/services/mode-router.js";
import type { ModeRouterResult } from "../../src/services/mode-router.js";

// Note: Fastify lowercases all incoming HTTP header names per the HTTP/1.1
// spec (RFC 7230 §3.2). Tests use lowercase header keys because that is
// what `resolveMode` will always receive from Fastify's `request.headers`.

function expectMode(result: ModeRouterResult, expected: string) {
  expect("mode" in result).toBe(true);
  if ("mode" in result) {
    expect(result.mode).toBe(expected);
  }
}

function expectError(result: ModeRouterResult, code: string) {
  expect("error" in result).toBe(true);
  if ("error" in result) {
    expect(result.error.code).toBe(code);
  }
}

describe("mode-router", () => {
  describe("resolveMode", () => {
    it("returns OPENAI_PASSTHROUGH when no headers are present", () => {
      const result = resolveMode({});
      expectMode(result, "openai-passthrough");
    });

    it("returns CLAUDE_CODE when X-Claude-Code is true", () => {
      const result = resolveMode({ "x-claude-code": "true" });
      expectMode(result, "claude-code");
    });

    it("returns CLAUDE_CODE for all truthy variants of X-Claude-Code", () => {
      const truthyValues = ["true", "1", "yes", "True", "YES", "Yes", "TRUE"];
      for (const value of truthyValues) {
        const result = resolveMode({ "x-claude-code": value });
        expectMode(result, "claude-code");
      }
    });

    it("returns CLAUDE_CODE when X-Claude-Session-ID is present", () => {
      const result = resolveMode({
        "x-claude-session-id": "550e8400-e29b-41d4-a716-446655440000",
      });
      expectMode(result, "claude-code");
    });

    it("returns OPENAI_PASSTHROUGH when X-Claude-Code is false even with session ID", () => {
      const result = resolveMode({
        "x-claude-code": "false",
        "x-claude-session-id": "550e8400-e29b-41d4-a716-446655440000",
      });
      expectMode(result, "openai-passthrough");
    });

    it("returns OPENAI_PASSTHROUGH for all falsy variants of X-Claude-Code", () => {
      const falsyValues = ["false", "0", "no", "False", "NO", "No", "FALSE"];
      for (const value of falsyValues) {
        const result = resolveMode({ "x-claude-code": value });
        expectMode(result, "openai-passthrough");
      }
    });

    it("returns OPENAI_PASSTHROUGH for all falsy variants even with session ID", () => {
      const falsyValues = ["false", "0", "no", "False", "NO", "No", "FALSE"];
      for (const value of falsyValues) {
        const result = resolveMode({
          "x-claude-code": value,
          "x-claude-session-id": "550e8400-e29b-41d4-a716-446655440000",
        });
        expectMode(result, "openai-passthrough");
      }
    });

    it("returns error for invalid X-Claude-Code value", () => {
      const result = resolveMode({ "x-claude-code": "maybe" });
      expectError(result, "invalid_header_value");
      if ("error" in result) {
        expect(result.error.message).toContain("Invalid X-Claude-Code");
        expect(result.error.message).toContain("true/1/yes");
        expect(result.error.message).toContain("false/0/no");
      }
    });

    it("returns error for numeric invalid X-Claude-Code value", () => {
      const result = resolveMode({ "x-claude-code": "2" });
      expectError(result, "invalid_header_value");
    });

    it("returns error for empty X-Claude-Code value", () => {
      const result = resolveMode({ "x-claude-code": "" });
      expectError(result, "invalid_header_value");
    });

    it("resolves to OPENAI_PASSTHROUGH when no Claude headers present regardless of passthrough config", () => {
      // The router only inspects headers; backend availability is not the router's concern.
      // OPENAI_PASSTHROUGH_ENABLED=false would cause the backend to return 503,
      // but the router still resolves to OPENAI_PASSTHROUGH.
      const result = resolveMode({});
      expectMode(result, "openai-passthrough");
    });

    it("returns CLAUDE_CODE when X-Claude-Code: true takes priority over session ID", () => {
      const result = resolveMode({
        "x-claude-code": "true",
        "x-claude-session-id": "550e8400-e29b-41d4-a716-446655440000",
      });
      expectMode(result, "claude-code");
    });

    describe("array header normalization", () => {
      it("uses first value when X-Claude-Code is an array (duplicate headers)", () => {
        const result = resolveMode({
          "x-claude-code": ["true", "false"],
        });
        expectMode(result, "claude-code");
      });

      it("uses first value when X-Claude-Session-ID is an array", () => {
        const result = resolveMode({
          "x-claude-session-id": [
            "550e8400-e29b-41d4-a716-446655440000",
            "660e8400-e29b-41d4-a716-446655440000",
          ],
        });
        expectMode(result, "claude-code");
      });

      it("returns error when first array value of X-Claude-Code is invalid", () => {
        const result = resolveMode({
          "x-claude-code": ["maybe", "true"],
        });
        expectError(result, "invalid_header_value");
      });
    });
  });
});
