import { describe, it, expect } from "vitest";
import {
  validateChatCompletionInput,
  MAX_MESSAGES,
  MAX_CONTENT_LENGTH,
  MAX_MODEL_LENGTH,
} from "../../src/middleware/input-validation.js";
import { ApiError } from "../../src/errors/handler.js";

describe("validateChatCompletionInput", () => {
  it("passes for valid input", () => {
    expect(() =>
      validateChatCompletionInput({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).not.toThrow();
  });

  it("passes at exactly MAX_MESSAGES", () => {
    const messages = Array.from({ length: MAX_MESSAGES }, (_, i) => ({
      role: "user",
      content: `Message ${i}`,
    }));
    expect(() =>
      validateChatCompletionInput({ model: "gpt-4o", messages }),
    ).not.toThrow();
  });

  it("rejects when messages exceed MAX_MESSAGES", () => {
    const messages = Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => ({
      role: "user",
      content: `Message ${i}`,
    }));
    try {
      validateChatCompletionInput({ model: "gpt-4o", messages });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.body.error.param).toBe("messages");
    }
  });

  it("passes at exactly MAX_CONTENT_LENGTH", () => {
    const content = "a".repeat(MAX_CONTENT_LENGTH);
    expect(() =>
      validateChatCompletionInput({
        model: "gpt-4o",
        messages: [{ role: "user", content }],
      }),
    ).not.toThrow();
  });

  it("rejects when message content exceeds MAX_CONTENT_LENGTH", () => {
    const content = "a".repeat(MAX_CONTENT_LENGTH + 1);
    try {
      validateChatCompletionInput({
        model: "gpt-4o",
        messages: [{ role: "user", content }],
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.body.error.param).toBe("messages");
    }
  });

  it("passes at exactly MAX_MODEL_LENGTH", () => {
    expect(() =>
      validateChatCompletionInput({
        model: "a".repeat(MAX_MODEL_LENGTH),
        messages: [{ role: "user", content: "Hi" }],
      }),
    ).not.toThrow();
  });

  it("rejects when model exceeds MAX_MODEL_LENGTH", () => {
    try {
      validateChatCompletionInput({
        model: "a".repeat(MAX_MODEL_LENGTH + 1),
        messages: [{ role: "user", content: "Hi" }],
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.body.error.param).toBe("model");
    }
  });

  it("handles non-object body gracefully", () => {
    expect(() => validateChatCompletionInput(null)).not.toThrow();
    expect(() => validateChatCompletionInput("string")).not.toThrow();
    expect(() => validateChatCompletionInput(42)).not.toThrow();
  });

  it("handles messages with non-string content", () => {
    expect(() =>
      validateChatCompletionInput({
        model: "gpt-4o",
        messages: [{ role: "user", content: 42 }],
      }),
    ).not.toThrow();
  });

  it("validates text length within array content parts", () => {
    const longText = "a".repeat(MAX_CONTENT_LENGTH + 1);
    try {
      validateChatCompletionInput({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: longText }],
          },
        ],
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.body.error.param).toBe("messages");
      expect(apiErr.body.error.message).toContain("content part");
    }
  });

  it("passes valid array content parts at boundary", () => {
    const validText = "a".repeat(MAX_CONTENT_LENGTH);
    expect(() =>
      validateChatCompletionInput({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: validText },
              { type: "image_url", image_url: { url: "http://example.com" } },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("handles array content parts with non-text parts", () => {
    expect(() =>
      validateChatCompletionInput({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "http://example.com" } },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });
});
