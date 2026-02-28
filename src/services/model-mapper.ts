import type { OpenAIError } from "../types/openai.js";

export interface ModelMapResult {
  resolvedModel: string;
}

export interface ModelMapError {
  error: OpenAIError;
}

const EXACT_MODEL_MAP: Record<string, string> = {
  // Claude native models (pass through)
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  // OpenAI aliases
  "gpt-4": "opus",
  "gpt-4-turbo": "sonnet",
  "gpt-4o": "sonnet",
  "gpt-4o-mini": "haiku",
  "gpt-3.5-turbo": "haiku",
  "gpt-4-turbo-preview": "sonnet",
  "chatgpt-4o-latest": "sonnet",
  "gpt-4.1": "sonnet",
};

const PREFIX_PATTERNS: Array<{ prefix: string; resolvedModel: string }> = [
  { prefix: "gpt-4o-2024-", resolvedModel: "sonnet" },
  { prefix: "gpt-4-turbo-2024-", resolvedModel: "sonnet" },
  { prefix: "gpt-3.5-turbo-", resolvedModel: "haiku" },
];

const VALID_MODELS = Object.keys(EXACT_MODEL_MAP);

export function mapModel(
  requestedModel: string,
): ModelMapResult | ModelMapError {
  const exact = EXACT_MODEL_MAP[requestedModel];
  if (exact) {
    return { resolvedModel: exact };
  }

  for (const { prefix, resolvedModel } of PREFIX_PATTERNS) {
    if (requestedModel.startsWith(prefix)) {
      return { resolvedModel };
    }
  }

  return {
    error: {
      error: {
        message: `Model '${requestedModel}' is not supported. Valid models: ${VALID_MODELS.join(", ")}`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    },
  };
}
