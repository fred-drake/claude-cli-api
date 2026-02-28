/**
 * Masks an API key for safe logging.
 * Preserves a recognizable prefix (up to the second hyphen) and the last 4 chars,
 * replacing the middle with "****".
 *
 * Examples:
 *   "sk-cca-abcdef1234567f3a" → "sk-cca-****7f3a"
 *   "sk-abcdefghijklmnop"     → "****mnop"
 *   "short"                   → "****"
 */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return "****";

  // Find a natural prefix break: the second hyphen position
  const firstHyphen = key.indexOf("-");
  const secondHyphen =
    firstHyphen >= 0 ? key.indexOf("-", firstHyphen + 1) : -1;

  if (secondHyphen > 0 && secondHyphen < key.length - 4) {
    return key.slice(0, secondHyphen + 1) + "****" + key.slice(-4);
  }

  return "****" + key.slice(-4);
}
