import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

export const STDIN_PROMPT_THRESHOLD = 128 * 1024;
export const MAX_STDOUT_SIZE = 10 * 1024 * 1024; // 10 MB
export const MAX_STDERR_SIZE = 1 * 1024 * 1024; // 1 MB
export const STDERR_LIMIT_MSG = `CLI stderr exceeded ${MAX_STDERR_SIZE} bytes limit`;

export interface SpawnCliOptions {
  cliPath: string;
  args: string[];
  env: Record<string, string>;
  prompt?: string;
  useStdin?: boolean;
  signal?: AbortSignal;
  onSpawn?: (child: ChildProcess) => void;
}

export interface SpawnCliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Writes prompt to stdin with backpressure handling, then closes stdin. */
export function deliverStdin(
  stdin: Writable,
  prompt: string | undefined,
): void {
  if (prompt) {
    const ok = stdin.write(prompt);
    if (ok) {
      stdin.end();
    } else {
      stdin.once("drain", () => stdin.end());
    }
  } else {
    stdin.end();
  }
}

export function spawnCli(options: SpawnCliOptions): Promise<SpawnCliResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(options.cliPath, options.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: options.env,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      reject(new Error(`Failed to spawn CLI: ${message}`));
      return;
    }

    if (options.onSpawn) {
      options.onSpawn(child);
    }

    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let stderrBytes = 0;
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > MAX_STDOUT_SIZE) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`CLI stdout exceeded ${MAX_STDOUT_SIZE} bytes limit`));
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (!settled && stderrBytes > MAX_STDERR_SIZE) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(STDERR_LIMIT_MSG));
      }
    });

    // Handle spawn errors (e.g., ENOENT)
    child.on("error", (err: Error) => {
      settled = true;
      reject(new Error(`Failed to spawn CLI: ${err.message}`));
    });

    // AbortSignal support
    const onAbort = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    if (options.signal) {
      if (options.signal.aborted) {
        child.kill("SIGTERM");
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Deliver prompt via stdin if requested
    deliverStdin(child.stdin!, options.useStdin ? options.prompt : undefined);

    child.on("close", (exitCode) => {
      // Clean up abort listener
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      if (!settled) {
        resolve({ stdout, stderr, exitCode });
      }
    });
  });
}
