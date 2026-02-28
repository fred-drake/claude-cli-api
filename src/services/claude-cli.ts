import { spawn } from "node:child_process";

export const STDIN_PROMPT_THRESHOLD = 128 * 1024;
export const MAX_STDOUT_SIZE = 10 * 1024 * 1024; // 10 MB

export interface SpawnCliOptions {
  cliPath: string;
  args: string[];
  env: Record<string, string>;
  prompt?: string;
  useStdin?: boolean;
  signal?: AbortSignal;
}

export interface SpawnCliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
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

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_SIZE) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`CLI stdout exceeded ${MAX_STDOUT_SIZE} bytes limit`));
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
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
    if (options.useStdin && options.prompt) {
      child.stdin.write(options.prompt);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

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
