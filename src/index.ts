import type { FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const app = createServer(config);

// Slightly above default keep-alive to allow in-flight requests to finish
const HEADERS_TIMEOUT = 65_000;
// Buffer above per-request CLI timeout to avoid premature socket closure
const REQUEST_TIMEOUT = config.requestTimeoutMs + 10_000;
// Standard keep-alive interval for persistent connections
const KEEP_ALIVE_TIMEOUT = 60_000;
// Hard timeout to force exit if graceful shutdown stalls
const HARD_SHUTDOWN_MS = 30_000;

let shutdownPromise: Promise<void> | null = null;

export function gracefulShutdown(instance: FastifyInstance): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    instance.log.info("Graceful shutdown initiated");

    try {
      await instance.processPool.drainAll();
    } catch (err) {
      instance.log.error(err, "Error draining process pool");
    }

    try {
      await instance.close();
    } catch (err) {
      instance.log.error(err, "Error closing server");
    }

    instance.log.info("Shutdown complete");
  })();

  return shutdownPromise;
}

app.listen({ port: config.port, host: config.host }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Configure HTTP connection timeouts on the underlying Node.js server
  const server = app.server;
  server.headersTimeout = HEADERS_TIMEOUT;
  server.requestTimeout = REQUEST_TIMEOUT;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT;

  app.log.info(`Server listening at ${address}`);
});

// Register signal handlers for graceful shutdown
let hardTimeoutSet = false;
const onSignal = () => {
  if (!hardTimeoutSet) {
    hardTimeoutSet = true;
    setTimeout(() => {
      process.stderr.write("[shutdown] hard timeout reached, forcing exit\n");
      process.exit(1);
    }, HARD_SHUTDOWN_MS).unref();
  }
  void gracefulShutdown(app).then(() => process.exit(0));
};

process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);
