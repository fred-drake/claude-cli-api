import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "./config.js";
import { healthRoute } from "./routes/health.js";

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

  app.register(healthRoute);

  return app;
}
