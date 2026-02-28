import { ApiError } from "../errors/handler.js";

export const MAX_MESSAGES = 100;
export const MAX_CONTENT_LENGTH = 500_000;
export const MAX_MODEL_LENGTH = 256;

/**
 * Validates chat completion input for security limits.
 * Throws ApiError(400) if any limit is exceeded.
 * Called after basic structure validation (validateRequestBody).
 */
export function validateChatCompletionInput(body: unknown): void {
  if (typeof body !== "object" || body === null) return;

  const obj = body as Record<string, unknown>;

  // Validate model length
  if (typeof obj.model === "string" && obj.model.length > MAX_MODEL_LENGTH) {
    throw new ApiError(400, {
      error: {
        message: `Model name exceeds maximum length of ${MAX_MODEL_LENGTH} characters`,
        type: "invalid_request_error",
        param: "model",
        code: "invalid_request",
      },
    });
  }

  // Validate message count
  if (Array.isArray(obj.messages)) {
    if (obj.messages.length > MAX_MESSAGES) {
      throw new ApiError(400, {
        error: {
          message: `Too many messages: ${obj.messages.length} exceeds maximum of ${MAX_MESSAGES}`,
          type: "invalid_request_error",
          param: "messages",
          code: "invalid_request",
        },
      });
    }

    // Validate content length of each message
    for (const msg of obj.messages) {
      if (typeof msg === "object" && msg !== null) {
        const message = msg as Record<string, unknown>;
        if (
          typeof message.content === "string" &&
          message.content.length > MAX_CONTENT_LENGTH
        ) {
          throw new ApiError(400, {
            error: {
              message: `Message content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`,
              type: "invalid_request_error",
              param: "messages",
              code: "invalid_request",
            },
          });
        }
        // OpenAI supports content as array of parts (e.g. text + image_url).
        // Check text length within each part to prevent bypass via array format.
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (typeof part === "object" && part !== null) {
              const p = part as Record<string, unknown>;
              if (
                typeof p.text === "string" &&
                p.text.length > MAX_CONTENT_LENGTH
              ) {
                throw new ApiError(400, {
                  error: {
                    message: `Message content part exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`,
                    type: "invalid_request_error",
                    param: "messages",
                    code: "invalid_request",
                  },
                });
              }
            }
          }
        }
      }
    }
  }
}
