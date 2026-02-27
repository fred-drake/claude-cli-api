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
import { registerErrorHandler } from "./errors/handler.js";
import { isValidRequestId } from "./utils/headers.js";

// Fastify declaration merging is in src/types/fastify.d.ts

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'",
  "Referrer-Policy": "no-referrer",
} as const;

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

  // --- Backend instantiation ---
  const openaiPassthroughBackend = new OpenAIPassthroughBackend({
    apiKey: config.openaiApiKey,
    baseURL: config.openaiBaseUrl,
    enabled: config.openaiPassthroughEnabled,
    allowClientKey: config.allowClientOpenaiKey,
  });
  app.decorate("openaiPassthroughBackend", openaiPassthroughBackend);

  const claudeCodeBackend = new ClaudeCodeBackend(
    { cliPath: config.claudePath, enabled: true },
    sessionManager,
  );
  app.decorate("claudeCodeBackend", claudeCodeBackend);

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
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      reply.header(key, value);
    }
    done(null, payload);
  });

  // --- Error handler (Task 7.8) ---
  registerErrorHandler(app);

  // --- Route registration ---
  app.register(healthRoute);
  app.register(chatCompletionsRoute);
  app.register(modelsRoute);

  return app;
}
