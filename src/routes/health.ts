import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Read version from package.json once at module load time
// so it stays in sync with the actual package version.
const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };
const APP_VERSION = pkg.version;

export async function healthRoute(app: FastifyInstance) {
  app.get("/health", async (_request, reply) => {
    const [claudeHealth, openaiHealth] = await Promise.all([
      app.claudeCodeBackend.healthCheck(),
      app.openaiPassthroughBackend.healthCheck(),
    ]);

    // anthropic_key: check if the key is configured
    const anthropicKeyStatus =
      app.config.anthropicApiKey !== "" ? "ok" : "missing";

    // Capacity stub — actual tracking deferred to Epic 9 (process pool)
    const capacity = {
      active: 0,
      max: app.config.maxConcurrentProcesses,
    };

    // At least one backend must be functional for 200
    const anyOk = claudeHealth.status === "ok" || openaiHealth.status === "ok";

    const response = {
      status: anyOk ? "ready" : "unavailable",
      version: APP_VERSION,
      checks: {
        claude_cli: claudeHealth.status,
        anthropic_key: anthropicKeyStatus,
        openai_passthrough: openaiHealth.status,
        capacity,
      },
    };

    return reply.status(anyOk ? 200 : 503).send(response);
  });
}
