import type { ChatCompletionChunk } from "../types/openai.js";
import type { BackendStreamCallbacks } from "../backends/types.js";
import type {
  ClaudeCliMessage,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
  ClaudeCliSystemMessage,
} from "../types/claude-cli.js";
import { redactSecrets } from "../utils/secret-scanner.js";

/**
 * Buffers raw stdout data and emits complete NDJSON lines.
 * Handles partial lines split across chunk boundaries.
 */
export class NdjsonLineBuffer {
  private buffer = "";

  /** Appends chunk to buffer, returns all complete lines. */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop()!;
    return parts
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.trim().length > 0);
  }

  /** Returns remaining partial line, or null if empty. */
  flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = "";
    return remaining.length > 0 ? remaining : null;
  }
}

/** Maps Claude stop reasons to OpenAI finish_reason values. */
export function mapStopReason(reason: string | null): "stop" | "length" {
  if (reason === "max_tokens") return "length";
  return "stop";
}

export interface StreamAdapterOptions {
  requestId: string;
  model: string;
}

/**
 * Stateful event mapper: Claude CLI NDJSON messages → OpenAI chunks
 * via BackendStreamCallbacks. One adapter per stream.
 */
export class StreamAdapter {
  private readonly requestId: string;
  private readonly model: string;
  private readonly created: number;
  private firstContentBlockSeen = false;
  private done = false;
  private sessionId: string | undefined;

  constructor(options: StreamAdapterOptions) {
    this.requestId = options.requestId;
    this.model = options.model;
    this.created = Math.floor(Date.now() / 1000);
  }

  /**
   * Parses a single NDJSON line and emits appropriate OpenAI chunks.
   * Malformed JSON is silently skipped. Never throws.
   */
  processLine(line: string, callbacks: BackendStreamCallbacks): void {
    if (this.done) return;

    let parsed: ClaudeCliMessage;
    try {
      parsed = JSON.parse(line) as ClaudeCliMessage;
    } catch {
      return;
    }

    if (parsed.type === "system") {
      this.sessionId = (parsed as ClaudeCliSystemMessage).session_id;
      return;
    }

    if (parsed.type === "result") {
      const result = parsed as ClaudeCliResult;
      if (result.is_error) {
        this.handleError(redactSecrets(result.result), callbacks);
        return;
      }
      this.sessionId = result.session_id;
      this.done = true;
      callbacks.onDone({
        headers: {
          "X-Backend-Mode": "claude-code",
          ...(result.session_id
            ? { "X-Claude-Session-ID": result.session_id }
            : {}),
        },
        usage: {
          prompt_tokens: result.usage.input_tokens,
          completion_tokens: result.usage.output_tokens,
          total_tokens: result.usage.input_tokens + result.usage.output_tokens,
        },
      });
      return;
    }

    if (parsed.type === "stream_event") {
      const streamEvent = parsed as ClaudeCliStreamEvent;
      const event = streamEvent.event;

      switch (event.type) {
        case "content_block_start": {
          if (!this.firstContentBlockSeen) {
            this.firstContentBlockSeen = true;
            callbacks.onChunk(
              JSON.stringify(this.buildChunk({ role: "assistant" }, null)),
            );
          }
          break;
        }

        case "content_block_delta": {
          if (event.delta.type === "text_delta") {
            callbacks.onChunk(
              JSON.stringify(
                this.buildChunk(
                  { content: redactSecrets(event.delta.text) },
                  null,
                ),
              ),
            );
          }
          break;
        }

        case "content_block_stop":
        case "message_stop": {
          break;
        }

        case "message_delta": {
          callbacks.onChunk(
            JSON.stringify(
              this.buildChunk({}, mapStopReason(event.delta.stop_reason)),
            ),
          );
          break;
        }

        default: {
          break;
        }
      }
      return;
    }

    // Unknown top-level message types — skip silently
  }

  /**
   * Emits a finish chunk then signals error via callbacks.
   * Double-callback guard: no-op if already done.
   */
  handleError(reason: string, callbacks: BackendStreamCallbacks): void {
    if (this.done) return;
    this.done = true;

    callbacks.onChunk(JSON.stringify(this.buildChunk({}, "stop")));
    callbacks.onError({
      error: {
        message: `Stream interrupted: ${reason}`,
        type: "server_error",
        param: null,
        code: "stream_error",
      },
    });
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  isDone(): boolean {
    return this.done;
  }

  private buildChunk(
    delta: { role?: "assistant"; content?: string },
    finishReason: "stop" | "length" | null,
  ): ChatCompletionChunk {
    return {
      id: `chatcmpl-${this.requestId}`,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    };
  }
}
