import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { ApiError } from "../errors/handler.js";
import { extractBearerToken } from "../utils/headers.js";
import { maskApiKey } from "../utils/key-masking.js";

type PreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

/**
 * Timing-safe string comparison that prevents timing attacks.
 * Pads shorter buffer to match longer to avoid early-exit on length mismatch.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  const maxLen = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  return bufA.length === bufB.length && timingSafeEqual(paddedA, paddedB);
}

/**
 * Factory that returns a Fastify preHandler hook for API key auth.
 * When apiKeys is empty, returns a no-op (auth disabled).
 */
export function buildAuthHook(apiKeys: readonly string[]): PreHandler {
  if (apiKeys.length === 0) {
    return async () => {};
  }

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearerToken(request.headers.authorization);

    if (token === undefined) {
      reply.header("WWW-Authenticate", "Bearer");
      throw new ApiError(401, {
        error: {
          message:
            "Missing Authorization header. Use: Authorization: Bearer <api-key>",
          type: "invalid_request_error",
          param: null,
          code: "missing_api_key",
        },
      });
    }

    const isValid = apiKeys.some((key) => timingSafeCompare(token, key));
    if (!isValid) {
      request.log.warn(
        { maskedKey: maskApiKey(token) },
        "Invalid API key attempt",
      );
      reply.header("WWW-Authenticate", "Bearer");
      throw new ApiError(401, {
        error: {
          message: "Invalid API key",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
      });
    }
  };
}
