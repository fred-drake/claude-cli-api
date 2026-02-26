import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionUsage,
  OpenAIError,
} from "../types/openai.js";

export type BackendMode = "claude-code" | "openai-passthrough";

/**
 * Health status returned by each backend's `healthCheck()` method.
 * - `"ok"`: Backend is operational
 * - `"error"`: Backend encountered a problem (see `message`)
 * - `"disabled"`: Backend is explicitly disabled via configuration
 * - `"missing"`: Required dependency is not available (e.g., CLI binary)
 * - `"no_key"`: Required API key is not configured
 */
export type HealthStatus =
  | { status: "ok" }
  | { status: "error"; message: string }
  | { status: "disabled" }
  | { status: "missing" }
  | { status: "no_key" };

export interface CompletionBackend {
  readonly name: BackendMode;

  complete(
    request: ChatCompletionRequest,
    context: RequestContext,
  ): Promise<BackendResult>;

  completeStream(
    request: ChatCompletionRequest,
    context: RequestContext,
    callbacks: BackendStreamCallbacks,
  ): Promise<void>;

  healthCheck(): Promise<HealthStatus>;
}

export interface BackendResult {
  response: ChatCompletionResponse;
  headers: Record<string, string>;
}

export interface BackendStreamCallbacks {
  /**
   * Called with each chunk as a raw JSON string (e.g., a serialized
   * `ChatCompletionChunk`). The route handler is responsible for
   * wrapping this in SSE format (`data: ...\n\n`), keeping SSE
   * formatting centralized rather than in individual backends.
   */
  onChunk: (chunk: string) => void;
  onDone: (metadata: {
    headers: Record<string, string>;
    usage?: ChatCompletionUsage;
  }) => void;
  onError: (error: OpenAIError) => void;
}

export interface RequestContext {
  requestId: string;
  sessionId?: string;
  clientOpenAIKey?: string;
  apiKey?: string;
  clientIp: string;
  method: string;
  path: string;
}
