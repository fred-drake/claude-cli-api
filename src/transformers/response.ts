import type { ClaudeCliResult } from "../types/claude-cli.js";
import type { ChatCompletionResponse, OpenAIError } from "../types/openai.js";

export interface TransformSuccess {
  status: number;
  response: ChatCompletionResponse;
  headers: Record<string, string>;
}

export interface TransformFailure {
  status: number;
  error: OpenAIError;
  headers: Record<string, string>;
}

export type TransformResult = TransformSuccess | TransformFailure;

export function transformCliResult(
  cliResult: ClaudeCliResult,
  originalModel: string,
  requestId: string,
  created?: number,
): TransformResult {
  const timestamp = created ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "X-Backend-Mode": "claude-code",
  };

  if (cliResult.is_error) {
    return {
      status: 500,
      error: {
        error: {
          message: cliResult.result || "An error occurred during execution",
          type: "server_error",
          param: null,
          code: "backend_error",
        },
      },
      headers,
    };
  }

  const response: ChatCompletionResponse = {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: timestamp,
    model: originalModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: cliResult.result,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: cliResult.usage.input_tokens,
      completion_tokens: cliResult.usage.output_tokens,
      total_tokens:
        cliResult.usage.input_tokens + cliResult.usage.output_tokens,
    },
  };

  return { status: 200, response, headers };
}

const AUTH_FAILURE_PATTERNS = [
  /invalid api key/i,
  /ANTHROPIC_API_KEY/,
  /authentication/i,
  /unauthorized/i,
];

export function detectAuthFailure(stderr: string): boolean {
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(stderr));
}
