import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "./config.js";
import { healthRoute } from "./routes/health.js";
import { SessionManager } from "./services/session-manager.js";

// Fastify declaration merging is in src/types/fastify.d.ts

export function createServer(config: ServerConfig): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(config.logFormat === "pretty"
        ? { transport: { target: "pino-pretty" } }
        : {}),
    },
  });

  app.decorate("config", config);

  const sessionManager = new SessionManager({
    sessionTtlMs: config.sessionTtlMs,
    maxSessionAgeMs: config.maxSessionAgeMs,
    cleanupIntervalMs: config.sessionCleanupIntervalMs,
  });

  app.decorate("sessionManager", sessionManager);

  app.addHook("onClose", () => sessionManager.destroy());

  app.register(healthRoute);

  return app;
}
