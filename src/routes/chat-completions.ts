import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ChatCompletionRequest } from "../types/openai.js";
import type {
  BackendMode,
  BackendStreamCallbacks,
  CompletionBackend,
  RequestContext,
} from "../backends/types.js";
import type { RateLimitInfo } from "../middleware/rate-limiter.js";
import { resolveMode } from "../services/mode-router.js";
import {
  ApiError,
  ModeRouterError,
  buildOpenAIError,
} from "../errors/handler.js";
import {
  normalizeHeader,
  extractBearerToken,
  SECURITY_HEADERS,
} from "../utils/headers.js";
import { buildAuthHook } from "../middleware/auth.js";
import { validateChatCompletionInput } from "../middleware/input-validation.js";

/**
 * Validates the chat completion request body at runtime.
 * TypeScript generics only enforce types at compile time;
 * this ensures clients get clear 400 errors for malformed requests.
 */
function validateRequestBody(body: unknown): body is ChatCompletionRequest {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.model !== "string" || obj.model.length === 0) return false;
  if (!Array.isArray(obj.messages) || obj.messages.length === 0) return false;
  if (obj.stream !== undefined && typeof obj.stream !== "boolean") return false;
  return true;
}

/** Derives the concurrency key from a request (API key or IP fallback). */
function getConcurrencyKey(request: FastifyRequest): string {
  return extractBearerToken(request.headers.authorization) ?? request.ip;
}

/** Sets the Retry-After header from a rate limit reset timestamp. */
function setRetryAfterHeader(reply: FastifyReply, resetMs: number): void {
  const retryAfter = Math.ceil((resetMs - Date.now()) / 1000);
  reply.header("Retry-After", String(Math.max(1, retryAfter)));
}

/** Builds a 429 rate limit ApiError with the given message. */
function rateLimitError(message: string): ApiError {
  return new ApiError(
    429,
    buildOpenAIError(message, "rate_limit_error", "rate_limit_exceeded"),
  );
}

/**
 * Builds a RequestContext from the Fastify request and reply.
 * Centralizes all context extraction in one testable function.
 */
function buildRequestContext(
  request: FastifyRequest,
  reply: FastifyReply,
  signal: AbortSignal,
): RequestContext {
  return {
    requestId: (reply.getHeader("X-Request-ID") as string) ?? "unknown",
    sessionId: normalizeHeader(request.headers["x-claude-session-id"]),
    clientOpenAIKey: normalizeHeader(request.headers["x-openai-api-key"]),
    apiKey: extractBearerToken(request.headers.authorization),
    clientIp: request.ip,
    method: request.method,
    path: request.url,
    signal,
  };
}

export async function chatCompletionsRoute(app: FastifyInstance) {
  // --- Auth hook (only for this route plugin) ---
  // Registered as onRequest so unauthenticated requests are rejected
  // before the body is parsed, saving resources under attack.
  const authHook = buildAuthHook(app.config.apiKeys);
  app.addHook("onRequest", authHook);

  // --- Rate limit preHandler ---
  app.addHook(
    "preHandler",
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Per-IP rate limit
      const ipResult = app.ipRateLimiter.record(request.ip);
      setRateLimitHeaders(reply, ipResult.info);

      if (!ipResult.allowed) {
        setRetryAfterHeader(reply, ipResult.info.resetMs);
        throw rateLimitError(
          "Rate limit exceeded. Too many requests from this IP.",
        );
      }

      // Per-key concurrency limit
      const concurrencyKey = getConcurrencyKey(request);
      if (!app.concurrencyLimiter.acquire(concurrencyKey)) {
        throw rateLimitError(
          "Too many concurrent requests. Please wait for existing requests to complete.",
        );
      }

      // Per-session rate limit (if session header present)
      const sessionId = normalizeHeader(request.headers["x-claude-session-id"]);
      if (sessionId) {
        const sessionResult = app.sessionRateLimiter.record(sessionId);
        if (!sessionResult.allowed) {
          // Release concurrency slot since we're rejecting
          app.concurrencyLimiter.release(concurrencyKey);
          setRetryAfterHeader(reply, sessionResult.info.resetMs);
          throw rateLimitError("Rate limit exceeded for this session.");
        }
      }
    },
  );

  // --- Concurrency release on response ---
  app.addHook("onResponse", (request: FastifyRequest) => {
    app.concurrencyLimiter.release(getConcurrencyKey(request));
  });

  app.post<{ Body: ChatCompletionRequest }>(
    "/v1/chat/completions",
    async (request, reply) => {
      // 1. Resolve mode from headers.
      // resolveMode is a pure function — imported directly, no injection.
      const result = resolveMode(request.headers);

      // 2. Mode router errors are handled inline (not via setErrorHandler)
      // because they occur before backend selection. The error is enriched
      // from the minimal { message, code } shape to the full OpenAI schema.
      if ("error" in result) {
        throw new ModeRouterError(result.error.message, result.error.code);
      }

      // 3. Validate request body at runtime (§9.6 validation errors)
      if (!validateRequestBody(request.body)) {
        throw new ApiError(
          400,
          buildOpenAIError(
            "Invalid request: 'model' must be a non-empty string, " +
              "'messages' must be a non-empty array, and " +
              "'stream' (if provided) must be a boolean.",
            "invalid_request_error",
            "invalid_request",
          ),
        );
      }

      // 3b. Validate input limits (message count, content length, model length)
      validateChatCompletionInput(request.body);

      // 4. Select backend based on resolved mode
      const backend: CompletionBackend =
        result.mode === "claude-code"
          ? app.claudeCodeBackend
          : app.openaiPassthroughBackend;

      // 5. Create AbortController for client disconnect detection (§7.4)
      const controller = new AbortController();
      request.raw.on("close", () => {
        if (!request.raw.complete) controller.abort();
      });

      // 6. Build RequestContext
      const context = buildRequestContext(request, reply, controller.signal);

      const body = request.body;

      // 7. Streaming path
      if (body.stream) {
        // For hijacked responses, onResponse doesn't fire.
        // Release concurrency slot when the raw socket closes.
        const concurrencyKey = getConcurrencyKey(request);
        reply.raw.on("close", () => {
          app.concurrencyLimiter.release(concurrencyKey);
        });

        return handleStreaming(reply, backend, body, context, result.mode);
      }

      // 8. Non-streaming path
      return handleNonStreaming(reply, backend, body, context);
    },
  );
}

function setRateLimitHeaders(reply: FastifyReply, info: RateLimitInfo): void {
  reply.header("X-RateLimit-Limit", String(info.limit));
  reply.header("X-RateLimit-Remaining", String(info.remaining));
  reply.header("X-RateLimit-Reset", String(Math.ceil(info.resetMs / 1000)));
}

async function handleNonStreaming(
  reply: FastifyReply,
  backend: CompletionBackend,
  body: ChatCompletionRequest,
  context: RequestContext,
): Promise<void> {
  const result = await backend.complete(body, context);

  // Set backend-provided headers (includes X-Backend-Mode)
  for (const [key, value] of Object.entries(result.headers)) {
    reply.header(key, value);
  }

  return reply.send(result.response);
}

async function handleStreaming(
  reply: FastifyReply,
  backend: CompletionBackend,
  body: ChatCompletionRequest,
  context: RequestContext,
  mode: BackendMode,
): Promise<void> {
  // Write SSE headers eagerly before streaming begins.
  // X-Backend-Mode is known from mode resolution.
  // X-Request-ID is set by the onRequest hook and already on the reply.
  //
  // Known limitation (architect review N3): For new sessions,
  // X-Claude-Session-ID and X-Claude-Session-Created are not available
  // in HTTP headers because session resolution is encapsulated inside
  // the backend and fires after headers are committed. Clients should
  // read session info from the stream payload (result event).
  //
  // Security headers are included here because hijacked responses
  // bypass Fastify's onSend hook where they would normally be set.
  // Cache-Control uses "no-cache" (SSE convention) rather than
  // "no-store" (security default) — both prevent caching.
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Backend-Mode": mode,
  };

  // For resumed sessions, the session ID is known from request headers
  const sessionId = context.sessionId;
  if (sessionId) {
    headers["X-Claude-Session-ID"] = sessionId;
  }

  // Copy X-Request-ID from the reply to the raw headers
  const requestId = reply.getHeader("X-Request-ID");
  if (requestId) {
    headers["X-Request-ID"] = String(requestId);
  }

  // Copy rate limit headers set by the preHandler hook.
  // Hijacked responses bypass Fastify's normal header serialization,
  // so we must include them in the raw writeHead() call.
  for (const name of [
    "X-RateLimit-Limit",
    "X-RateLimit-Remaining",
    "X-RateLimit-Reset",
  ]) {
    const value = reply.getHeader(name);
    if (value) {
      headers[name] = String(value);
    }
  }

  // Tell Fastify we are taking over the response BEFORE writing to
  // reply.raw. This is required: hijack() must precede writeHead()
  // so Fastify does not attempt to send its own response.
  reply.hijack();
  reply.raw.writeHead(200, headers);

  // Guard against double [DONE] if a backend both calls onError/onDone
  // AND throws. Once the stream is terminated, subsequent writes are
  // no-ops.
  let streamEnded = false;

  // Set up stream callbacks
  const callbacks: BackendStreamCallbacks = {
    onChunk: (chunk: string) => {
      if (!streamEnded) {
        reply.raw.write(`data: ${chunk}\n\n`);
      }
    },
    onDone: (_metadata) => {
      if (streamEnded) return;
      streamEnded = true;
      // Known limitation: onDone metadata may include headers like
      // X-Claude-Session-ID for new sessions, but HTTP headers are
      // already committed via writeHead(). Clients should read
      // session info from the stream payload (result event).
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    },
    onError: (error) => {
      if (streamEnded) return;
      streamEnded = true;
      // Mid-stream or pre-stream error (after headers committed):
      // emit SSE error data event followed by [DONE].
      reply.raw.write(`data: ${JSON.stringify(error)}\n\n`);
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    },
  };

  await backend.completeStream(body, context, callbacks);
}
