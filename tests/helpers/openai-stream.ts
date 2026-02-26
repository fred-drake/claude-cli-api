import type {
  ChatCompletionChunk,
  ChatCompletionChunkChoice,
} from "../../src/types/openai.js";

export function createMockOpenAIStream(
  chunks: ChatCompletionChunk[],
): AsyncIterable<ChatCompletionChunk> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

export function buildChunk(
  delta: ChatCompletionChunkChoice["delta"],
  options: {
    id?: string;
    model?: string;
    finishReason?: ChatCompletionChunkChoice["finish_reason"];
  } = {},
): ChatCompletionChunk {
  return {
    id: options.id ?? "chatcmpl-test",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: options.model ?? "gpt-4o",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: options.finishReason ?? null,
      },
    ],
  };
}

export function createTypicalStreamChunks(
  content: string,
  model = "gpt-4o",
): ChatCompletionChunk[] {
  const id = "chatcmpl-test-stream";
  const created = Math.floor(Date.now() / 1000);

  return [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    },
    ...content.split("").map((char) => ({
      id,
      object: "chat.completion.chunk" as const,
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: char },
          finish_reason: null as "stop" | "length" | "content_filter" | null,
        },
      ],
    })),
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
}
