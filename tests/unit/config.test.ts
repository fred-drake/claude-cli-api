import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear all config-related env vars
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_FORMAT;
    delete process.env.API_KEY;
    delete process.env.API_KEYS;
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_PATH;
    delete process.env.DEFAULT_MODEL;
    delete process.env.REQUEST_TIMEOUT_MS;
    delete process.env.MAX_CONCURRENT_PROCESSES;
    delete process.env.POOL_QUEUE_TIMEOUT_MS;
    delete process.env.SHUTDOWN_TIMEOUT_MS;
    delete process.env.SESSION_TTL_MS;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_PASSTHROUGH_ENABLED;
    delete process.env.ALLOW_CLIENT_OPENAI_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("defaults", () => {
    it("loads default values when no env vars are set", () => {
      const config = loadConfig();

      expect(config.port).toBe(3456);
      expect(config.host).toBe("127.0.0.1");
      expect(config.logLevel).toBe("info");
      expect(config.logFormat).toBe("json");
      expect(config.apiKeys).toEqual([]);
      expect(config.corsOrigins).toEqual([]);
      expect(config.claudePath).toBe("claude");
      expect(config.defaultModel).toBe("sonnet");
      expect(config.anthropicApiKey).toBe("");
      expect(config.requestTimeoutMs).toBe(300_000);
      expect(config.maxConcurrentProcesses).toBe(10);
      expect(config.poolQueueTimeoutMs).toBe(5_000);
      expect(config.shutdownTimeoutMs).toBe(10_000);
      expect(config.sessionTtlMs).toBe(3_600_000);
      expect(config.openaiApiKey).toBe("");
      expect(config.openaiBaseUrl).toBe("https://api.openai.com/v1");
      expect(config.openaiPassthroughEnabled).toBe(true);
      expect(config.allowClientOpenaiKey).toBe(true);
    });
  });

  describe("env var overrides", () => {
    it("reads PORT from environment", () => {
      process.env.PORT = "8080";
      const config = loadConfig();
      expect(config.port).toBe(8080);
    });

    it("reads HOST from environment", () => {
      process.env.HOST = "0.0.0.0";
      const config = loadConfig();
      expect(config.host).toBe("0.0.0.0");
    });

    it("reads LOG_LEVEL from environment", () => {
      process.env.LOG_LEVEL = "debug";
      const config = loadConfig();
      expect(config.logLevel).toBe("debug");
    });

    it("reads LOG_FORMAT from environment", () => {
      process.env.LOG_FORMAT = "pretty";
      const config = loadConfig();
      expect(config.logFormat).toBe("pretty");
    });

    it("reads ANTHROPIC_API_KEY from environment", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      const config = loadConfig();
      expect(config.anthropicApiKey).toBe("sk-ant-test");
    });

    it("reads numeric values correctly", () => {
      process.env.REQUEST_TIMEOUT_MS = "60000";
      process.env.MAX_CONCURRENT_PROCESSES = "20";
      process.env.POOL_QUEUE_TIMEOUT_MS = "10000";
      process.env.SHUTDOWN_TIMEOUT_MS = "15000";
      process.env.SESSION_TTL_MS = "7200000";
      const config = loadConfig();
      expect(config.requestTimeoutMs).toBe(60_000);
      expect(config.maxConcurrentProcesses).toBe(20);
      expect(config.poolQueueTimeoutMs).toBe(10_000);
      expect(config.shutdownTimeoutMs).toBe(15_000);
      expect(config.sessionTtlMs).toBe(7_200_000);
    });

    it("reads boolean OPENAI_PASSTHROUGH_ENABLED=false", () => {
      process.env.OPENAI_PASSTHROUGH_ENABLED = "false";
      const config = loadConfig();
      expect(config.openaiPassthroughEnabled).toBe(false);
    });

    it("reads boolean OPENAI_PASSTHROUGH_ENABLED=0 as false", () => {
      process.env.OPENAI_PASSTHROUGH_ENABLED = "0";
      const config = loadConfig();
      expect(config.openaiPassthroughEnabled).toBe(false);
    });

    it("reads boolean OPENAI_PASSTHROUGH_ENABLED=1 as true", () => {
      process.env.OPENAI_PASSTHROUGH_ENABLED = "1";
      const config = loadConfig();
      expect(config.openaiPassthroughEnabled).toBe(true);
    });

    it("reads boolean ALLOW_CLIENT_OPENAI_KEY=false", () => {
      process.env.ALLOW_CLIENT_OPENAI_KEY = "false";
      const config = loadConfig();
      expect(config.allowClientOpenaiKey).toBe(false);
    });
  });

  describe("API key merging", () => {
    it("loads single API_KEY into apiKeys array", () => {
      process.env.API_KEY = "sk-cca-single";
      const config = loadConfig();
      expect(config.apiKeys).toEqual(["sk-cca-single"]);
    });

    it("loads comma-separated API_KEYS into array", () => {
      process.env.API_KEYS = "sk-cca-key1,sk-cca-key2";
      const config = loadConfig();
      expect(config.apiKeys).toEqual(["sk-cca-key1", "sk-cca-key2"]);
    });

    it("merges API_KEY and API_KEYS, deduplicating", () => {
      process.env.API_KEY = "sk-cca-key1";
      process.env.API_KEYS = "sk-cca-key1,sk-cca-key2,sk-cca-key3";
      const config = loadConfig();
      expect(config.apiKeys).toEqual([
        "sk-cca-key1",
        "sk-cca-key2",
        "sk-cca-key3",
      ]);
    });

    it("trims whitespace from API_KEYS entries", () => {
      process.env.API_KEYS = " sk-cca-a , sk-cca-b ";
      const config = loadConfig();
      expect(config.apiKeys).toEqual(["sk-cca-a", "sk-cca-b"]);
    });

    it("filters empty strings from API_KEYS", () => {
      process.env.API_KEYS = "sk-cca-a,,sk-cca-b,";
      const config = loadConfig();
      expect(config.apiKeys).toEqual(["sk-cca-a", "sk-cca-b"]);
    });
  });

  describe("CORS origins", () => {
    it("parses comma-separated CORS_ALLOWED_ORIGINS", () => {
      process.env.CORS_ALLOWED_ORIGINS =
        "http://localhost:3000,https://app.example.com";
      const config = loadConfig();
      expect(config.corsOrigins).toEqual([
        "http://localhost:3000",
        "https://app.example.com",
      ]);
    });
  });

  describe("validation", () => {
    it("rejects PORT below 1", () => {
      process.env.PORT = "0";
      expect(() => loadConfig()).toThrow(/PORT/);
    });

    it("rejects PORT above 65535", () => {
      process.env.PORT = "70000";
      expect(() => loadConfig()).toThrow(/PORT/);
    });

    it("rejects non-numeric PORT", () => {
      process.env.PORT = "abc";
      expect(() => loadConfig()).toThrow(/PORT/);
    });

    it("rejects invalid LOG_LEVEL", () => {
      process.env.LOG_LEVEL = "verbose";
      expect(() => loadConfig()).toThrow(/LOG_LEVEL/);
    });

    it("accepts all valid Pino log levels", () => {
      const validLevels = [
        "fatal",
        "error",
        "warn",
        "info",
        "debug",
        "trace",
        "silent",
      ];
      for (const level of validLevels) {
        process.env.LOG_LEVEL = level;
        const config = loadConfig();
        expect(config.logLevel).toBe(level);
      }
    });

    it("rejects invalid LOG_FORMAT", () => {
      process.env.LOG_FORMAT = "xml";
      expect(() => loadConfig()).toThrow(/LOG_FORMAT/);
    });

    it("rejects MAX_CONCURRENT_PROCESSES of 0", () => {
      process.env.MAX_CONCURRENT_PROCESSES = "0";
      expect(() => loadConfig()).toThrow(/MAX_CONCURRENT_PROCESSES/);
    });

    it("rejects negative MAX_CONCURRENT_PROCESSES", () => {
      process.env.MAX_CONCURRENT_PROCESSES = "-1";
      expect(() => loadConfig()).toThrow(/MAX_CONCURRENT_PROCESSES/);
    });

    it("rejects non-numeric REQUEST_TIMEOUT_MS", () => {
      process.env.REQUEST_TIMEOUT_MS = "fast";
      expect(() => loadConfig()).toThrow(/REQUEST_TIMEOUT_MS/);
    });

    it("rejects invalid boolean OPENAI_PASSTHROUGH_ENABLED", () => {
      process.env.OPENAI_PASSTHROUGH_ENABLED = "banana";
      expect(() => loadConfig()).toThrow(/OPENAI_PASSTHROUGH_ENABLED/);
    });

    it("rejects invalid boolean ALLOW_CLIENT_OPENAI_KEY", () => {
      process.env.ALLOW_CLIENT_OPENAI_KEY = "yes";
      expect(() => loadConfig()).toThrow(/ALLOW_CLIENT_OPENAI_KEY/);
    });
  });
});
