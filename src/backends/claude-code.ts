import { spawn } from "node:child_process";
import type { ChatCompletionRequest } from "../types/openai.js";
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
    _request: ChatCompletionRequest,
    _context: RequestContext,
  ): Promise<BackendResult> {
    throw new Error("Non-streaming complete() not yet implemented");
  }

  async completeStream(
    request: ChatCompletionRequest,
    context: RequestContext,
    callbacks: BackendStreamCallbacks,
  ): Promise<void> {
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
  ): Promise<void> {
    try {
      const args = this.buildCliArgs(request, context, session);

      const child = spawn(this.options.cliPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.buildSanitizedEnv(),
      });

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

  private buildCliArgs(
    request: ChatCompletionRequest,
    context: RequestContext,
    session?: SessionResult,
  ): string[] {
    const args: string[] = ["--output-format", "stream-json"];

    if (context.sessionId && session) {
      if (session.action === "created") {
        args.push("--session-id", context.sessionId);
      } else {
        args.push("--resume", context.sessionId);
      }
    }

    const systemMessages = request.messages.filter((m) => m.role === "system");
    if (systemMessages.length > 0) {
      const systemPrompt = systemMessages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n\n");
      args.push("--system-prompt", systemPrompt);
    }

    if (request.max_tokens) {
      args.push("--max-tokens", String(request.max_tokens));
    }

    const userMessages = request.messages.filter((m) => m.role !== "system");
    if (userMessages.length > 0) {
      const lastMessage = userMessages[userMessages.length - 1]!;
      const prompt =
        typeof lastMessage.content === "string"
          ? lastMessage.content
          : JSON.stringify(lastMessage.content);
      args.push("-p", prompt);
    }

    return args;
  }

  private buildSanitizedEnv(): Record<string, string> {
    const env: Record<string, string> = {
      TERM: "dumb",
    };
    const allowlist = ["PATH", "HOME", "LANG", "ANTHROPIC_API_KEY"];
    for (const key of allowlist) {
      if (process.env[key]) {
        env[key] = process.env[key]!;
      }
    }
    return env;
  }
}
