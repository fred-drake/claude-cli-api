import type { ServerConfig } from "../config.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Readonly<ServerConfig>;
  }
}
