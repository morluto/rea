import {
  AnalysisCancelledError,
  CallerAbort,
} from "../domain/analysisErrorCore.js";

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
    // Windows delivers Ctrl+Break as SIGBREAK; registering it is harmless
    // elsewhere, where the signal is never raised. It is the one console
    // signal a Windows wrapper can send a child in its own process group,
    // so it must reach the same abort-and-cleanup path as SIGINT/SIGTERM.
    host.on("SIGBREAK", this.#break);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get exitStatus(): 130 | 143 | 149 | undefined {
    return this.#exitStatus;
  }

  readonly #interrupt = () => this.#abort("SIGINT", 130);
  readonly #terminate = () => this.#abort("SIGTERM", 143);
  readonly #break = () => this.#abort("SIGBREAK", 149);

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
    this.host.off("SIGBREAK", this.#break);
    this.finish();
  }
}

// Only this cancellation owner can attest a process disposition for a
// command outcome; the final exit decision reads it instead of inferring a
// status from ambient process state.
const cancellationStatuses = new WeakMap<object, 130 | 143 | 149>();

const attestCancellationStatus = (
  outcome: unknown,
  status: 130 | 143 | 149 | undefined,
): void => {
  if (status !== undefined && typeof outcome === "object" && outcome !== null)
    cancellationStatuses.set(outcome, status);
};

/** Read the cancellation disposition attested for a command outcome or cause. */
export const commandCancellationStatus = (
  outcome: unknown,
): 130 | 143 | 149 | undefined => {
  if (typeof outcome !== "object" || outcome === null) return undefined;
  const attested = cancellationStatuses.get(outcome);
  if (attested !== undefined) return attested;
  const reason =
    outcome instanceof AnalysisCancelledError ? outcome.cause : outcome;
  if (reason instanceof CallerAbort)
    return reason.kind === "interrupt"
      ? 130
      : reason.kind === "terminate"
        ? 143
        : reason.kind === "break"
          ? 149
          : undefined;
  return undefined;
};

/** Translate one-shot CLI interrupts into awaited cleanup and conventional exit codes. */
export const withCommandCancellation = async <Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  host: CommandCancellationHost = process,
): Promise<Value> => {
  const scope = new CommandCancellationScope(host);
  try {
    const value = await operation(scope.signal);
    attestCancellationStatus(value, scope.exitStatus);
    return value;
  } catch (cause: unknown) {
    attestCancellationStatus(cause, scope.exitStatus);
    throw cause;
  } finally {
    scope.close();
  }
};
