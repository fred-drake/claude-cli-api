import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { OpenAIError } from "../types/openai.js";
import { PassthroughError } from "../backends/openai-passthrough.js";
import { SessionError } from "../services/session-manager.js";

/**
 * Typed error for mode router failures. The route handler constructs
 * this from the minimal `{ message, code }` shape returned by
 * `resolveMode()` and throws it so the centralized error handler
 * enriches it into the full OpenAI error schema.
 */
export class ModeRouterError extends Error {
  readonly status = 400;
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ModeRouterError";
    this.code = code;
  }
}

/**
 * Typed error for CLI output size limit violations.
 * Thrown when stdout or stderr exceeds the configured maximum.
 */
export class OutputLimitError extends Error {
  readonly status = 502;

  constructor(message: string) {
    super(message);
    this.name = "OutputLimitError";
  }
}

/**
 * Generic API error that carries an OpenAI-compatible error body.
 * Used by route handlers and middleware to throw errors that the
 * centralized error handler can format consistently.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: OpenAIError;

  constructor(status: number, body: OpenAIError) {
    super(body.error.message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function buildOpenAIError(
  message: string,
  type: string,
  code: string | null,
  param: string | null = null,
): OpenAIError {
  return {
    error: { message, type, param, code },
  };
}

/**
 * Maps a caught error to an HTTP status and OpenAI-compatible error body.
 * Exported for unit testing — the `registerErrorHandler` function wires
 * this into Fastify's `setErrorHandler`.
 */
export function mapErrorToResponse(err: Error | FastifyError): {
  status: number;
  body: OpenAIError;
} {
  // PassthroughError: preserve status + body as-is.
  // Covers §9.6 rows: OpenAI auth failure (passthrough), passthrough
  // not configured, passthrough disabled.
  if (err instanceof PassthroughError) {
    return { status: err.status, body: err.body };
  }

  // SessionError: preserve status + body as-is.
  // Covers §9.6 rows: session busy (429), invalid session ID (400),
  // session not found (404).
  if (err instanceof SessionError) {
    return { status: err.status, body: err.body };
  }

  // ModeRouterError: enrich minimal { message, code } into full schema.
  // Covers §9.6 row: invalid header value (400).
  if (err instanceof ModeRouterError) {
    return {
      status: 400,
      body: buildOpenAIError(err.message, "invalid_request_error", err.code),
    };
  }

  // ApiError: preserve status + body as-is.
  // Used by route handlers for validation errors (missing fields,
  // unsupported params, etc.).
  if (err instanceof ApiError) {
    return { status: err.status, body: err.body };
  }

  // OutputLimitError: CLI stdout/stderr exceeded size limit.
  if (err instanceof OutputLimitError) {
    return {
      status: 502,
      body: buildOpenAIError(
        err.message,
        "server_error",
        "output_limit_exceeded",
      ),
    };
  }

  // Fastify-native errors: content-type and body limit.
  const fastifyErr = err as FastifyError;
  if (fastifyErr.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return {
      status: 415,
      body: buildOpenAIError(
        "Content-Type must be application/json",
        "invalid_request_error",
        "unsupported_media_type",
      ),
    };
  }

  if (
    fastifyErr.code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
    fastifyErr.statusCode === 413
  ) {
    return {
      status: 413,
      body: buildOpenAIError(
        "Request body too large. Maximum size is 1 MB.",
        "invalid_request_error",
        "payload_too_large",
      ),
    };
  }

  // Fastify JSON parse error
  if (
    fastifyErr.statusCode === 400 &&
    fastifyErr.code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH"
  ) {
    return {
      status: 400,
      body: buildOpenAIError(
        fastifyErr.message,
        "invalid_request_error",
        "invalid_request",
      ),
    };
  }

  // Fastify validation / parse errors (malformed JSON, etc.)
  if (fastifyErr.statusCode === 400) {
    return {
      status: 400,
      body: buildOpenAIError(
        fastifyErr.message || "Bad request",
        "invalid_request_error",
        "invalid_request",
      ),
    };
  }

  // Generic fallback: 500 internal_error.
  // Covers §9.6 row: CLI crash, and any unhandled errors.
  return {
    status: 500,
    body: buildOpenAIError(
      "Internal server error",
      "server_error",
      "internal_error",
    ),
  };
}

/**
 * Registers the centralized error handler on a Fastify instance.
 * All thrown errors from route handlers and hooks are caught here
 * and formatted as OpenAI-compatible JSON error responses.
 *
 * For streaming responses where headers are already sent
 * (`reply.raw.headersSent`), the error is logged but not sent
 * since the HTTP status is already committed.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (
      err: Error | FastifyError,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      const { status, body } = mapErrorToResponse(err);

      // If SSE headers are already committed (streaming), we cannot
      // change the HTTP status. Log the error and let the stream
      // callbacks handle cleanup.
      if (reply.raw.headersSent) {
        request.log.error(
          { err, requestId: reply.getHeader("X-Request-ID") },
          "Error after headers sent (streaming)",
        );
        // Try to write an SSE error event if the socket is still open
        if (!reply.raw.writableEnded) {
          reply.raw.write(`data: ${JSON.stringify(body)}\n\n`);
          reply.raw.write("data: [DONE]\n\n");
          reply.raw.end();
        }
        return;
      }

      request.log.error(
        { err, statusCode: status, errorCode: body.error.code },
        body.error.message,
      );

      return reply.status(status).send(body);
    },
  );
}
