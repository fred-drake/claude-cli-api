import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  NdjsonLineBuffer,
  mapStopReason,
  StreamAdapter,
} from "../../src/transformers/stream.js";
import type { ChatCompletionChunk } from "../../src/types/openai.js";
import {
  sampleNdjsonStream,
  sampleMultiBlockNdjsonStream,
  sampleMaxTokensNdjsonStream,
  sampleCliErrorResult,
  collectCallbacks,
} from "../helpers/index.js";

function createAdapter(overrides: { requestId?: string; model?: string } = {}) {
  return new StreamAdapter({
    requestId: overrides.requestId ?? "req-001",
    model: overrides.model ?? "gpt-4o",
  });
}

describe("NdjsonLineBuffer", () => {
  it("returns complete lines from a single chunk", () => {
    const buffer = new NdjsonLineBuffer();
    const lines = buffer.feed('{"type":"system"}\n{"type":"result"}\n');
    expect(lines).toEqual(['{"type":"system"}', '{"type":"result"}']);
  });

  it("buffers partial lines across chunks", () => {
    const buffer = new NdjsonLineBuffer();
    const lines1 = buffer.feed('{"type":"sys');
    expect(lines1).toEqual([]);

    const lines2 = buffer.feed('tem"}\n');
    expect(lines2).toEqual(['{"type":"system"}']);
  });

  it("handles multiple partial chunks assembling into one line", () => {
    const buffer = new NdjsonLineBuffer();
    expect(buffer.feed('{"a"')).toEqual([]);
    expect(buffer.feed(":")).toEqual([]);
    expect(buffer.feed("1}\n")).toEqual(['{"a":1}']);
  });

  it("filters empty and whitespace-only lines", () => {
    const buffer = new NdjsonLineBuffer();
    const lines = buffer.feed('{"a":1}\n\n   \n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("strips \\r for \\r\\n tolerance", () => {
    const buffer = new NdjsonLineBuffer();
    const lines = buffer.feed('{"a":1}\r\n{"b":2}\r\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("flush returns remaining partial line", () => {
    const buffer = new NdjsonLineBuffer();
    buffer.feed('{"partial":true');
    expect(buffer.flush()).toBe('{"partial":true');
  });

  it("flush returns null when buffer is empty", () => {
    const buffer = new NdjsonLineBuffer();
    expect(buffer.flush()).toBeNull();
  });

  it("flush returns null after all lines consumed", () => {
    const buffer = new NdjsonLineBuffer();
    buffer.feed('{"complete":true}\n');
    expect(buffer.flush()).toBeNull();
  });

  it("flush resets buffer", () => {
    const buffer = new NdjsonLineBuffer();
    buffer.feed("partial");
    buffer.flush();
    expect(buffer.flush()).toBeNull();
  });
});

describe("mapStopReason", () => {
  it('maps "end_turn" to "stop"', () => {
    expect(mapStopReason("end_turn")).toBe("stop");
  });

  it('maps "max_tokens" to "length"', () => {
    expect(mapStopReason("max_tokens")).toBe("length");
  });

  it('maps null to "stop"', () => {
    expect(mapStopReason(null)).toBe("stop");
  });

  it('maps unknown reasons to "stop"', () => {
    expect(mapStopReason("tool_use")).toBe("stop");
    expect(mapStopReason("something_else")).toBe("stop");
  });
});

describe("StreamAdapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("chunk structure", () => {
    it("emits chunks with correct id, object, created, and model", () => {
      const adapter = createAdapter({ requestId: "abc123", model: "gpt-4o" });
      const { callbacks, chunks } = collectCallbacks();

      // Feed content_block_start to get a chunk
      adapter.processLine(sampleNdjsonStream[1]!, callbacks);

      expect(chunks).toHaveLength(1);
      const chunk = JSON.parse(chunks[0]!) as ChatCompletionChunk;
      expect(chunk.id).toBe("chatcmpl-abc123");
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(typeof chunk.created).toBe("number");
      expect(chunk.model).toBe("gpt-4o");
      expect(chunk.choices).toHaveLength(1);
      expect(chunk.choices[0]!.index).toBe(0);
    });

    it("all chunks share the same created timestamp", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      // content_block_start + two content_block_delta
      adapter.processLine(sampleNdjsonStream[1]!, callbacks);
      adapter.processLine(sampleNdjsonStream[2]!, callbacks);
      adapter.processLine(sampleNdjsonStream[3]!, callbacks);

      const timestamps = chunks.map(
        (c) => (JSON.parse(c) as ChatCompletionChunk).created,
      );
      expect(timestamps[0]).toBe(timestamps[1]);
      expect(timestamps[1]).toBe(timestamps[2]);
    });
  });

  describe("content_block_start", () => {
    it('emits role chunk with delta: { role: "assistant" }', () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      adapter.processLine(sampleNdjsonStream[1]!, callbacks);

      expect(chunks).toHaveLength(1);
      const chunk = JSON.parse(chunks[0]!) as ChatCompletionChunk;
      expect(chunk.choices[0]!.delta).toEqual({ role: "assistant" });
      expect(chunk.choices[0]!.finish_reason).toBeNull();
    });
  });

  describe("content_block_delta", () => {
    it("emits chunk with delta: { content: text }", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      // First need content_block_start, then delta
      adapter.processLine(sampleNdjsonStream[1]!, callbacks);
      adapter.processLine(sampleNdjsonStream[2]!, callbacks);

      expect(chunks).toHaveLength(2);
      const chunk = JSON.parse(chunks[1]!) as ChatCompletionChunk;
      expect(chunk.choices[0]!.delta).toEqual({ content: "Hello" });
      expect(chunk.choices[0]!.finish_reason).toBeNull();
    });

    it("emits each text_delta as a separate chunk", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      adapter.processLine(sampleNdjsonStream[1]!, callbacks); // block_start
      adapter.processLine(sampleNdjsonStream[2]!, callbacks); // "Hello"
      adapter.processLine(sampleNdjsonStream[3]!, callbacks); // " world!"

      expect(chunks).toHaveLength(3); // role + 2 content
      expect(
        (JSON.parse(chunks[1]!) as ChatCompletionChunk).choices[0]!.delta,
      ).toEqual({ content: "Hello" });
      expect(
        (JSON.parse(chunks[2]!) as ChatCompletionChunk).choices[0]!.delta,
      ).toEqual({ content: " world!" });
    });
  });

  describe("message_delta", () => {
    it('emits finish chunk with stop_reason "end_turn" → finish_reason "stop"', () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      adapter.processLine(sampleNdjsonStream[1]!, callbacks); // block_start
      adapter.processLine(sampleNdjsonStream[5]!, callbacks); // message_delta

      expect(chunks).toHaveLength(2);
      const chunk = JSON.parse(chunks[1]!) as ChatCompletionChunk;
      expect(chunk.choices[0]!.delta).toEqual({});
      expect(chunk.choices[0]!.finish_reason).toBe("stop");
    });

    it('emits finish_reason "length" for max_tokens stop reason', () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      // Use sampleMaxTokensNdjsonStream which has stop_reason: "max_tokens"
      adapter.processLine(sampleMaxTokensNdjsonStream[1]!, callbacks); // block_start
      adapter.processLine(sampleMaxTokensNdjsonStream[4]!, callbacks); // message_delta

      expect(chunks).toHaveLength(2);
      const chunk = JSON.parse(chunks[1]!) as ChatCompletionChunk;
      expect(chunk.choices[0]!.finish_reason).toBe("length");
    });
  });

  describe("result event", () => {
    it("calls onDone with usage and session headers", () => {
      const adapter = createAdapter();
      const { callbacks, getDoneMetadata } = collectCallbacks();

      adapter.processLine(sampleNdjsonStream[7]!, callbacks); // result

      const meta = getDoneMetadata();
      expect(meta).toBeDefined();
      expect(meta!.headers["X-Backend-Mode"]).toBe("claude-code");
      expect(meta!.headers["X-Claude-Session-ID"]).toBe(
        "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      );
      expect(meta!.usage).toEqual({
        prompt_tokens: 25,
        completion_tokens: 12,
        total_tokens: 37,
      });
    });

    it("is_error: true result calls handleError", () => {
      const adapter = createAdapter();
      const { callbacks, chunks, getError } = collectCallbacks();

      adapter.processLine(JSON.stringify(sampleCliErrorResult), callbacks);

      // handleError emits finish chunk + onError
      expect(chunks).toHaveLength(1);
      const finishChunk = JSON.parse(chunks[0]!) as ChatCompletionChunk;
      expect(finishChunk.choices[0]!.finish_reason).toBe("stop");

      const error = getError();
      expect(error).toBeDefined();
      expect(error!.error.message).toContain("Stream interrupted");
      expect(error!.error.message).toContain(
        "An error occurred during execution",
      );
      expect(error!.error.code).toBe("stream_error");
    });
  });

  describe("skipped events", () => {
    it("content_block_stop produces no output", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      adapter.processLine(sampleNdjsonStream[4]!, callbacks); // block_stop

      expect(chunks).toHaveLength(0);
    });

    it("message_stop produces no output", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      adapter.processLine(sampleNdjsonStream[6]!, callbacks); // message_stop

      expect(chunks).toHaveLength(0);
    });

    it("system event is silently skipped", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      adapter.processLine(sampleNdjsonStream[0]!, callbacks); // system

      expect(chunks).toHaveLength(0);
    });

    it("system event captures session_id", () => {
      const adapter = createAdapter();
      const { callbacks } = collectCallbacks();

      adapter.processLine(sampleNdjsonStream[0]!, callbacks);

      expect(adapter.getSessionId()).toBe(
        "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      );
    });

    it("unknown event types are silently skipped", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      adapter.processLine(
        JSON.stringify({ type: "tool_use", tool: "bash", input: "ls" }),
        callbacks,
      );

      expect(chunks).toHaveLength(0);
    });
  });

  describe("multiple content blocks", () => {
    it("second content_block_start does NOT re-emit role chunk", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      // Feed all events from multi-block stream
      for (const line of sampleMultiBlockNdjsonStream) {
        adapter.processLine(line, callbacks);
      }

      // Expected chunks:
      // 1. role chunk (from first content_block_start)
      // 2. content "First" (from first content_block_delta)
      // 3. content " Second" (from second content_block_delta)
      // 4. finish chunk (from message_delta)
      // NO second role chunk from second content_block_start
      const roleChunks = chunks
        .map((c) => JSON.parse(c) as ChatCompletionChunk)
        .filter((c) => c.choices[0]!.delta.role === "assistant");
      expect(roleChunks).toHaveLength(1);
    });

    it("content from both blocks is emitted", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      for (const line of sampleMultiBlockNdjsonStream) {
        adapter.processLine(line, callbacks);
      }

      const contentChunks = chunks
        .map((c) => JSON.parse(c) as ChatCompletionChunk)
        .filter((c) => c.choices[0]!.delta.content !== undefined);
      expect(contentChunks).toHaveLength(2);
      expect(contentChunks[0]!.choices[0]!.delta.content).toBe("First");
      expect(contentChunks[1]!.choices[0]!.delta.content).toBe(" Second");
    });
  });

  describe("malformed JSON", () => {
    it("silently skips malformed JSON lines", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      adapter.processLine("not valid json {{{", callbacks);

      expect(chunks).toHaveLength(0);
    });

    it("continues processing after malformed line", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      adapter.processLine("garbage", callbacks);
      adapter.processLine(sampleNdjsonStream[1]!, callbacks); // block_start

      expect(chunks).toHaveLength(1);
      const chunk = JSON.parse(chunks[0]!) as ChatCompletionChunk;
      expect(chunk.choices[0]!.delta.role).toBe("assistant");
    });
  });

  describe("double-callback guard", () => {
    it("processLine is no-op after onDone", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      // Process result → onDone
      adapter.processLine(sampleNdjsonStream[7]!, callbacks);
      expect(adapter.isDone()).toBe(true);

      const chunkCountAfterDone = chunks.length;

      // Further processLine calls are no-ops
      adapter.processLine(sampleNdjsonStream[2]!, callbacks);
      expect(chunks).toHaveLength(chunkCountAfterDone);
    });

    it("processLine is no-op after handleError", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      adapter.handleError("test error", callbacks);
      expect(adapter.isDone()).toBe(true);

      const chunkCountAfterError = chunks.length;

      adapter.processLine(sampleNdjsonStream[2]!, callbacks);
      expect(chunks).toHaveLength(chunkCountAfterError);
    });

    it("handleError is no-op after onDone", () => {
      const adapter = createAdapter();
      const { callbacks, getError } = collectCallbacks();

      adapter.processLine(sampleNdjsonStream[7]!, callbacks); // result → onDone
      adapter.handleError("should be ignored", callbacks);

      expect(getError()).toBeUndefined();
    });
  });

  describe("handleError", () => {
    it("emits finish chunk then calls onError", () => {
      const adapter = createAdapter();
      const { callbacks, chunks, getError, getDoneMetadata } =
        collectCallbacks();

      adapter.handleError("CLI crashed", callbacks);

      // Finish chunk emitted
      expect(chunks).toHaveLength(1);
      const finishChunk = JSON.parse(chunks[0]!) as ChatCompletionChunk;
      expect(finishChunk.choices[0]!.delta).toEqual({});
      expect(finishChunk.choices[0]!.finish_reason).toBe("stop");

      // Error callback called
      const error = getError();
      expect(error).toBeDefined();
      expect(error!.error.message).toBe("Stream interrupted: CLI crashed");
      expect(error!.error.type).toBe("server_error");
      expect(error!.error.param).toBeNull();
      expect(error!.error.code).toBe("stream_error");

      // onDone NOT called
      expect(getDoneMetadata()).toBeUndefined();
    });

    it("error message includes the reason string", () => {
      const adapter = createAdapter();
      const { callbacks, getError } = collectCallbacks();

      adapter.handleError("process exited with code 137", callbacks);

      expect(getError()!.error.message).toBe(
        "Stream interrupted: process exited with code 137",
      );
    });

    it("is no-op when called twice", () => {
      const adapter = createAdapter();
      const { callbacks, chunks } = collectCallbacks();

      adapter.handleError("first error", callbacks);
      adapter.handleError("second error", callbacks);

      // Only one finish chunk from first call
      expect(chunks).toHaveLength(1);
    });
  });

  describe("full happy-path stream", () => {
    it("processes complete sampleNdjsonStream correctly", () => {
      const adapter = createAdapter();
      const { callbacks, chunks, getDoneMetadata } = collectCallbacks();

      for (const line of sampleNdjsonStream) {
        adapter.processLine(line, callbacks);
      }

      // Expected: role chunk, 2 content chunks, finish chunk = 4 chunks
      expect(chunks).toHaveLength(4);

      const parsed = chunks.map((c) => JSON.parse(c) as ChatCompletionChunk);

      // Role chunk
      expect(parsed[0]!.choices[0]!.delta).toEqual({ role: "assistant" });
      expect(parsed[0]!.choices[0]!.finish_reason).toBeNull();

      // Content chunks
      expect(parsed[1]!.choices[0]!.delta).toEqual({ content: "Hello" });
      expect(parsed[2]!.choices[0]!.delta).toEqual({ content: " world!" });

      // Finish chunk
      expect(parsed[3]!.choices[0]!.delta).toEqual({});
      expect(parsed[3]!.choices[0]!.finish_reason).toBe("stop");

      // onDone called with usage
      const meta = getDoneMetadata();
      expect(meta).toBeDefined();
      expect(meta!.usage).toEqual({
        prompt_tokens: 25,
        completion_tokens: 12,
        total_tokens: 37,
      });
    });
  });
});
