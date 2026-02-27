export type LogLevel =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "silent";

export interface ServerConfig {
  port: number;
  host: string;
  logLevel: LogLevel;
  logFormat: "json" | "pretty";
  apiKeys: string[];
  corsOrigins: string[];

  claudePath: string;
  defaultModel: string;
  anthropicApiKey: string;
  requestTimeoutMs: number;
  maxConcurrentProcesses: number;
  poolQueueTimeoutMs: number;
  shutdownTimeoutMs: number;
  sessionTtlMs: number;
  maxSessionAgeMs: number;
  sessionCleanupIntervalMs: number;

  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiPassthroughEnabled: boolean;
  allowClientOpenaiKey: boolean;
}

const VALID_LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
];

const VALID_LOG_FORMATS = ["json", "pretty"];

function parseIntStrict(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${name} must be a valid integer, got "${value}"`);
  }
  return parsed;
}

const VALID_BOOLEANS = ["true", "false", "1", "0"];

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
  name: string,
): boolean {
  if (value === undefined) return defaultValue;
  const lower = value.toLowerCase();
  if (!VALID_BOOLEANS.includes(lower)) {
    throw new Error(
      `${name} must be "true", "false", "1", or "0", got "${value}"`,
    );
  }
  return lower === "true" || lower === "1";
}

function mergeApiKeys(): string[] {
  const keys = new Set<string>();

  const singleKey = process.env.API_KEY?.trim();
  if (singleKey) {
    keys.add(singleKey);
  }

  const multiKeys = process.env.API_KEYS;
  if (multiKeys) {
    for (const key of multiKeys.split(",")) {
      const trimmed = key.trim();
      if (trimmed) {
        keys.add(trimmed);
      }
    }
  }

  return [...keys];
}

function parseCorsOrigins(): string[] {
  const origins = process.env.CORS_ALLOWED_ORIGINS;
  if (!origins) return [];
  return origins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function loadConfig(): ServerConfig {
  const portStr = process.env.PORT ?? "3456";
  const port = parseIntStrict(portStr, "PORT");
  if (port < 1 || port > 65535) {
    throw new Error(`PORT must be between 1 and 65535, got ${port}`);
  }

  const logLevel = process.env.LOG_LEVEL ?? "info";
  if (!VALID_LOG_LEVELS.includes(logLevel)) {
    throw new Error(
      `LOG_LEVEL must be one of ${VALID_LOG_LEVELS.join(", ")}, got "${logLevel}"`,
    );
  }

  const logFormat = process.env.LOG_FORMAT ?? "json";
  if (!VALID_LOG_FORMATS.includes(logFormat)) {
    throw new Error(
      `LOG_FORMAT must be one of ${VALID_LOG_FORMATS.join(", ")}, got "${logFormat}"`,
    );
  }

  const maxConcurrentStr = process.env.MAX_CONCURRENT_PROCESSES ?? "10";
  const maxConcurrentProcesses = parseIntStrict(
    maxConcurrentStr,
    "MAX_CONCURRENT_PROCESSES",
  );
  if (maxConcurrentProcesses < 1) {
    throw new Error(
      `MAX_CONCURRENT_PROCESSES must be greater than 0, got ${maxConcurrentProcesses}`,
    );
  }

  const requestTimeoutStr = process.env.REQUEST_TIMEOUT_MS ?? "300000";
  const requestTimeoutMs = parseIntStrict(
    requestTimeoutStr,
    "REQUEST_TIMEOUT_MS",
  );

  const poolQueueStr = process.env.POOL_QUEUE_TIMEOUT_MS ?? "5000";
  const poolQueueTimeoutMs = parseIntStrict(
    poolQueueStr,
    "POOL_QUEUE_TIMEOUT_MS",
  );

  const shutdownStr = process.env.SHUTDOWN_TIMEOUT_MS ?? "10000";
  const shutdownTimeoutMs = parseIntStrict(shutdownStr, "SHUTDOWN_TIMEOUT_MS");

  const sessionTtlStr = process.env.SESSION_TTL_MS ?? "3600000";
  const sessionTtlMs = parseIntStrict(sessionTtlStr, "SESSION_TTL_MS");

  const maxSessionAgeStr = process.env.MAX_SESSION_AGE_MS ?? "86400000";
  const maxSessionAgeMs = parseIntStrict(
    maxSessionAgeStr,
    "MAX_SESSION_AGE_MS",
  );

  const sessionCleanupStr = process.env.SESSION_CLEANUP_INTERVAL_MS ?? "60000";
  const sessionCleanupIntervalMs = parseIntStrict(
    sessionCleanupStr,
    "SESSION_CLEANUP_INTERVAL_MS",
  );

  return {
    port,
    host: process.env.HOST ?? "127.0.0.1",
    logLevel: logLevel as LogLevel,
    logFormat: logFormat as "json" | "pretty",
    apiKeys: mergeApiKeys(),
    corsOrigins: parseCorsOrigins(),

    claudePath: process.env.CLAUDE_PATH ?? "claude",
    defaultModel: process.env.DEFAULT_MODEL ?? "sonnet",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    requestTimeoutMs,
    maxConcurrentProcesses,
    poolQueueTimeoutMs,
    shutdownTimeoutMs,
    sessionTtlMs,
    maxSessionAgeMs,
    sessionCleanupIntervalMs,

    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    openaiPassthroughEnabled: parseBoolean(
      process.env.OPENAI_PASSTHROUGH_ENABLED,
      true,
      "OPENAI_PASSTHROUGH_ENABLED",
    ),
    allowClientOpenaiKey: parseBoolean(
      process.env.ALLOW_CLIENT_OPENAI_KEY,
      true,
      "ALLOW_CLIENT_OPENAI_KEY",
    ),
  };
}
