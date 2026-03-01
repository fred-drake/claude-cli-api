/**
 * Sanitizes stderr output before including in error responses to clients.
 * Strips file paths, environment variable values, and stack traces that
 * could leak internal server details. Also redacts standalone secret tokens
 * (API keys, Bearer tokens, etc.) via the shared secret scanner.
 */

import { redactSecrets } from "./secret-scanner.js";

const SANITIZE_PATTERNS: [RegExp, string][] = [
  // Stack traces (at /path/to/file.ts:123:45 or at Object.<anonymous>)
  [/\n\s+at\s+.+/g, ""],
  // Absolute file paths (Unix and Windows)
  [/(?:\/[\w.-]+){2,}(?::\d+(?::\d+)?)?/g, "[path]"],
  [/[A-Z]:\\(?:[\w.-]+\\){2,}(?::\d+(?::\d+)?)?/g, "[path]"],
  // Sensitive environment variable assignments (targeted known-sensitive names only)
  [
    /\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|DATABASE_URL|[A-Z_]*(?:SECRET|PASSWORD|TOKEN|CREDENTIAL|PRIVATE_KEY))=[^\s]+/g,
    "[env]",
  ],
];

export function sanitizeStderr(stderr: string): string {
  let result = redactSecrets(stderr);
  for (const [pattern, replacement] of SANITIZE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result.trim();
}
