import { describe, it, expect } from "vitest";
import {
  mapErrorToResponse,
  ModeRouterError,
  ApiError,
} from "../../src/errors/handler.js";
import { PassthroughError } from "../../src/backends/openai-passthrough.js";
import { SessionError } from "../../src/services/session-manager.js";
import type { OpenAIError } from "../../src/types/openai.js";

function buildOpenAIError(
  message: string,
  type: string,
  code: string | null,
  param: string | null = null,
): OpenAIError {
  return { error: { message, type, param, code } };
}

describe("error-handler", () => {
  describe("mapErrorToResponse", () => {
    // --- PassthroughError ---
    it("maps PassthroughError preserving status and body", () => {
      const body = buildOpenAIError(
        "Invalid API key",
        "invalid_request_error",
        "invalid_api_key",
      );
      const err = new PassthroughError(401, body);
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(401);
      expect(result.body).toEqual(body);
    });

    it("maps PassthroughError with 503 status (passthrough disabled)", () => {
      const body = buildOpenAIError(
        "OpenAI passthrough is disabled",
        "invalid_request_error",
        "passthrough_disabled",
      );
      const err = new PassthroughError(503, body);
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(503);
      expect(result.body.error.code).toBe("passthrough_disabled");
    });

    it("maps PassthroughError with 403 status (no key configured)", () => {
      const body = buildOpenAIError(
        "No OpenAI API key configured",
        "invalid_request_error",
        "passthrough_not_configured",
      );
      const err = new PassthroughError(403, body);
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("passthrough_not_configured");
    });

    // --- SessionError ---
    it("maps SessionError preserving status and body (session busy)", () => {
      const body = buildOpenAIError(
        "Session is busy",
        "invalid_request_error",
        "session_busy",
      );
      const err = new SessionError(429, body);
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(429);
      expect(result.body.error.code).toBe("session_busy");
    });

    it("maps SessionError for invalid session ID (400)", () => {
      const body = buildOpenAIError(
        "Invalid session ID format",
        "invalid_request_error",
        "invalid_session_id",
      );
      const err = new SessionError(400, body);
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("invalid_session_id");
    });

    it("maps SessionError for session not found (404)", () => {
      const body = buildOpenAIError(
        "Session not found",
        "invalid_request_error",
        "session_not_found",
      );
      const err = new SessionError(404, body);
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(404);
      expect(result.body.error.code).toBe("session_not_found");
    });

    // --- ModeRouterError ---
    it("maps ModeRouterError to 400 with enriched OpenAI schema", () => {
      const err = new ModeRouterError(
        "Invalid X-Claude-Code header: expected true/1/yes or false/0/no",
        "invalid_header_value",
      );
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(400);
      expect(result.body.error.type).toBe("invalid_request_error");
      expect(result.body.error.code).toBe("invalid_header_value");
      expect(result.body.error.message).toContain("Invalid X-Claude-Code");
      expect(result.body.error.param).toBeNull();
    });

    // --- ApiError ---
    it("maps ApiError preserving status and body", () => {
      const body = buildOpenAIError(
        "Missing required field: messages",
        "invalid_request_error",
        "missing_field",
        "messages",
      );
      const err = new ApiError(400, body);
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(400);
      expect(result.body).toEqual(body);
      expect(result.body.error.param).toBe("messages");
    });

    it("maps ApiError with 422 status (unsupported parameter)", () => {
      const body = buildOpenAIError(
        "Unsupported parameter: functions",
        "invalid_request_error",
        "unsupported_parameter",
        "functions",
      );
      const err = new ApiError(422, body);
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(422);
      expect(result.body.error.code).toBe("unsupported_parameter");
    });

    // --- Fastify-native errors ---
    it("maps FST_ERR_CTP_INVALID_MEDIA_TYPE to 415", () => {
      const err = new Error("Unsupported Media Type") as Error & {
        code: string;
        statusCode: number;
      };
      err.code = "FST_ERR_CTP_INVALID_MEDIA_TYPE";
      err.statusCode = 415;
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(415);
      expect(result.body.error.code).toBe("unsupported_media_type");
      expect(result.body.error.message).toBe(
        "Content-Type must be application/json",
      );
      expect(result.body.error.type).toBe("invalid_request_error");
    });

    it("maps FST_ERR_CTP_BODY_TOO_LARGE to 413", () => {
      const err = new Error("Request body is too large") as Error & {
        code: string;
        statusCode: number;
      };
      err.code = "FST_ERR_CTP_BODY_TOO_LARGE";
      err.statusCode = 413;
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(413);
      expect(result.body.error.code).toBe("payload_too_large");
      expect(result.body.error.message).toContain("1 MB");
    });

    it("maps statusCode 413 without specific code to 413", () => {
      const err = new Error("Payload too large") as Error & {
        code?: string;
        statusCode: number;
      };
      err.statusCode = 413;
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(413);
      expect(result.body.error.code).toBe("payload_too_large");
    });

    it("maps FST_ERR_CTP_INVALID_CONTENT_LENGTH to 400", () => {
      const err = new Error("Invalid content length") as Error & {
        code: string;
        statusCode: number;
      };
      err.code = "FST_ERR_CTP_INVALID_CONTENT_LENGTH";
      err.statusCode = 400;
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("invalid_request");
      expect(result.body.error.type).toBe("invalid_request_error");
    });

    it("maps generic Fastify 400 errors (e.g., malformed JSON)", () => {
      const err = new Error("Unexpected token in JSON") as Error & {
        code?: string;
        statusCode: number;
      };
      err.statusCode = 400;
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("invalid_request");
      expect(result.body.error.message).toContain("Unexpected token");
    });

    // --- Generic fallback ---
    it("maps unknown errors to 500 internal_error", () => {
      const err = new Error("Something went wrong");
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(500);
      expect(result.body.error.type).toBe("server_error");
      expect(result.body.error.code).toBe("internal_error");
      expect(result.body.error.message).toBe("Internal server error");
      expect(result.body.error.param).toBeNull();
    });

    it("maps TypeError to 500 internal_error", () => {
      const err = new TypeError("Cannot read property of undefined");
      const result = mapErrorToResponse(err);

      expect(result.status).toBe(500);
      expect(result.body.error.code).toBe("internal_error");
    });
  });

  describe("error classes", () => {
    it("ModeRouterError has correct properties", () => {
      const err = new ModeRouterError("bad header", "invalid_header_value");
      expect(err.name).toBe("ModeRouterError");
      expect(err.message).toBe("bad header");
      expect(err.status).toBe(400);
      expect(err.code).toBe("invalid_header_value");
      expect(err).toBeInstanceOf(Error);
    });

    it("ApiError has correct properties", () => {
      const body = buildOpenAIError("test", "test_type", "test_code");
      const err = new ApiError(422, body);
      expect(err.name).toBe("ApiError");
      expect(err.message).toBe("test");
      expect(err.status).toBe(422);
      expect(err.body).toEqual(body);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("OpenAI error schema compliance", () => {
    it("all error responses have the required 4 fields", () => {
      const errors = [
        new PassthroughError(
          401,
          buildOpenAIError("msg", "type", "code", null),
        ),
        new SessionError(429, buildOpenAIError("msg", "type", "code", null)),
        new ModeRouterError("msg", "code"),
        new ApiError(400, buildOpenAIError("msg", "type", "code", "param")),
        Object.assign(new Error("fastify"), {
          code: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
          statusCode: 415,
        }),
        Object.assign(new Error("fastify"), {
          code: "FST_ERR_CTP_BODY_TOO_LARGE",
          statusCode: 413,
        }),
        new Error("unknown"),
      ];

      for (const err of errors) {
        const result = mapErrorToResponse(err);
        const { error } = result.body;
        expect(error).toHaveProperty("message");
        expect(error).toHaveProperty("type");
        expect(error).toHaveProperty("code");
        expect(error).toHaveProperty("param");
        expect(typeof error.message).toBe("string");
        expect(typeof error.type).toBe("string");
      }
    });
  });
});
