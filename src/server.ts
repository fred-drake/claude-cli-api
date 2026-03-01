import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "./config.js";
import { healthRoute } from "./routes/health.js";
import { modelsRoute } from "./routes/models.js";
import { chatCompletionsRoute } from "./routes/chat-completions.js";
import { SessionManager } from "./services/session-manager.js";
import { OpenAIPassthroughBackend } from "./backends/openai-passthrough.js";
import { ClaudeCodeBackend } from "./backends/claude-code.js";
import { registerErrorHandler, buildOpenAIError } from "./errors/handler.js";
import { isValidRequestId, SECURITY_HEADER_ENTRIES } from "./utils/headers.js";
import { ProcessPool } from "./services/process-pool.js";
import {
  SlidingWindowRateLimiter,
  ConcurrencyLimiter,
} from "./middleware/rate-limiter.js";

// Fastify declaration merging is in src/types/fastify.d.ts

const CORS_METHODS = "POST, GET, OPTIONS";
const CORS_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-Claude-Code",
  "X-Claude-Session-ID",
  "X-OpenAI-API-Key",
  "X-Request-ID",
].join(", ");
const CORS_EXPOSED_HEADERS = [
  "X-Claude-Session-ID",
  "X-Backend-Mode",
  "X-Request-ID",
  "X-Claude-Session-Created",
  "X-Claude-Ignored-Params",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
].join(", ");
const CORS_MAX_AGE = "86400";

export function createServer(config: ServerConfig): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(config.logFormat === "pretty"
        ? { transport: { target: "pino-pretty" } }
        : {}),
    },
    bodyLimit: 1_048_576, // 1 MB (§8.4)
  });

  // --- Config decoration ---
  app.decorate("config", config);

  // --- Session manager ---
  const sessionManager = new SessionManager({
    sessionTtlMs: config.sessionTtlMs,
    maxSessionAgeMs: config.maxSessionAgeMs,
    cleanupIntervalMs: config.sessionCleanupIntervalMs,
  });
  app.decorate("sessionManager", sessionManager);
  app.addHook("onClose", () => sessionManager.destroy());

  // --- Process pool ---
  const processPool = new ProcessPool({
    maxConcurrent: config.maxConcurrentProcesses,
    queueTimeoutMs: config.poolQueueTimeoutMs,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  });
  app.decorate("processPool", processPool);
  app.addHook("onClose", () => processPool.destroy());

  // --- Backend instantiation ---
  const openaiPassthroughBackend = new OpenAIPassthroughBackend({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
    enabled: config.openaiPassthroughEnabled,
    allowClientKey: config.allowClientOpenaiKey,
  });
  app.decorate("openaiPassthroughBackend", openaiPassthroughBackend);

  const claudeCodeBackend = new ClaudeCodeBackend(
    {
      cliPath: config.claudePath,
      enabled: true,
      requestTimeoutMs: config.requestTimeoutMs,
    },
    sessionManager,
    processPool,
  );
  app.decorate("claudeCodeBackend", claudeCodeBackend);

  // --- Rate limiters ---
  const ipRateLimiter = new SlidingWindowRateLimiter(
    config.rateLimitPerIp,
    config.rateLimitWindowMs,
  );
  const sessionRateLimiter = new SlidingWindowRateLimiter(
    config.rateLimitPerSession,
    config.rateLimitWindowMs,
  );
  const concurrencyLimiter = new ConcurrencyLimiter(config.maxConcurrentPerKey);
  app.decorate("ipRateLimiter", ipRateLimiter);
  app.decorate("sessionRateLimiter", sessionRateLimiter);
  app.decorate("concurrencyLimiter", concurrencyLimiter);

  const rateLimitCleanupTimer = setInterval(() => {
    ipRateLimiter.cleanup();
    sessionRateLimiter.cleanup();
  }, config.rateLimitWindowMs);
  rateLimitCleanupTimer.unref();

  app.addHook("onClose", () => {
    clearInterval(rateLimitCleanupTimer);
    ipRateLimiter.destroy();
    sessionRateLimiter.destroy();
    concurrencyLimiter.destroy();
  });

  // --- Shutdown guard hook ---
  // Reject new requests while the server is draining active processes.
  app.addHook("onRequest", (_request, reply, done) => {
    if (processPool.isShuttingDown) {
      reply
        .status(503)
        .send(
          buildOpenAIError(
            "Server is shutting down",
            "server_error",
            "server_shutting_down",
          ),
        );
      done();
      return;
    }
    done();
  });

  // --- Request ID hook (Task 7.7) ---
  // Use client-provided X-Request-ID if valid, otherwise generate one.
  // Validation prevents header injection (newlines, control chars) and
  // log flooding (extremely long values).
  app.addHook("onRequest", (request, reply, done) => {
    const clientId = request.headers["x-request-id"];
    const requestId =
      typeof clientId === "string" && isValidRequestId(clientId)
        ? clientId
        : randomUUID();
    reply.header("X-Request-ID", requestId);
    done();
  });

  // --- CORS hook (Task 7.2) ---
  if (config.corsOrigins.length > 0) {
    const allowedOrigins = new Set(config.corsOrigins);

    app.addHook("onRequest", (request, reply, done) => {
      const origin = request.headers.origin;
      if (origin && allowedOrigins.has(origin)) {
        reply.header("Access-Control-Allow-Origin", origin);
        reply.header("Access-Control-Allow-Methods", CORS_METHODS);
        reply.header("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
        reply.header("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS);
        reply.header("Access-Control-Max-Age", CORS_MAX_AGE);
        // Vary: Origin is required when Access-Control-Allow-Origin is
        // not "*" so caching proxies don't serve stale CORS headers.
        reply.header("Vary", "Origin");

        // Handle preflight — only for matched origins
        if (request.method === "OPTIONS") {
          reply.status(204).send();
          return;
        }
      } else if (origin && request.method === "OPTIONS") {
        // Disallowed origin sent a preflight — return 403 rather than
        // letting it fall through to Fastify's 404 handler.
        reply.status(403).send();
        return;
      }

      done();
    });
  }

  // --- Security headers hook (Task 7.3) ---
  app.addHook("onSend", (_request, reply, payload, done) => {
    for (const [key, value] of SECURITY_HEADER_ENTRIES) {
      reply.header(key, value);
    }
    done(null, payload);
  });

  // --- Error handler (Task 7.8) ---
  registerErrorHandler(app);

  // --- Route registration ---
  // Note: /health and /v1/models are intentionally unprotected by auth and
  // rate limiting. They are lightweight read-only endpoints needed by load
  // balancers and monitoring. Rate limiting is scoped to chatCompletionsRoute.
  app.register(healthRoute);
  app.register(chatCompletionsRoute);
  app.register(modelsRoute);

  return app;
}
