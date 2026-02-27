import type { BackendMode } from "../backends/types.js";
import { normalizeHeader } from "../utils/headers.js";

/**
 * Result of mode resolution. The error variant contains a minimal error
 * shape (`message` + `code`). The error handler (Epic 7, task 7.8) is
 * responsible for enriching this into the full OpenAI error schema
 * (`type`, `param`, `code`, `message`) before sending to the client.
 */
export type ModeRouterResult =
  | { mode: BackendMode }
  | { error: { message: string; code: string } };

const TRUTHY_VALUES = new Set(["true", "1", "yes"]);
const FALSY_VALUES = new Set(["false", "0", "no"]);

/**
 * Resolve the backend mode from request headers.
 *
 * Accepts Fastify's native header type (`string | string[] | undefined`)
 * so callers can pass `request.headers` directly without pre-processing.
 *
 * Priority order (from §3.2):
 *  1. `X-Claude-Code: false` → OPENAI_PASSTHROUGH (explicit override)
 *  2. `X-Claude-Code: true`  → CLAUDE_CODE (explicit opt-in)
 *  3. `X-Claude-Session-ID` present → CLAUDE_CODE (implicit opt-in)
 *  4. Neither header → OPENAI_PASSTHROUGH (default)
 */
export function resolveMode(
  headers: Record<string, string | string[] | undefined>,
): ModeRouterResult {
  const claudeCodeHeader = normalizeHeader(headers["x-claude-code"]);
  const sessionIdHeader = normalizeHeader(headers["x-claude-session-id"]);

  if (claudeCodeHeader !== undefined) {
    const normalized = claudeCodeHeader.toLowerCase();

    if (FALSY_VALUES.has(normalized)) {
      return { mode: "openai-passthrough" };
    }

    if (TRUTHY_VALUES.has(normalized)) {
      return { mode: "claude-code" };
    }

    return {
      error: {
        message:
          "Invalid X-Claude-Code header value. Use true/1/yes or false/0/no.",
        code: "invalid_header_value",
      },
    };
  }

  if (sessionIdHeader !== undefined) {
    return { mode: "claude-code" };
  }

  return { mode: "openai-passthrough" };
}
