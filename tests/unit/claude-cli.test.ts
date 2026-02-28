import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  spawnCli,
  STDIN_PROMPT_THRESHOLD,
  MAX_STDOUT_SIZE,
} from "../../src/services/claude-cli.js";
import { createMockChildProcess } from "../helpers/spawn.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

describe("spawnCli()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultOptions = {
    cliPath: "/usr/bin/claude",
    args: ["--output-format", "json", "-p", "Hello"],
    env: { TERM: "dumb", PATH: "/usr/bin" },
  };

  it("collects stdout from CLI process", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createMockChildProcess({
      stdout: '{"type":"result","result":"Hello!"}',
    });
    mockSpawn.mockReturnValueOnce(child as never);

    const result = await spawnCli(defaultOptions);

    expect(result.stdout).toBe('{"type":"result","result":"Hello!"}');
    expect(result.exitCode).toBe(0);
  });

  it("collects stderr from CLI process", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createMockChildProcess({
      stderr: "Warning: something happened",
      exitCode: 0,
    });
    mockSpawn.mockReturnValueOnce(child as never);

    const result = await spawnCli(defaultOptions);

    expect(result.stderr).toBe("Warning: something happened");
  });

  it("returns non-zero exit code", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createMockChildProcess({ exitCode: 1 });
    mockSpawn.mockReturnValueOnce(child as never);

    const result = await spawnCli(defaultOptions);

    expect(result.exitCode).toBe(1);
  });

  it("rejects on ENOENT spawn error", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    mockSpawn.mockImplementationOnce(() => {
      throw new Error("spawn ENOENT");
    });

    await expect(spawnCli(defaultOptions)).rejects.toThrow(
      "Failed to spawn CLI",
    );
  });

  it("delivers prompt via stdin when useStdin is true", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createMockChildProcess({ stdout: '{"result":"ok"}' });
    const stdinWriteSpy = vi.fn(child.stdin.write);
    child.stdin.write = stdinWriteSpy;
    mockSpawn.mockReturnValueOnce(child as never);

    const bigPrompt = "A".repeat(200_000);
    await spawnCli({
      ...defaultOptions,
      prompt: bigPrompt,
      useStdin: true,
    });

    expect(stdinWriteSpy).toHaveBeenCalledWith(bigPrompt);
  });

  it("kills child process when AbortSignal fires", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createMockChildProcess({ delay: 1000 });
    mockSpawn.mockReturnValueOnce(child as never);

    const controller = new AbortController();

    const resultPromise = spawnCli({
      ...defaultOptions,
      signal: controller.signal,
    });

    // Abort immediately
    controller.abort();

    await resultPromise;

    expect(child.killed).toBe(true);
  });

  it("kills child immediately when signal is already aborted", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createMockChildProcess({ delay: 100 });
    mockSpawn.mockReturnValueOnce(child as never);

    const controller = new AbortController();
    controller.abort();

    const result = await spawnCli({
      ...defaultOptions,
      signal: controller.signal,
    });

    expect(child.killed).toBe(true);
  });

  it("passes correct args and env to spawn", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    const child = createMockChildProcess({});
    mockSpawn.mockReturnValueOnce(child as never);

    await spawnCli(defaultOptions);

    expect(mockSpawn).toHaveBeenCalledWith(
      "/usr/bin/claude",
      ["--output-format", "json", "-p", "Hello"],
      expect.objectContaining({
        stdio: ["pipe", "pipe", "pipe"],
        env: { TERM: "dumb", PATH: "/usr/bin" },
      }),
    );
  });

  it("exports STDIN_PROMPT_THRESHOLD constant", () => {
    expect(STDIN_PROMPT_THRESHOLD).toBe(128 * 1024);
  });

  it("rejects when stdout exceeds MAX_STDOUT_SIZE", async () => {
    const { spawn } = await import("node:child_process");
    const mockSpawn = vi.mocked(spawn);

    // Create a mock child that emits more than MAX_STDOUT_SIZE
    const bigChunk = "A".repeat(MAX_STDOUT_SIZE + 1);
    const child = createMockChildProcess({ stdout: bigChunk });
    mockSpawn.mockReturnValueOnce(child as never);

    await expect(spawnCli(defaultOptions)).rejects.toThrow("exceeded");
  });

  it("exports MAX_STDOUT_SIZE constant", () => {
    expect(MAX_STDOUT_SIZE).toBe(10 * 1024 * 1024);
  });
});
