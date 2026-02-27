import type { ServerConfig } from "../config.js";
import type { SessionManager } from "../services/session-manager.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Readonly<ServerConfig>;
    sessionManager: SessionManager;
  }
}
