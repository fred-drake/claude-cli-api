import { describe, it, expect } from "vitest";
import {
  validateParams,
  buildPrompt,
  buildCliArgs,
  buildSanitizedEnv,
} from "../../src/transformers/request.js";
import type { ChatCompletionRequest } from "../../src/types/openai.js";

function baseRequest(
  overrides: Partial<ChatCompletionRequest> = {},
): ChatCompletionRequest {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

describe("validateParams()", () => {
  describe("Tier 3 rejection", () => {
    it.each([
      "tools",
      "tool_choice",
      "functions",
      "function_call",
      "response_format",
      "logprobs",
      "top_logprobs",
      "logit_bias",
    ])("rejects '%s' with unsupported_parameter", (param) => {
      const request = baseRequest({ [param]: "some-value" });
      const result = validateParams(request);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error.error.code).toBe("unsupported_parameter");
        expect(result.error.error.param).toBe(param);
        expect(result.error.error.type).toBe("invalid_request_error");
      }
    });

    it("rejects n > 1", () => {
      const request = baseRequest({ n: 2 } as ChatCompletionRequest);
      const result = validateParams(request);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error.error.code).toBe("unsupported_parameter");
        expect(result.error.error.param).toBe("n");
      }
    });
  });

  describe("Tier 2 collection", () => {
    it("collects temperature as ignored", () => {
      const request = baseRequest({ temperature: 0.7 });
      const result = validateParams(request);
      expect("ignoredParams" in result).toBe(true);
      if ("ignoredParams" in result) {
        expect(result.ignoredParams).toContain("temperature");
      }
    });

    it("collects multiple ignored params", () => {
      const request = baseRequest({
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 1024,
      });
      const result = validateParams(request);
      expect("ignoredParams" in result).toBe(true);
      if ("ignoredParams" in result) {
        expect(result.ignoredParams).toContain("temperature");
        expect(result.ignoredParams).toContain("top_p");
        expect(result.ignoredParams).toContain("max_tokens");
      }
    });

    it("n=1 is accepted and added to ignored", () => {
      const request = baseRequest({ n: 1 } as ChatCompletionRequest);
      const result = validateParams(request);
      expect("ignoredParams" in result).toBe(true);
      if ("ignoredParams" in result) {
        expect(result.ignoredParams).toContain("n");
      }
    });

    it("returns empty array when no Tier 2 params present", () => {
      const request = baseRequest();
      const result = validateParams(request);
      expect("ignoredParams" in result).toBe(true);
      if ("ignoredParams" in result) {
        expect(result.ignoredParams).toHaveLength(0);
      }
    });
  });
});

describe("buildPrompt()", () => {
  it("returns single user message content as-is", () => {
    const result = buildPrompt(
      [{ role: "user", content: "Hello world" }],
      false,
    );
    expect(result.prompt).toBe("Hello world");
    expect(result.systemPrompt).toBeUndefined();
  });

  it("extracts system messages into systemPrompt", () => {
    const result = buildPrompt(
      [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
      ],
      false,
    );
    expect(result.systemPrompt).toBe("You are helpful");
    expect(result.prompt).toBe("Hello");
  });

  it("concatenates multiple system messages", () => {
    const result = buildPrompt(
      [
        { role: "system", content: "Be helpful" },
        { role: "system", content: "Be concise" },
        { role: "user", content: "Hello" },
      ],
      false,
    );
    expect(result.systemPrompt).toBe("Be helpful\n\nBe concise");
  });

  it("formats multi-turn with User/Assistant labels", () => {
    const result = buildPrompt(
      [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "How are you?" },
      ],
      false,
    );
    expect(result.prompt).toBe(
      "User: Hi\nAssistant: Hello!\nUser: How are you?",
    );
  });

  it("resume session uses last user message only", () => {
    const result = buildPrompt(
      [
        { role: "user", content: "First" },
        { role: "assistant", content: "Response" },
        { role: "user", content: "Second" },
      ],
      true,
    );
    expect(result.prompt).toBe("Second");
  });

  it("resume with trailing assistant message uses last user message", () => {
    const result = buildPrompt(
      [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ],
      true,
    );
    expect(result.prompt).toBe("Hello");
  });

  it("resume with multiple turns ending in assistant uses last user message", () => {
    const result = buildPrompt(
      [
        { role: "user", content: "First" },
        { role: "assistant", content: "Response 1" },
        { role: "user", content: "Second" },
        { role: "assistant", content: "Response 2" },
      ],
      true,
    );
    expect(result.prompt).toBe("Second");
  });

  it("resume with only assistant messages throws", () => {
    expect(() =>
      buildPrompt([{ role: "assistant", content: "Hello" }], true),
    ).toThrow("No user messages provided for resume");
  });

  it("throws on empty non-system messages", () => {
    expect(() =>
      buildPrompt([{ role: "system", content: "sys" }], false),
    ).toThrow("No user or assistant messages");
  });

  it("handles non-string content (array)", () => {
    const result = buildPrompt(
      [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      false,
    );
    expect(result.prompt).toContain("Hello");
  });

  it("throws on empty string content for single message", () => {
    expect(() => buildPrompt([{ role: "user", content: "" }], false)).toThrow(
      "Empty message content",
    );
  });
});

describe("buildCliArgs()", () => {
  const defaultOptions = {
    outputFormat: "json" as const,
    prompt: "Hello",
    resolvedModel: "sonnet",
    sessionId: "test-session-id",
    sessionAction: "created" as const,
  };

  it("includes --output-format", () => {
    const args = buildCliArgs(defaultOptions);
    const idx = args.indexOf("--output-format");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("json");
  });

  it("includes --model with resolved model name", () => {
    const args = buildCliArgs(defaultOptions);
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("sonnet");
  });

  it("includes --dangerously-skip-permissions", () => {
    const args = buildCliArgs(defaultOptions);
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("includes --tools with empty string", () => {
    const args = buildCliArgs(defaultOptions);
    const idx = args.indexOf("--tools");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("");
  });

  it("uses --session-id for new sessions", () => {
    const args = buildCliArgs(defaultOptions);
    expect(args).toContain("--session-id");
    expect(args).not.toContain("--resume");
  });

  it("uses --resume for resumed sessions", () => {
    const args = buildCliArgs({
      ...defaultOptions,
      sessionAction: "resumed",
    });
    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
  });

  it("includes --system-prompt when provided", () => {
    const args = buildCliArgs({
      ...defaultOptions,
      systemPrompt: "Be helpful",
    });
    const idx = args.indexOf("--system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("Be helpful");
  });

  it("does not include --system-prompt when not provided", () => {
    const args = buildCliArgs(defaultOptions);
    expect(args).not.toContain("--system-prompt");
  });

  it("includes -p with prompt", () => {
    const args = buildCliArgs(defaultOptions);
    const idx = args.indexOf("-p");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("Hello");
  });

  it("omits -p when useStdin is true", () => {
    const args = buildCliArgs({ ...defaultOptions, useStdin: true });
    expect(args).not.toContain("-p");
  });

  it("includes --verbose and --include-partial-messages when streaming", () => {
    const args = buildCliArgs({ ...defaultOptions, streaming: true });
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
  });

  it("does NOT include --max-tokens", () => {
    const args = buildCliArgs(defaultOptions);
    expect(args).not.toContain("--max-tokens");
  });

  it("uses stream-json for streaming output format", () => {
    const args = buildCliArgs({
      ...defaultOptions,
      outputFormat: "stream-json",
      streaming: true,
    });
    const idx = args.indexOf("--output-format");
    expect(args[idx + 1]).toBe("stream-json");
  });
});

describe("buildSanitizedEnv()", () => {
  it("always includes TERM=dumb", () => {
    const env = buildSanitizedEnv({});
    expect(env.TERM).toBe("dumb");
  });

  it("passes through allowlisted env vars", () => {
    const env = buildSanitizedEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      LANG: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant-123",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-123");
  });

  it("filters out non-allowlisted env vars", () => {
    const env = buildSanitizedEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      SECRET_KEY: "should-not-appear",
      OPENAI_API_KEY: "should-not-appear",
      AWS_SECRET_KEY: "should-not-appear",
    });
    expect(env.SECRET_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_KEY).toBeUndefined();
  });

  it("provides HOME fallback to /tmp", () => {
    const env = buildSanitizedEnv({});
    expect(env.HOME).toBe("/tmp");
  });

  it("provides PATH fallback to standard paths", () => {
    const env = buildSanitizedEnv({});
    expect(env.PATH).toContain("/usr/bin");
  });

  it("provides LANG fallback to en_US.UTF-8", () => {
    const env = buildSanitizedEnv({});
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it("does not override provided values with fallbacks", () => {
    const env = buildSanitizedEnv({
      HOME: "/custom/home",
      PATH: "/custom/path",
      LANG: "fr_FR.UTF-8",
    });
    expect(env.HOME).toBe("/custom/home");
    expect(env.PATH).toBe("/custom/path");
    expect(env.LANG).toBe("fr_FR.UTF-8");
  });

  it("uses process.env when no env parameter provided", () => {
    const env = buildSanitizedEnv();
    expect(env.TERM).toBe("dumb");
    // Should at minimum have fallbacks
    expect(env.HOME).toBeDefined();
    expect(env.PATH).toBeDefined();
    expect(env.LANG).toBeDefined();
  });
});
