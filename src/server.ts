import Fastify from "fastify";
import type { ServerConfig } from "./config.js";
import { healthRoute } from "./routes/health.js";

export function createServer(config: ServerConfig) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(config.logFormat === "pretty"
        ? { transport: { target: "pino-pretty" } }
        : {}),
    },
  });

  app.register(healthRoute);

  return app;
}
