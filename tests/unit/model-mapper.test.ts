import { describe, it, expect } from "vitest";
import { mapModel } from "../../src/services/model-mapper.js";

describe("mapModel()", () => {
  describe("exact matches", () => {
    it.each([
      ["claude-opus-4-6", "claude-opus-4-6"],
      ["claude-sonnet-4-6", "claude-sonnet-4-6"],
      ["claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"],
      ["opus", "opus"],
      ["sonnet", "sonnet"],
      ["haiku", "haiku"],
      ["gpt-4", "opus"],
      ["gpt-4-turbo", "sonnet"],
      ["gpt-4o", "sonnet"],
      ["gpt-4o-mini", "haiku"],
      ["gpt-3.5-turbo", "haiku"],
      ["gpt-4-turbo-preview", "sonnet"],
      ["chatgpt-4o-latest", "sonnet"],
      ["gpt-4.1", "sonnet"],
    ])("maps '%s' → '%s'", (input, expected) => {
      const result = mapModel(input);
      expect("resolvedModel" in result).toBe(true);
      if ("resolvedModel" in result) {
        expect(result.resolvedModel).toBe(expected);
      }
    });
  });

  describe("prefix patterns", () => {
    it("maps gpt-4o-2024-08-06 → sonnet", () => {
      const result = mapModel("gpt-4o-2024-08-06");
      expect("resolvedModel" in result).toBe(true);
      if ("resolvedModel" in result) {
        expect(result.resolvedModel).toBe("sonnet");
      }
    });

    it("maps gpt-4-turbo-2024-04-09 → sonnet", () => {
      const result = mapModel("gpt-4-turbo-2024-04-09");
      expect("resolvedModel" in result).toBe(true);
      if ("resolvedModel" in result) {
        expect(result.resolvedModel).toBe("sonnet");
      }
    });

    it("maps gpt-3.5-turbo-0125 → haiku", () => {
      const result = mapModel("gpt-3.5-turbo-0125");
      expect("resolvedModel" in result).toBe(true);
      if ("resolvedModel" in result) {
        expect(result.resolvedModel).toBe("haiku");
      }
    });

    it("maps gpt-3.5-turbo-1106 → haiku", () => {
      const result = mapModel("gpt-3.5-turbo-1106");
      expect("resolvedModel" in result).toBe(true);
      if ("resolvedModel" in result) {
        expect(result.resolvedModel).toBe("haiku");
      }
    });
  });

  describe("unknown models", () => {
    it("returns error for 'o1'", () => {
      const result = mapModel("o1");
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error.error.code).toBe("model_not_found");
        expect(result.error.error.type).toBe("invalid_request_error");
        expect(result.error.error.param).toBe("model");
        expect(result.error.error.message).toContain("o1");
        expect(result.error.error.message).toContain("not supported");
      }
    });

    it("returns error for 'o1-mini'", () => {
      const result = mapModel("o1-mini");
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error.error.code).toBe("model_not_found");
      }
    });

    it("returns error for empty string", () => {
      const result = mapModel("");
      expect("error" in result).toBe(true);
    });

    it("error message lists valid model names", () => {
      const result = mapModel("unknown-model");
      expect("error" in result).toBe(true);
      if ("error" in result) {
        const msg = result.error.error.message;
        expect(msg).toContain("claude-opus-4-6");
        expect(msg).toContain("gpt-4o");
        expect(msg).toContain("haiku");
      }
    });

    it("returns error for 'dall-e-3'", () => {
      const result = mapModel("dall-e-3");
      expect("error" in result).toBe(true);
    });
  });
});
