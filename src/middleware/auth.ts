import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { ApiError, buildOpenAIError } from "../errors/handler.js";
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
 * Timing-safe comparison against a pre-computed key buffer.
 * Avoids per-request Buffer allocation for known keys.
 */
function timingSafeCompareToBuffer(input: string, keyBuf: Buffer): boolean {
  const inputBuf = Buffer.from(input);
  const maxLen = Math.max(inputBuf.length, keyBuf.length);
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  inputBuf.copy(paddedA);
  keyBuf.copy(paddedB);
  return inputBuf.length === keyBuf.length && timingSafeEqual(paddedA, paddedB);
}

/**
 * Factory that returns a Fastify preHandler hook for API key auth.
 * When apiKeys is empty, returns a no-op (auth disabled).
 * Pre-computes key Buffers at build time to reduce per-request allocations.
 */
export function buildAuthHook(apiKeys: readonly string[]): PreHandler {
  if (apiKeys.length === 0) {
    return async () => {};
  }

  // Pre-compute Buffers for known keys (avoids 2 Buffer allocs per key per request)
  const keyBuffers = apiKeys.map((k) => Buffer.from(k));

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearerToken(request.headers.authorization);

    if (token === undefined) {
      reply.header("WWW-Authenticate", "Bearer");
      throw new ApiError(
        401,
        buildOpenAIError(
          "Missing Authorization header. Use: Authorization: Bearer <api-key>",
          "invalid_request_error",
          "missing_api_key",
        ),
      );
    }

    const isValid = keyBuffers.some((keyBuf) =>
      timingSafeCompareToBuffer(token, keyBuf),
    );
    if (!isValid) {
      request.log.warn(
        { maskedKey: maskApiKey(token) },
        "Invalid API key attempt",
      );
      reply.header("WWW-Authenticate", "Bearer");
      throw new ApiError(
        401,
        buildOpenAIError(
          "Invalid API key",
          "invalid_request_error",
          "invalid_api_key",
        ),
      );
    }
  };
}
