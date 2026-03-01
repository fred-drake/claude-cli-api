import { describe, it, expect } from "vitest";
import { redactSecrets } from "../../src/utils/secret-scanner.js";
import { StreamAdapter } from "../../src/transformers/stream.js";
import type { ChatCompletionChunk } from "../../src/types/openai.js";
import { collectCallbacks } from "../helpers/index.js";

describe("redactSecrets()", () => {
  it("redacts Anthropic API keys (sk-ant-...)", () => {
    const input = "key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    expect(redactSecrets(input)).toBe("key is [REDACTED]");
  });

  it("redacts OpenAI-style API keys (sk-... with 20+ chars)", () => {
    const input = "key is sk-abcdefghijklmnopqrstuvwxyz";
    expect(redactSecrets(input)).toBe("key is [REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const input =
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def";
    expect(redactSecrets(input)).toBe("Authorization: [REDACTED]");
  });

  it("redacts AWS access key IDs (AKIA...)", () => {
    const input = "aws_access_key_id = AKIAIOSFODNN7EXAMPLE";
    expect(redactSecrets(input)).toBe("aws_access_key_id = [REDACTED]");
  });

  it("redacts PEM private key blocks", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBogIBAAJBALRiMLAHudeSA/x3hB2f+2NRkJLA",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(redactSecrets(input)).toBe("[REDACTED]");
  });

  it("passes normal text through unchanged", () => {
    const input = "Hello! How can I help you today?";
    expect(redactSecrets(input)).toBe(input);
  });

  it("redacts multiple secrets in one string", () => {
    const input =
      "keys: sk-ant-api03-abcdefghijklmnopqrst and AKIAIOSFODNN7EXAMPLE";
    const result = redactSecrets(input);
    expect(result).toBe("keys: [REDACTED] and [REDACTED]");
  });

  it("does NOT redact short partial matches (sk- followed by < 20 chars)", () => {
    const input = "sk-short is not a key";
    expect(redactSecrets(input)).toBe(input);
  });

  // --- GitHub tokens ---
  it("redacts GitHub personal access tokens (ghp_)", () => {
    const input = "token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm";
    expect(redactSecrets(input)).toBe("token is [REDACTED]");
  });

  it("redacts GitHub OAuth tokens (gho_)", () => {
    const input = "token is gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm";
    expect(redactSecrets(input)).toBe("token is [REDACTED]");
  });

  // --- Google API keys ---
  it("redacts Google API keys (AIza...)", () => {
    const input = "key is AIzaSyA1234567890abcdefghijklmnopqrstuv";
    expect(redactSecrets(input)).toBe("key is [REDACTED]");
  });

  it("does NOT redact strings that only partially match Google API key pattern", () => {
    const input = "AIzaShort is not a key";
    expect(redactSecrets(input)).toBe(input);
  });

  // --- Connection strings ---
  it("redacts mongodb:// connection strings", () => {
    const input = "uri is mongodb://admin:pass123@localhost:27017/mydb";
    expect(redactSecrets(input)).toBe("uri is [REDACTED]");
  });

  it("redacts mongodb+srv:// connection strings", () => {
    const input = "uri is mongodb+srv://user:secret@cluster0.example.net/test";
    expect(redactSecrets(input)).toBe("uri is [REDACTED]");
  });

  it("redacts postgres:// connection strings", () => {
    const input = "db is postgres://user:password@host:5432/dbname";
    expect(redactSecrets(input)).toBe("db is [REDACTED]");
  });

  it("redacts postgresql:// connection strings", () => {
    const input = "db is postgresql://user:password@host:5432/dbname";
    expect(redactSecrets(input)).toBe("db is [REDACTED]");
  });

  it("redacts mysql:// connection strings", () => {
    const input = "db is mysql://root:secret@localhost:3306/app";
    expect(redactSecrets(input)).toBe("db is [REDACTED]");
  });

  it("redacts redis:// connection strings", () => {
    const input = "cache is redis://default:mypassword@redis.host:6379";
    expect(redactSecrets(input)).toBe("cache is [REDACTED]");
  });

  it("does NOT redact connection strings without credentials", () => {
    expect(redactSecrets("redis://localhost:6379")).toBe(
      "redis://localhost:6379",
    );
    expect(redactSecrets("postgres://localhost:5432/mydb")).toBe(
      "postgres://localhost:5432/mydb",
    );
    expect(redactSecrets("mongodb://localhost:27017/test")).toBe(
      "mongodb://localhost:27017/test",
    );
  });

  describe("StreamAdapter integration", () => {
    it("redacts secrets in content_block_delta text", () => {
      const adapter = new StreamAdapter({
        requestId: "req-scan",
        model: "gpt-4o",
      });
      const { callbacks, chunks } = collectCallbacks();

      // Feed content_block_start first
      adapter.processLine(
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          session_id: "sess-1",
        }),
        callbacks,
      );

      // Feed a content_block_delta containing a secret
      adapter.processLine(
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "Your key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
            },
          },
          session_id: "sess-1",
        }),
        callbacks,
      );

      expect(chunks).toHaveLength(2); // role chunk + content chunk
      const contentChunk = JSON.parse(chunks[1]!) as ChatCompletionChunk;
      expect(contentChunk.choices[0]!.delta.content).toBe(
        "Your key is [REDACTED]",
      );
    });
  });
});
