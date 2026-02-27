import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

export interface MockChildProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: { write: (data: string) => void; end: () => void };
  pid: number;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
}

export interface MockSpawnOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delay?: number;
  pid?: number;
}

export function createMockChildProcess(
  options: MockSpawnOptions = {},
): MockChildProcess {
  const {
    stdout = "",
    stderr = "",
    exitCode = 0,
    delay = 0,
    pid = 12345,
  } = options;

  const stdoutStream = new Readable({ read() {} });
  const stderrStream = new Readable({ read() {} });
  const stdinData: string[] = [];

  const child = new EventEmitter() as MockChildProcess;
  child.stdout = stdoutStream;
  child.stderr = stderrStream;
  child.stdin = {
    write: (data: string) => stdinData.push(data),
    end: () => {},
  };
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.kill = (signal?: string) => {
    child.killed = true;
    child.emit("exit", signal === "SIGKILL" ? null : exitCode, signal);
    process.nextTick(() => child.emit("close", exitCode, signal));
    return true;
  };

  const emitOutput = () => {
    if (stdout) {
      stdoutStream.push(stdout);
    }
    stdoutStream.push(null);

    if (stderr) {
      stderrStream.push(stderr);
    }
    stderrStream.push(null);

    // Delay exit/close by one tick so the stream's resume() (which is
    // also scheduled via nextTick when a 'data' listener is added) has
    // a chance to drain buffered data before close fires.
    process.nextTick(() => {
      child.exitCode = exitCode;
      child.emit("exit", exitCode, null);
      child.emit("close", exitCode, null);
    });
  };

  if (delay > 0) {
    setTimeout(emitOutput, delay);
  } else {
    process.nextTick(emitOutput);
  }

  return child;
}

export function createStreamingMockChildProcess(
  lines: string[],
  options: { exitCode?: number; pid?: number; lineDelay?: number } = {},
): MockChildProcess {
  const { exitCode = 0, pid = 12345, lineDelay = 0 } = options;

  const stdoutStream = new Readable({ read() {} });
  const stderrStream = new Readable({ read() {} });

  const child = new EventEmitter() as MockChildProcess;
  child.stdout = stdoutStream;
  child.stderr = stderrStream;
  child.stdin = {
    write: () => {},
    end: () => {},
  };
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.kill = (signal?: string) => {
    child.killed = true;
    child.emit("exit", signal === "SIGKILL" ? null : exitCode, signal);
    process.nextTick(() => child.emit("close", exitCode, signal));
    return true;
  };

  const emitLines = async () => {
    for (const line of lines) {
      stdoutStream.push(line + "\n");
      if (lineDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, lineDelay));
      }
    }
    stdoutStream.push(null);
    stderrStream.push(null);
    // Delay exit/close by one tick so the stream's resume() (which is
    // also scheduled via nextTick when a 'data' listener is added) has
    // a chance to drain buffered data before close fires. This matches
    // real child_process behavior where close fires after stdio streams
    // are fully consumed.
    process.nextTick(() => {
      child.exitCode = exitCode;
      child.emit("exit", exitCode, null);
      child.emit("close", exitCode, null);
    });
  };

  process.nextTick(() => void emitLines());

  return child;
}
