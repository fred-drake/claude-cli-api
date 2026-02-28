import type { ServerConfig } from "../config.js";
import type { SessionManager } from "../services/session-manager.js";
import type { CompletionBackend } from "../backends/types.js";
import type {
  SlidingWindowRateLimiter,
  ConcurrencyLimiter,
} from "../middleware/rate-limiter.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Readonly<ServerConfig>;
    sessionManager: SessionManager;
    claudeCodeBackend: CompletionBackend;
    openaiPassthroughBackend: CompletionBackend;
    ipRateLimiter: SlidingWindowRateLimiter;
    sessionRateLimiter: SlidingWindowRateLimiter;
    concurrencyLimiter: ConcurrencyLimiter;
  }
}
