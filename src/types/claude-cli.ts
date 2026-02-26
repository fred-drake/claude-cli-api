export interface ClaudeCliResult {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution";
  session_id: string;
  is_error: boolean;
  result: string;
  duration_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

export interface ClaudeCliStreamEvent {
  type: "stream_event";
  event:
    | {
        type: "content_block_start";
        index: number;
        content_block: { type: "text"; text: string };
      }
    | {
        type: "content_block_delta";
        index: number;
        delta: { type: "text_delta"; text: string };
      }
    | { type: "content_block_stop"; index: number }
    | {
        type: "message_delta";
        delta: { stop_reason: string | null };
        usage?: { output_tokens: number };
      }
    | { type: "message_stop" };
  session_id: string;
}

export interface ClaudeCliSystemMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  model: string;
}

export type ClaudeCliMessage =
  | ClaudeCliSystemMessage
  | ClaudeCliStreamEvent
  | ClaudeCliResult
  | { type: string; [key: string]: unknown };
