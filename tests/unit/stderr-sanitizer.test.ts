import { describe, it, expect } from "vitest";
import { sanitizeStderr } from "../../src/utils/stderr-sanitizer.js";

describe("sanitizeStderr()", () => {
  // --- Stack trace stripping ---
  it("strips stack traces from stderr output", () => {
    const input =
      "Error: something failed\n    at Object.<anonymous> (/app/src/index.ts:42:5)\n    at Module._compile (node:internal/modules/cjs/loader:1376:14)";
    const result = sanitizeStderr(input);
    expect(result).not.toContain("at Object.<anonymous>");
    expect(result).not.toContain("at Module._compile");
    expect(result).toContain("Error: something failed");
  });

  it("strips multi-line stack traces", () => {
    const input = [
      "TypeError: Cannot read property",
      "    at foo (/home/user/project/src/bar.ts:10:3)",
      "    at baz (/home/user/project/src/qux.ts:20:7)",
      "    at Object.<anonymous> (/home/user/project/src/main.ts:1:1)",
    ].join("\n");
    const result = sanitizeStderr(input);
    expect(result).not.toContain("at foo");
    expect(result).not.toContain("at baz");
    expect(result).not.toContain("at Object.<anonymous>");
  });

  // --- Unix path replacement ---
  it("replaces Unix absolute paths with [path]", () => {
    const input = "Failed to read /home/user/project/config.json";
    const result = sanitizeStderr(input);
    expect(result).toContain("[path]");
    expect(result).not.toContain("/home/user/project/config.json");
  });

  it("replaces Unix paths with line numbers", () => {
    const input = "Error at /src/utils/handler.ts:42:10";
    const result = sanitizeStderr(input);
    expect(result).toContain("[path]");
    expect(result).not.toContain("/src/utils/handler.ts:42:10");
  });

  // --- Windows path replacement ---
  it("replaces Windows absolute paths with [path]", () => {
    const input = "Cannot find C:\\Users\\dev\\project\\src\\index.ts";
    const result = sanitizeStderr(input);
    expect(result).toContain("[path]");
    expect(result).not.toContain("C:\\Users\\dev\\project\\src\\index.ts");
  });

  // --- Sensitive env var redaction ---
  it("redacts ANTHROPIC_API_KEY assignments", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-secret123 was leaked";
    const result = sanitizeStderr(input);
    expect(result).toContain("[env]");
    expect(result).not.toContain("sk-ant-secret123");
  });

  it("redacts OPENAI_API_KEY assignments", () => {
    const input = "OPENAI_API_KEY=sk-abc123def456 is set";
    const result = sanitizeStderr(input);
    expect(result).toContain("[env]");
    expect(result).not.toContain("sk-abc123def456");
  });

  it("redacts AWS_SECRET_ACCESS_KEY assignments", () => {
    const input = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG something";
    const result = sanitizeStderr(input);
    expect(result).toContain("[env]");
    expect(result).not.toContain("wJalrXUtnFEMI");
  });

  it("redacts AWS_SESSION_TOKEN assignments", () => {
    const input = "AWS_SESSION_TOKEN=FwoGZXIvYXdz... something";
    const result = sanitizeStderr(input);
    expect(result).toContain("[env]");
    expect(result).not.toContain("FwoGZXIvYXdz");
  });

  it("redacts DATABASE_URL assignments", () => {
    const input = "DATABASE_URL=postgres://user:pass@host:5432/db";
    const result = sanitizeStderr(input);
    expect(result).toContain("[env]");
    expect(result).not.toContain("postgres://user:pass");
  });

  it("redacts env vars with SECRET in the name", () => {
    const input = "MY_APP_SECRET=supersecretvalue123 is exposed";
    const result = sanitizeStderr(input);
    expect(result).toContain("[env]");
    expect(result).not.toContain("supersecretvalue123");
  });

  it("redacts env vars with PASSWORD in the name", () => {
    const input = "DB_PASSWORD=hunter2 leaked";
    const result = sanitizeStderr(input);
    expect(result).toContain("[env]");
    expect(result).not.toContain("hunter2");
  });

  it("redacts env vars with TOKEN in the name", () => {
    const input = "GITHUB_TOKEN=ghp_abcdef123456 was set";
    const result = sanitizeStderr(input);
    expect(result).toContain("[env]");
    expect(result).not.toContain("ghp_abcdef123456");
  });

  it("redacts env vars with CREDENTIAL in the name", () => {
    const input = "APP_CREDENTIAL=some-credential-value";
    const result = sanitizeStderr(input);
    expect(result).toContain("[env]");
    expect(result).not.toContain("some-credential-value");
  });

  it("redacts env vars with PRIVATE_KEY in the name", () => {
    const input = "SSL_PRIVATE_KEY=base64encodedkey";
    const result = sanitizeStderr(input);
    expect(result).toContain("[env]");
    expect(result).not.toContain("base64encodedkey");
  });

  // --- Innocuous key=value passthrough ---
  it("does NOT redact innocuous env vars like EXIT_CODE=127", () => {
    const input = "Process exited with EXIT_CODE=127";
    const result = sanitizeStderr(input);
    expect(result).toContain("EXIT_CODE=127");
    expect(result).not.toContain("[env]");
  });

  it("does NOT redact NODE_ENV=production", () => {
    const input = "Running with NODE_ENV=production";
    const result = sanitizeStderr(input);
    expect(result).toContain("NODE_ENV=production");
  });

  it("does NOT redact LOG_LEVEL=debug", () => {
    const input = "LOG_LEVEL=debug";
    const result = sanitizeStderr(input);
    expect(result).toContain("LOG_LEVEL=debug");
  });

  it("does NOT redact PORT=3000", () => {
    const input = "Listening on PORT=3000";
    const result = sanitizeStderr(input);
    expect(result).toContain("PORT=3000");
  });

  // --- Normal message passthrough ---
  it("passes normal messages through unchanged", () => {
    const input = "Server started successfully on port 3000";
    expect(sanitizeStderr(input)).toBe(input);
  });

  it("passes simple error messages through unchanged", () => {
    const input = "Error: connection refused";
    expect(sanitizeStderr(input)).toBe(input);
  });

  // --- Multiple patterns in one string ---
  it("handles multiple sensitive patterns in one string", () => {
    const input =
      "ANTHROPIC_API_KEY=sk-secret123 at /home/user/app/src/index.ts:42:5";
    const result = sanitizeStderr(input);
    expect(result).toContain("[env]");
    expect(result).toContain("[path]");
    expect(result).not.toContain("sk-secret123");
    expect(result).not.toContain("/home/user/app/src/index.ts");
  });

  it("handles stack trace + path + env var in multi-line input", () => {
    const input = [
      "Error: OPENAI_API_KEY=sk-leaked was exposed",
      "    at handler (/app/src/routes/chat.ts:55:12)",
      "    at processRequest (/app/src/server.ts:100:5)",
    ].join("\n");
    const result = sanitizeStderr(input);
    expect(result).toContain("[env]");
    expect(result).not.toContain("sk-leaked");
    expect(result).not.toContain("at handler");
    expect(result).not.toContain("at processRequest");
  });

  // --- Trimming behavior ---
  it("trims leading and trailing whitespace", () => {
    const input = "  some error message  ";
    expect(sanitizeStderr(input)).toBe("some error message");
  });

  it("trims newlines from edges", () => {
    const input = "\n\nError happened\n\n";
    expect(sanitizeStderr(input)).toBe("Error happened");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(sanitizeStderr("   ")).toBe("");
  });
});
