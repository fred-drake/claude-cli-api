import { describe, it, expect } from "vitest";
import { normalizeHeader, isValidRequestId } from "../../src/utils/headers.js";

describe("utils/headers", () => {
  describe("normalizeHeader", () => {
    it("returns undefined for undefined", () => {
      expect(normalizeHeader(undefined)).toBeUndefined();
    });

    it("returns string as-is", () => {
      expect(normalizeHeader("value")).toBe("value");
    });

    it("returns first element of array", () => {
      expect(normalizeHeader(["first", "second"])).toBe("first");
    });

    it("returns empty string as-is", () => {
      expect(normalizeHeader("")).toBe("");
    });

    it("returns first element of single-element array", () => {
      expect(normalizeHeader(["only"])).toBe("only");
    });
  });

  describe("isValidRequestId", () => {
    it("accepts typical UUIDs", () => {
      expect(isValidRequestId("550e8400-e29b-41d4-a716-446655440000")).toBe(
        true,
      );
    });

    it("accepts alphanumeric strings", () => {
      expect(isValidRequestId("my-request-123")).toBe(true);
    });

    it("accepts printable ASCII characters", () => {
      expect(isValidRequestId("req_id=abc&test")).toBe(true);
    });

    it("rejects empty string", () => {
      expect(isValidRequestId("")).toBe(false);
    });

    it("rejects strings with newlines (header injection)", () => {
      expect(isValidRequestId("bad\nvalue")).toBe(false);
    });

    it("rejects strings with carriage return", () => {
      expect(isValidRequestId("bad\rvalue")).toBe(false);
    });

    it("rejects strings with null byte", () => {
      expect(isValidRequestId("bad\x00value")).toBe(false);
    });

    it("rejects strings longer than 128 characters", () => {
      expect(isValidRequestId("x".repeat(129))).toBe(false);
    });

    it("accepts strings exactly 128 characters", () => {
      expect(isValidRequestId("x".repeat(128))).toBe(true);
    });

    it("rejects strings with tab character", () => {
      expect(isValidRequestId("bad\tvalue")).toBe(false);
    });

    it("rejects strings with space character", () => {
      expect(isValidRequestId("bad value")).toBe(false);
    });
  });
});
