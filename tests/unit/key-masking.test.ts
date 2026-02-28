import { describe, it, expect } from "vitest";
import { maskApiKey } from "../../src/utils/key-masking.js";

describe("utils/key-masking", () => {
  describe("maskApiKey", () => {
    it("masks a typical sk-cca- prefixed key", () => {
      expect(maskApiKey("sk-cca-abcdef1234567f3a")).toBe("sk-cca-****7f3a");
    });

    it("masks a key with sk- prefix (single hyphen prefix)", () => {
      const result = maskApiKey("sk-abcdefghijklmnop");
      expect(result).toContain("****");
      expect(result).toMatch(/mnop$/);
    });

    it("returns **** for short keys (≤8 chars)", () => {
      expect(maskApiKey("short")).toBe("****");
      expect(maskApiKey("12345678")).toBe("****");
    });

    it("returns **** for empty string", () => {
      expect(maskApiKey("")).toBe("****");
    });

    it("handles keys without hyphens", () => {
      const result = maskApiKey("abcdefghijklmnopqrst");
      expect(result).toContain("****");
      expect(result).toMatch(/qrst$/);
      expect(result).not.toContain("abcdefghijklmnop");
    });

    it("never exposes the full key", () => {
      const key = "sk-cca-secret1234567890";
      const masked = maskApiKey(key);
      expect(masked).not.toBe(key);
      expect(masked.length).toBeLessThan(key.length);
    });

    it("preserves last 4 chars for long keys", () => {
      expect(maskApiKey("sk-cca-abcdef1234567f3a")).toMatch(/7f3a$/);
    });

    it("handles a key that is exactly 9 chars", () => {
      const result = maskApiKey("123456789");
      expect(result).toContain("****");
      expect(result).toMatch(/6789$/);
    });
  });
});
