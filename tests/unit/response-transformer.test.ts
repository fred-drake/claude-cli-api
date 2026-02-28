import { describe, it, expect } from "vitest";
import {
  transformCliResult,
  detectAuthFailure,
} from "../../src/transformers/response.js";
import type { ClaudeCliResult } from "../../src/types/claude-cli.js";

const sampleCliResult: ClaudeCliResult = {
  type: "result",
  subtype: "success",
  session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  is_error: false,
  result: "Hello! How can I help you today?",
  duration_ms: 1523,
  num_turns: 1,
  total_cost_usd: 0.003,
  usage: {
    input_tokens: 25,
    output_tokens: 12,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

const sampleCliErrorResult: ClaudeCliResult = {
  type: "result",
  subtype: "error_during_execution",
  session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  is_error: true,
  result: "An error occurred during execution",
  duration_ms: 500,
  num_turns: 1,
  total_cost_usd: 0.001,
  usage: {
    input_tokens: 25,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

describe("transformCliResult()", () => {
  it("maps successful CLI result to OpenAI response", () => {
    const result = transformCliResult(
      sampleCliResult,
      "gpt-4o",
      "req-001",
      1700000000,
    );

    expect("response" in result).toBe(true);
    if ("response" in result) {
      expect(result.status).toBe(200);
      expect(result.response.id).toBe("chatcmpl-req-001");
      expect(result.response.object).toBe("chat.completion");
      expect(result.response.model).toBe("gpt-4o");
      expect(result.response.created).toBe(1700000000);
      expect(result.response.choices).toHaveLength(1);
      expect(result.response.choices[0]!.index).toBe(0);
      expect(result.response.choices[0]!.message.role).toBe("assistant");
      expect(result.response.choices[0]!.message.content).toBe(
        "Hello! How can I help you today?",
      );
      expect(result.response.choices[0]!.finish_reason).toBe("stop");
    }
  });

  it("maps usage correctly (input_tokens → prompt_tokens)", () => {
    const result = transformCliResult(
      sampleCliResult,
      "gpt-4o",
      "req-001",
      1700000000,
    );

    if ("response" in result) {
      expect(result.response.usage.prompt_tokens).toBe(25);
      expect(result.response.usage.completion_tokens).toBe(12);
      expect(result.response.usage.total_tokens).toBe(37);
    }
  });

  it("echoes original model name (not resolved name)", () => {
    const result = transformCliResult(
      sampleCliResult,
      "gpt-4o",
      "req-001",
      1700000000,
    );

    if ("response" in result) {
      expect(result.response.model).toBe("gpt-4o");
    }
  });

  it("maps is_error: true to 500 with backend_error code", () => {
    const result = transformCliResult(
      sampleCliErrorResult,
      "gpt-4o",
      "req-001",
      1700000000,
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.status).toBe(500);
      expect(result.error.error.code).toBe("backend_error");
      expect(result.error.error.type).toBe("server_error");
      expect(result.error.error.message).toContain("error occurred");
    }
  });

  it("includes X-Backend-Mode header", () => {
    const result = transformCliResult(
      sampleCliResult,
      "gpt-4o",
      "req-001",
      1700000000,
    );
    expect(result.headers["X-Backend-Mode"]).toBe("claude-code");
  });

  it("uses current timestamp when created not provided", () => {
    const before = Math.floor(Date.now() / 1000);
    const result = transformCliResult(sampleCliResult, "gpt-4o", "req-001");
    const after = Math.floor(Date.now() / 1000);

    if ("response" in result) {
      expect(result.response.created).toBeGreaterThanOrEqual(before);
      expect(result.response.created).toBeLessThanOrEqual(after);
    }
  });

  it("uses provided created timestamp", () => {
    const result = transformCliResult(
      sampleCliResult,
      "gpt-4o",
      "req-001",
      1234567890,
    );

    if ("response" in result) {
      expect(result.response.created).toBe(1234567890);
    }
  });
});

describe("detectAuthFailure()", () => {
  it("detects 'Invalid API key' pattern", () => {
    expect(
      detectAuthFailure(
        "Error: Invalid API key. Please check your ANTHROPIC_API_KEY.",
      ),
    ).toBe(true);
  });

  it("detects 'ANTHROPIC_API_KEY' pattern", () => {
    expect(
      detectAuthFailure("ANTHROPIC_API_KEY environment variable is not set"),
    ).toBe(true);
  });

  it("detects 'authentication' pattern (case-insensitive)", () => {
    expect(detectAuthFailure("Authentication failed for API request")).toBe(
      true,
    );
  });

  it("detects 'unauthorized' pattern (case-insensitive)", () => {
    expect(detectAuthFailure("Unauthorized access to API")).toBe(true);
  });

  it("returns false for generic error messages", () => {
    expect(detectAuthFailure("Connection timed out")).toBe(false);
  });

  it("returns false for empty stderr", () => {
    expect(detectAuthFailure("")).toBe(false);
  });

  it("returns false for unrelated error", () => {
    expect(detectAuthFailure("Error: Rate limit exceeded")).toBe(false);
  });
});
