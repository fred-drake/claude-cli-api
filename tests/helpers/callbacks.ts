import type { BackendStreamCallbacks } from "../../src/backends/types.js";
import type {
  ChatCompletionUsage,
  OpenAIError,
} from "../../src/types/openai.js";

export function collectCallbacks() {
  const chunks: string[] = [];
  let doneMetadata:
    | { headers: Record<string, string>; usage?: ChatCompletionUsage }
    | undefined;
  let error: OpenAIError | undefined;

  const callbacks: BackendStreamCallbacks = {
    onChunk: (chunk: string) => chunks.push(chunk),
    onDone: (meta: {
      headers: Record<string, string>;
      usage?: ChatCompletionUsage;
    }) => {
      doneMetadata = meta;
    },
    onError: (err: OpenAIError) => {
      error = err;
    },
  };

  return {
    callbacks,
    chunks,
    getDoneMetadata: () => doneMetadata,
    getError: () => error,
  };
}
