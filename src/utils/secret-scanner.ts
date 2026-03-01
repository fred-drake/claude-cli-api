const REDACTED = "[REDACTED]";

// Note: Streaming chunks may split a secret across two consecutive
// content_block_delta events. The stateless per-chunk approach will miss these.
// This is an accepted trade-off — adding a sliding window buffer would introduce
// latency/complexity. Non-streaming catches secrets in the full response.

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g, // Anthropic API keys
  /\bsk-[a-zA-Z0-9]{20,}\b/g, // OpenAI-style API keys (20+ chars avoids false positives)
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g, // Bearer tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key IDs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM private keys
  /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g, // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  /\bAIza[A-Za-z0-9_-]{35}\b/g, // Google API keys
  /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s"']*@[^\s"']+/g, // Connection strings with embedded credentials
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}
