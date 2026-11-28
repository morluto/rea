import { CallerAbort } from "../domain/analysisErrorCore.js";

/** Process signal boundary injectable without emitting signals into a test runner. */
export interface CommandCancellationHost {
  on(signal: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown;
  exitCode?: number | string | null | undefined;
}

/** Own process signals until both the operation and its resources settle. */
export class CommandCancellationScope {
  readonly #controller = new AbortController();
  #exitStatus: 130 | 143 | 129 | undefined;
  #finished = false;
  #closed = false;

  constructor(private readonly host: CommandCancellationHost = process) {
    host.on("SIGINT", this.#interrupt);
    host.on("SIGTERM", this.#terminate);
    host.on("SIGHUP", this.#hangup);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get exitStatus(): 130 | 143 | 129 | undefined {
    return this.#exitStatus;
  }

  readonly #interrupt = () => this.#abort("SIGINT", 130);
  readonly #terminate = () => this.#abort("SIGTERM", 143);
  readonly #hangup = () => this.#abort("SIGHUP", 129);

  #abort(
    signal: "SIGINT" | "SIGTERM" | "SIGHUP",
    status: 130 | 143 | 129,
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
    this.host.off("SIGHUP", this.#hangup);
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
