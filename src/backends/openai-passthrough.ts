import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions.js";
import {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
} from "openai";
import type { ChatCompletionRequest, OpenAIError } from "../types/openai.js";
import type {
  BackendMode,
  BackendResult,
  BackendStreamCallbacks,
  CompletionBackend,
  HealthStatus,
  RequestContext,
} from "./types.js";

export interface OpenAIPassthroughOptions {
  apiKey: string;
  baseURL: string;
  enabled: boolean;
  allowClientKey: boolean;
}

export class PassthroughError extends Error {
  readonly status: number;
  readonly body: OpenAIError;

  constructor(status: number, body: OpenAIError, options?: { cause?: Error }) {
    super(body.error.message, options);
    this.name = "PassthroughError";
    this.status = status;
    this.body = body;
  }
}

export class OpenAIPassthroughBackend implements CompletionBackend {
  readonly name: BackendMode = "openai-passthrough";
  private readonly options: OpenAIPassthroughOptions;
  private readonly defaultClient: OpenAI | null;

  constructor(options: OpenAIPassthroughOptions) {
    this.options = options;
    this.defaultClient =
      options.apiKey !== ""
        ? new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL })
        : null;
  }

  async complete(
    request: ChatCompletionRequest,
    context: RequestContext,
  ): Promise<BackendResult> {
    this.ensureEnabled();
    const client = this.resolveClient(context);

    try {
      // Cast through unknown: our ChatCompletionRequest is structurally compatible
      // with the SDK params, but TS can't unify the role union with the SDK's
      // discriminated-union message types. Safe because this is a transparent proxy.
      const response = await client.chat.completions.create({
        ...request,
        stream: false,
      } as unknown as ChatCompletionCreateParamsNonStreaming);

      // SDK ChatCompletion is structurally compatible with our ChatCompletionResponse;
      // cast is safe because we pass stream: false and the shapes align.
      return {
        response: response as unknown as BackendResult["response"],
        headers: { "X-Backend-Mode": "openai-passthrough" },
      };
    } catch (err: unknown) {
      const { status, openaiError } = this.toOpenAIError(err);
      throw new PassthroughError(status, openaiError, {
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  async completeStream(
    request: ChatCompletionRequest,
    context: RequestContext,
    callbacks: BackendStreamCallbacks,
  ): Promise<void> {
    try {
      this.ensureEnabled();
      const client = this.resolveClient(context);

      const stream = await client.chat.completions.create({
        ...request,
        stream: true,
      } as unknown as ChatCompletionCreateParamsStreaming);

      let lastUsage: BackendResult["response"]["usage"] | undefined;

      for await (const chunk of stream) {
        if (chunk.usage) {
          lastUsage = chunk.usage as BackendResult["response"]["usage"];
        }
        callbacks.onChunk(JSON.stringify(chunk));
      }

      callbacks.onDone({
        headers: { "X-Backend-Mode": "openai-passthrough" },
        usage: lastUsage,
      });
    } catch (err: unknown) {
      const { openaiError } = this.toOpenAIError(err);
      if (err instanceof PassthroughError) {
        callbacks.onError(err.body);
      } else {
        // HTTP status from toOpenAIError is not forwarded here because once SSE
        // streaming begins the HTTP status is already committed (200). The error
        // body is embedded in the SSE event payload for the client to interpret.
        callbacks.onError(openaiError);
      }
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    if (!this.options.enabled) {
      return { status: "disabled" };
    }
    if (this.options.apiKey !== "" || this.options.allowClientKey) {
      return { status: "ok" };
    }
    return { status: "no_key" };
  }

  private ensureEnabled(): void {
    if (!this.options.enabled) {
      throw new PassthroughError(503, {
        error: {
          message: "OpenAI passthrough is disabled",
          type: "server_error",
          param: null,
          code: "passthrough_disabled",
        },
      });
    }
  }

  private resolveClient(context: RequestContext): OpenAI {
    if (this.options.allowClientKey && context.clientOpenAIKey) {
      return new OpenAI({
        apiKey: context.clientOpenAIKey,
        baseURL: this.options.baseURL,
      });
    }
    if (this.defaultClient) {
      return this.defaultClient;
    }
    throw new PassthroughError(503, {
      error: {
        message:
          "OpenAI passthrough is not configured: no server key and client keys are not allowed",
        type: "server_error",
        param: null,
        code: "passthrough_not_configured",
      },
    });
  }

  private toOpenAIError(err: unknown): {
    status: number;
    openaiError: OpenAIError;
  } {
    if (err instanceof PassthroughError) {
      return { status: err.status, openaiError: err.body };
    }

    if (err instanceof APIConnectionTimeoutError) {
      return {
        status: 504,
        openaiError: {
          error: {
            message: err.message || "Connection timed out",
            type: "connection_error",
            param: null,
            code: "timeout",
          },
        },
      };
    }

    if (err instanceof APIConnectionError) {
      return {
        status: 502,
        openaiError: {
          error: {
            message: err.message || "Connection failed",
            type: "connection_error",
            param: null,
            code: "connection_error",
          },
        },
      };
    }

    if (err instanceof APIError) {
      const status = err.status ?? 500;
      // Try to extract a well-formed error body from the SDK error
      const errBody = err.error as
        | {
            message?: string;
            type?: string;
            param?: string | null;
            code?: string | null;
          }
        | undefined;

      if (
        errBody &&
        typeof errBody === "object" &&
        typeof errBody.message === "string"
      ) {
        return {
          status,
          openaiError: {
            error: {
              message: errBody.message,
              type: errBody.type ?? "api_error",
              param: errBody.param ?? null,
              code: errBody.code ?? null,
            },
          },
        };
      }

      // Malformed body fallback
      return {
        status,
        openaiError: {
          error: {
            message: err.message || "Unknown API error",
            type: "api_error",
            param: null,
            code: null,
          },
        },
      };
    }

    // Unknown error
    return {
      status: 500,
      openaiError: {
        error: {
          message: err instanceof Error ? err.message : "Internal server error",
          type: "server_error",
          param: null,
          code: null,
        },
      },
    };
  }
}
