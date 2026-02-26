import type { ClaudeCliResult } from "../../src/types/claude-cli.js";
import type {
  ChatCompletionResponse,
  ChatCompletionRequest,
  OpenAIError,
} from "../../src/types/openai.js";

export const sampleCliResult: ClaudeCliResult = {
  type: "result",
  subtype: "success",
  session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  is_error: false,
  result: "Hello! How can I help you today?",
  duration_ms: 1523,
  num_turns: 1,
  total_cost_usd: 0.003,
  usage: {
    input_tokens: 25,
    output_tokens: 12,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

export const sampleCliErrorResult: ClaudeCliResult = {
  type: "result",
  subtype: "error_during_execution",
  session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  is_error: true,
  result: "An error occurred during execution",
  duration_ms: 500,
  num_turns: 1,
  total_cost_usd: 0.001,
  usage: {
    input_tokens: 25,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

export const sampleNdjsonStream = [
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    model: "claude-sonnet-4-6",
  }),
  JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  }),
  JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    },
    session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  }),
  JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " world!" },
    },
    session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  }),
  JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
    session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  }),
  JSON.stringify({
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 12 },
    },
    session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  }),
  JSON.stringify({
    type: "stream_event",
    event: { type: "message_stop" },
    session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    is_error: false,
    result: "Hello world!",
    duration_ms: 1523,
    num_turns: 1,
    total_cost_usd: 0.003,
    usage: {
      input_tokens: 25,
      output_tokens: 12,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }),
];

export const sampleOpenAIResponse: ChatCompletionResponse = {
  id: "chatcmpl-abc123",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello from OpenAI!" },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  },
};

export const sampleChatRequest: ChatCompletionRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
};

export const sampleStreamRequest: ChatCompletionRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
};

export const sampleOpenAIError: OpenAIError = {
  error: {
    message: "Invalid API key",
    type: "invalid_request_error",
    param: null,
    code: "invalid_api_key",
  },
};

export const sampleCliAuthFailureStderr =
  "Error: Invalid API key. Please check your ANTHROPIC_API_KEY.";

export const sampleCliTimeoutStderr = "Error: Request timed out after 300000ms";

export const sampleCliEmptyResult: ClaudeCliResult = {
  type: "result",
  subtype: "success",
  session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  is_error: false,
  result: "",
  duration_ms: 100,
  num_turns: 1,
  total_cost_usd: 0.001,
  usage: {
    input_tokens: 10,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};

export const sampleCliLongResult: ClaudeCliResult = {
  type: "result",
  subtype: "success",
  session_id: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  is_error: false,
  result: "A".repeat(100_000),
  duration_ms: 5000,
  num_turns: 1,
  total_cost_usd: 0.05,
  usage: {
    input_tokens: 50,
    output_tokens: 25000,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
};
