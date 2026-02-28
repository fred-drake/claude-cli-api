// Direct spawn import is used by doCompleteStream() which needs the child
// process handle for incremental NDJSON stdout reads. The spawnCli() helper
// in claude-cli.ts buffers entire output and is only suitable for non-streaming.
import { spawn } from "node:child_process";
import type { ChatCompletionRequest } from "../types/openai.js";
import type { ClaudeCliResult } from "../types/claude-cli.js";
import type {
  BackendMode,
  BackendResult,
  BackendStreamCallbacks,
  CompletionBackend,
  HealthStatus,
  RequestContext,
} from "./types.js";
import { NdjsonLineBuffer, StreamAdapter } from "../transformers/stream.js";
import type { SessionResult } from "../services/session-manager.js";
import { SessionError, SessionManager } from "../services/session-manager.js";
import { ApiError } from "../errors/handler.js";
import { mapModel } from "../services/model-mapper.js";
import type { BuildPromptResult } from "../transformers/request.js";
import {
  validateParams,
  buildPrompt,
  buildCliArgs,
  buildSanitizedEnv,
} from "../transformers/request.js";
import {
  transformCliResult,
  detectAuthFailure,
} from "../transformers/response.js";
import { spawnCli, STDIN_PROMPT_THRESHOLD } from "../services/claude-cli.js";

export interface ClaudeCodeOptions {
  cliPath: string;
  enabled: boolean;
}

export class ClaudeCodeBackend implements CompletionBackend {
  readonly name: BackendMode = "claude-code";
  private readonly options: ClaudeCodeOptions;
  private readonly sessionManager: SessionManager;

  constructor(options: ClaudeCodeOptions, sessionManager: SessionManager) {
    this.options = options;
    this.sessionManager = sessionManager;
  }

  async complete(
    request: ChatCompletionRequest,
    context: RequestContext,
  ): Promise<BackendResult> {
    const created = Math.floor(Date.now() / 1000);

    // Phase 1 — Pre-lock (validation, may throw freely)

    // 1. Validate params (Tier 3 rejection, Tier 2 collection)
    const validation = validateParams(request);
    if ("error" in validation) {
      throw new ApiError(400, validation.error);
    }
    const { ignoredParams } = validation;

    // 2. Map model
    const modelResult = mapModel(request.model);
    if ("error" in modelResult) {
      throw new ApiError(400, modelResult.error);
    }
    const { resolvedModel } = modelResult;

    // 3. Build prompt
    const isResume = context.sessionId !== undefined;
    let promptResult;
    try {
      promptResult = buildPrompt(request.messages, isResume);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ApiError(400, {
        error: {
          message,
          type: "invalid_request_error",
          param: "messages",
          code: "invalid_request",
        },
      });
    }

    // 4. Resolve session
    const sessionResult = this.sessionManager.resolveSession(
      context.sessionId,
      context.apiKey ?? "__anonymous__",
      request.model,
    );

    // 5. Acquire lock
    this.sessionManager.acquireLock(sessionResult.sessionId);

    // Phase 2 — Post-lock (try/finally, lock always released)
    try {
      // 6. Build CLI args
      const useStdin =
        Buffer.byteLength(promptResult.prompt, "utf8") > STDIN_PROMPT_THRESHOLD;
      const args = buildCliArgs({
        outputFormat: "json",
        prompt: promptResult.prompt,
        systemPrompt: promptResult.systemPrompt,
        resolvedModel,
        sessionId: sessionResult.sessionId,
        sessionAction: sessionResult.action,
        useStdin,
      });

      // 7. Spawn CLI
      const cliResult = await spawnCli({
        cliPath: this.options.cliPath,
        args,
        env: buildSanitizedEnv(),
        prompt: useStdin ? promptResult.prompt : undefined,
        useStdin,
        signal: context.signal,
      });

      // Handle non-zero exit
      if (cliResult.exitCode !== 0 && cliResult.exitCode !== null) {
        // Check for auth failure
        if (detectAuthFailure(cliResult.stderr)) {
          throw new ApiError(401, {
            error: {
              message: "Authentication failed. Check your ANTHROPIC_API_KEY.",
              type: "invalid_request_error",
              param: null,
              code: "invalid_api_key",
            },
          });
        }

        const reason = cliResult.stderr.trim()
          ? `CLI process exited with code ${cliResult.exitCode}: ${cliResult.stderr.trim()}`
          : `CLI process exited with code ${cliResult.exitCode}`;
        throw new ApiError(500, {
          error: {
            message: reason,
            type: "server_error",
            param: null,
            code: "backend_error",
          },
        });
      }

      // 8. Parse JSON stdout
      let parsed: ClaudeCliResult;
      try {
        parsed = JSON.parse(cliResult.stdout) as ClaudeCliResult;
      } catch {
        throw new ApiError(500, {
          error: {
            message: "Failed to parse CLI output as JSON",
            type: "server_error",
            param: null,
            code: "backend_error",
          },
        });
      }

      // 9. Transform CLI result
      const transformed = transformCliResult(
        parsed,
        request.model,
        context.requestId,
        created,
      );

      if ("error" in transformed) {
        throw new ApiError(transformed.status, transformed.error);
      }

      // 10. Assemble headers
      const headers: Record<string, string> = {
        ...transformed.headers,
        "X-Claude-Session-ID": sessionResult.sessionId,
      };

      if (sessionResult.action === "created") {
        headers["X-Claude-Session-Created"] = "true";
      }

      if (ignoredParams.length > 0) {
        headers["X-Claude-Ignored-Params"] = ignoredParams.join(", ");
      }

      // 11. Return BackendResult
      return {
        response: transformed.response,
        headers,
      };
    } finally {
      this.sessionManager.releaseLock(sessionResult.sessionId);
    }
  }

  async completeStream(
    request: ChatCompletionRequest,
    context: RequestContext,
    callbacks: BackendStreamCallbacks,
  ): Promise<void> {
    // Pre-session validation (matches complete() parity)
    const validation = validateParams(request);
    if ("error" in validation) {
      callbacks.onError(validation.error);
      return;
    }

    const modelResult = mapModel(request.model);
    if ("error" in modelResult) {
      callbacks.onError(modelResult.error);
      return;
    }
    const { resolvedModel } = modelResult;

    const isResumeHint = context.sessionId !== undefined;
    let promptResult: BuildPromptResult;
    try {
      promptResult = buildPrompt(request.messages, isResumeHint);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      callbacks.onError({
        error: {
          message,
          type: "invalid_request_error",
          param: "messages",
          code: "invalid_request",
        },
      });
      return;
    }

    let sessionResult: SessionResult;
    try {
      sessionResult = this.sessionManager.resolveSession(
        context.sessionId,
        context.apiKey ?? "__anonymous__",
        request.model,
      );
    } catch (err) {
      if (err instanceof SessionError) {
        callbacks.onError(err.body);
        return;
      }
      throw err;
    }

    this.sessionManager.acquireLock(sessionResult.sessionId);

    const wrappedCallbacks: BackendStreamCallbacks = {
      ...callbacks,
      onDone: (metadata) => {
        callbacks.onDone({
          ...metadata,
          headers: {
            ...metadata.headers,
            ...(sessionResult.action === "created"
              ? { "X-Claude-Session-Created": "true" }
              : {}),
          },
        });
      },
    };

    try {
      const resolvedContext = {
        ...context,
        sessionId: sessionResult.sessionId,
      };
      await this.doCompleteStream(
        request,
        resolvedContext,
        wrappedCallbacks,
        sessionResult,
        resolvedModel,
        promptResult,
      );
    } finally {
      this.sessionManager.releaseLock(sessionResult.sessionId);
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    if (!this.options.enabled) return { status: "disabled" };
    return { status: "ok" };
  }

  private async doCompleteStream(
    request: ChatCompletionRequest,
    context: RequestContext,
    callbacks: BackendStreamCallbacks,
    session: SessionResult,
    resolvedModel: string,
    promptResult: BuildPromptResult,
  ): Promise<void> {
    try {
      const args = buildCliArgs({
        outputFormat: "stream-json",
        prompt: promptResult.prompt,
        systemPrompt: promptResult.systemPrompt,
        resolvedModel,
        sessionId: context.sessionId!,
        sessionAction: session.action,
        streaming: true,
      });

      const child = spawn(this.options.cliPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildSanitizedEnv(),
      });

      // Close stdin immediately — prompt is passed via -p flag, not stdin.
      // Without this, the CLI may block waiting for stdin to close.
      child.stdin.end();

      // Wire abort signal for client disconnect cancellation
      const onAbort = () => {
        if (!child.killed) child.kill("SIGTERM");
      };
      if (context.signal) {
        context.signal.addEventListener("abort", onAbort, { once: true });
      }

      const lineBuffer = new NdjsonLineBuffer();
      const adapter = new StreamAdapter({
        requestId: context.requestId,
        model: request.model,
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        const lines = lineBuffer.feed(chunk);
        for (const line of lines) {
          adapter.processLine(line, callbacks);
        }
      });

      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      // Handle spawn errors that occur after spawn() succeeds
      // (e.g., EPERM). Without this, Node.js throws an uncaught error.
      child.on("error", (err: Error) => {
        adapter.handleError(err.message, callbacks);
      });

      // Capture exit code from exit event, finalize on close event.
      // Node.js may fire exit before all stdout data events are delivered.
      // The close event fires after stdio streams are fully consumed.
      let exitCode: number | null = null;
      child.on("exit", (code) => {
        exitCode = code;
      });

      await new Promise<void>((resolve) => {
        child.on("close", () => {
          try {
            // Clean up abort listener to prevent child reference leak
            if (context.signal) {
              context.signal.removeEventListener("abort", onAbort);
            }

            // Flush remaining buffer after all stdout data delivered
            const remaining = lineBuffer.flush();
            if (remaining) {
              adapter.processLine(remaining, callbacks);
            }

            if (exitCode !== 0 && exitCode !== null) {
              const reason = stderr.trim()
                ? `CLI process exited with code ${exitCode}: ${stderr.trim()}`
                : `CLI process exited with code ${exitCode}`;
              adapter.handleError(reason, callbacks);
            } else if (exitCode === 0 && !adapter.isDone()) {
              // Normal exit but no result event — fallback onDone
              callbacks.onDone({
                headers: {
                  "X-Backend-Mode": "claude-code",
                  ...(adapter.getSessionId()
                    ? { "X-Claude-Session-ID": adapter.getSessionId()! }
                    : {}),
                },
              });
            }
          } catch {
            // Defensive: if callbacks throw, still resolve the promise
            // to avoid hanging the request.
          }

          resolve();
        });
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      callbacks.onError({
        error: {
          message: `Failed to start CLI: ${message}`,
          type: "server_error",
          param: null,
          code: "cli_spawn_error",
        },
      });
    }
  }
}
