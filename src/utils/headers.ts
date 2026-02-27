/**
 * Normalizes a Fastify header value to a single string.
 * Fastify may return `string | string[] | undefined` for headers;
 * when duplicate headers are present, it returns an array and we
 * take the first value.
 */
export function normalizeHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Maximum length for a client-provided X-Request-ID.
 * Prevents log flooding and header injection.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Validates a client-provided request ID.
 * Accepts only printable non-space ASCII characters (0x21–0x7E)
 * and limits length to prevent log flooding or header injection.
 * Spaces are excluded for defense-in-depth: while technically
 * legal in HTTP header values, some proxies handle them
 * inconsistently and typical request IDs never contain them.
 */
export function isValidRequestId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= MAX_REQUEST_ID_LENGTH &&
    /^[\x21-\x7E]+$/.test(id)
  );
}
