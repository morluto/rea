import {
  execFile,
  type ExecFileOptionsWithBufferEncoding,
} from "node:child_process";

type ExecFileOutputOptions = Omit<
  ExecFileOptionsWithBufferEncoding,
  "encoding" | "maxBuffer"
> & {
  readonly maxBuffer?: number;
  /**
   * Signal that stops the process on abort or timeout. The promise then
   * settles only after the process exits, so the caller can remove files it
   * writes; a process still running after a grace period is killed. Without
   * it, Node's execFile sends SIGTERM on abort and rejects before the
   * process exits.
   */
  readonly stopSignal?: NodeJS.Signals;
};

/** How long a stopped process may take to exit before it is killed. */
const STOP_GRACE_MS = 5_000;

const abortError = (signal: AbortSignal): Error => {
  const error = new Error("The operation was aborted", {
    cause: signal.reason,
  });
  error.name = "AbortError";
  Reflect.set(error, "code", "ABORT_ERR");
  return error;
};

/**
 * A command stopped at its timeout can still exit cleanly, so the timeout is
 * the failure. Like Node's execFile timeout, it reports `killed: true`.
 */
const timeoutError = (
  command: string,
  timeout: number,
  exit: Error | null,
): Error => {
  const error = new Error(
    `Command timed out after ${String(timeout)} ms: ${command}`,
    exit === null ? undefined : { cause: exit },
  );
  Reflect.set(error, "code", "ETIMEDOUT");
  Reflect.set(error, "killed", true);
  Reflect.set(
    error,
    "signal",
    exit === null ? null : (Reflect.get(exit, "signal") ?? null),
  );
  return error;
};

/**
 * The `timeout` contract for both modes, checked before spawning. A stoppable
 * command keeps its own deadline, so execFile never validates it. Node 26's
 * execFile also caps it at Number.MAX_SAFE_INTEGER; Node 22 and 24 accept
 * larger integers, which their timers then clamp to 1 ms.
 */
const invalidTimeout = (timeout: number): RangeError | undefined => {
  if (Number.isSafeInteger(timeout) && timeout >= 0) return undefined;
  const error = new RangeError(
    `The value of "timeout" is out of range. It must be an unsigned integer. Received ${String(timeout)}`,
  );
  Reflect.set(error, "code", "ERR_OUT_OF_RANGE");
  return error;
};

/** Captured subprocess output read from an execFileOutput rejection. */
export interface ExecFileOutputFailure {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: string | number | null;
  readonly signal: string | null;
  readonly killed: boolean;
  readonly outputTruncated: boolean;
}

/** Read captured output metadata from a failed execFileOutput invocation. */
export const execFileOutputFailure = (
  cause: unknown,
): ExecFileOutputFailure | undefined => {
  if (!(cause instanceof Error)) return undefined;
  const stdout = Reflect.get(cause, "stdout");
  const stderr = Reflect.get(cause, "stderr");
  const code = Reflect.get(cause, "code");
  const signal = Reflect.get(cause, "signal");
  const killed = Reflect.get(cause, "killed");
  if (typeof stdout !== "string" || typeof stderr !== "string")
    return undefined;
  return {
    stdout,
    stderr,
    code: typeof code === "string" || typeof code === "number" ? code : null,
    signal: typeof signal === "string" ? signal : null,
    killed: killed === true,
    outputTruncated: code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  };
};

/** Run a shell-free command while capturing its complete output bytes. */
export const execFileBytes = (
  command: string,
  arguments_: readonly string[],
  options: ExecFileOutputOptions = {},
): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }> =>
  new Promise((resolve, reject) => {
    const { stopSignal, signal, timeout, ...execOptions } = options;
    const invalid = timeout === undefined ? undefined : invalidTimeout(timeout);
    if (invalid !== undefined) {
      reject(invalid);
      return;
    }
    if (stopSignal !== undefined && signal?.aborted === true) {
      reject(abortError(signal));
      return;
    }
    let stopped: "abort" | "timeout" | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    const child = execFile(
      command,
      [...arguments_],
      {
        ...execOptions,
        // A stoppable command's abort and timeout are handled below, because
        // execFile neither waits for the exit on abort nor kills a process
        // that ignores its timeout signal.
        ...(stopSignal === undefined
          ? {
              ...(signal === undefined ? {} : { signal }),
              ...(timeout === undefined ? {} : { timeout }),
            }
          : { killSignal: stopSignal }),
        encoding: "buffer",
        maxBuffer: options.maxBuffer ?? Number.POSITIVE_INFINITY,
      },
      (error, stdout, stderr) => {
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(deadline);
        clearTimeout(grace);
        const failure =
          stopped === "abort" && signal !== undefined
            ? abortError(signal)
            : stopped === "timeout" && timeout !== undefined
              ? timeoutError(command, timeout, error)
              : error;
        if (failure !== null) {
          Reflect.set(failure, "stdout", stdout.toString("utf8"));
          Reflect.set(failure, "stderr", stderr.toString("utf8"));
          reject(failure);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    // The first stop request names the failure; a later one is not resent.
    const stop = (reason: "abort" | "timeout"): void => {
      if (stopped !== undefined) return;
      stopped = reason;
      child.kill(stopSignal);
      grace = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
    };
    const onAbort = (): void => {
      stop("abort");
    };
    if (stopSignal === undefined) return;
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeout !== undefined && timeout > 0)
      deadline = setTimeout(() => {
        stop("timeout");
      }, timeout);
  });

/** Run a shell-free command while capturing its complete UTF-8 output. */
export const execFileOutput = (
  command: string,
  arguments_: readonly string[],
  options: ExecFileOutputOptions = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> =>
  execFileBytes(command, arguments_, options).then(({ stdout, stderr }) => ({
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
  }));
