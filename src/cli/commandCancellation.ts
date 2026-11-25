import { CallerAbort } from "../domain/analysisErrorCore.js";

/** Process signal boundary injectable without emitting signals into a test runner. */
export interface CommandCancellationHost {
  on(signal: "SIGINT" | "SIGTERM" | "SIGBREAK", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM" | "SIGBREAK", listener: () => void): unknown;
  exitCode?: number | string | null | undefined;
}

/** Own process signals until both the operation and its resources settle. */
export class CommandCancellationScope {
  readonly #controller = new AbortController();
  #exitStatus: 130 | 143 | 149 | undefined;
  #finished = false;
  #closed = false;

  constructor(private readonly host: CommandCancellationHost = process) {
    host.on("SIGINT", this.#interrupt);
    host.on("SIGTERM", this.#terminate);
    // Windows only: Node delivers CTRL_BREAK_EVENT as SIGBREAK. Listening
    // gives a Windows wrapper the same abort-and-cleanup path POSIX
    // wrappers already reach with SIGINT/SIGTERM. TerminateProcess still
    // skips cleanup; see issue #4659.
    host.on("SIGBREAK", this.#consoleBreak);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get exitStatus(): 130 | 143 | 149 | undefined {
    return this.#exitStatus;
  }

  readonly #interrupt = () => this.#abort("SIGINT", 130);
  readonly #terminate = () => this.#abort("SIGTERM", 143);
  readonly #consoleBreak = () => this.#abort("SIGBREAK", 149);

  #abort(
    signal: "SIGINT" | "SIGTERM" | "SIGBREAK",
    status: 130 | 143 | 149,
  ): void {
    this.#exitStatus ??= status;
    this.#controller.abort(CallerAbort.forProcessSignal(signal));
    if (this.#finished) this.finish();
  }

  /** Publish the disposition while a failed resource close still owns signals. */
  finish(): void {
    this.#finished = true;
    if (this.#exitStatus !== undefined) this.host.exitCode = this.#exitStatus;
  }

  /** Release signal ownership only after the resource owner confirms cleanup. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.host.off("SIGINT", this.#interrupt);
    this.host.off("SIGTERM", this.#terminate);
    this.host.off("SIGBREAK", this.#consoleBreak);
    this.finish();
  }
}

/** Translate one-shot CLI interrupts into awaited cleanup and conventional exit codes. */
export const withCommandCancellation = async <Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  host: CommandCancellationHost = process,
): Promise<Value> => {
  const scope = new CommandCancellationScope(host);
  try {
    return await operation(scope.signal);
  } finally {
    scope.close();
  }
};
