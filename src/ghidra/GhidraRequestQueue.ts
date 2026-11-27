import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import {
  ghidraCancelGraceFacts,
  type GhidraCancelGrace,
} from "../config/ghidraCancelGrace.js";
import type { GhidraRequestOptions } from "./GhidraClientTypes.js";
import {
  GhidraSessionError,
  isGhidraRemoteCancellation,
  type GhidraSessionFailureFactory,
} from "./GhidraSessionError.js";

/** Result settled by one queued Ghidra Program request. */
type GhidraQueuedRequestResult = Result<JsonValue, GhidraSessionError>;
/** Socket execution seam used after a request reaches the queue head. */
type GhidraRequestExecutor = (
  method: string,
  parameters: JsonValue,
  options: GhidraRequestOptions,
) => Promise<GhidraQueuedRequestResult>;
/** Stop the provider session when an admitted operation is cancelled. */
type GhidraActiveCancellationHandler = () => Promise<
  Result<null, AnalysisError>
>;
/**
 * Which active requests are first asked to stop, and for how long. Edits are
 * never asked to stop: a reply racing the cancel could leave a committed
 * change behind a cancelled call.
 */
interface GhidraRequestInterruption {
  readonly interruptible: (method: string) => boolean;
  readonly grace: GhidraCancelGrace;
}

interface QueuedRequest {
  readonly method: string;
  readonly parameters: JsonValue;
  readonly options: GhidraRequestOptions;
  readonly resolve: (result: GhidraQueuedRequestResult) => void;
  readonly onAbort: (() => void) | undefined;
}

/** FIFO that admits one Ghidra Program request at a time. */
export class GhidraRequestQueue {
  readonly #queue: QueuedRequest[] = [];
  #active = false;
  #closedFailure: GhidraSessionError | undefined;

  constructor(
    private readonly execute: GhidraRequestExecutor,
    private readonly failure: GhidraSessionFailureFactory,
    private readonly onActiveCancellation: GhidraActiveCancellationHandler,
    private readonly interruption?: GhidraRequestInterruption,
  ) {}

  /** Queue one request until it completes, is cancelled, or the session closes. */
  run(
    method: string,
    parameters: JsonValue,
    options: GhidraRequestOptions,
  ): Promise<GhidraQueuedRequestResult> {
    if (this.#closedFailure !== undefined)
      return Promise.resolve(err(this.#closedFailure));
    if (options.signal?.aborted === true)
      return Promise.resolve(err(this.#cancelled(options.signal)));
    return new Promise((resolve) => {
      let entry: QueuedRequest;
      const onAbort =
        options.signal === undefined
          ? undefined
          : () =>
              this.#rejectQueued(entry, err(this.#cancelled(options.signal)));
      entry = {
        method,
        parameters,
        options,
        resolve,
        onAbort,
      };
      this.#queue.push(entry);
      if (onAbort !== undefined)
        options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#drain();
    });
  }

  /** Fail requests that have not crossed the socket during session cleanup. */
  failQueued(failure: GhidraSessionError): void {
    this.#closedFailure = failure;
    for (const entry of this.#queue.splice(0)) {
      this.#release(entry);
      entry.resolve(err(failure));
    }
  }

  /** Admit requests after the owning client completes a new session startup. */
  reopen(): void {
    this.#closedFailure = undefined;
  }

  #drain(): void {
    if (this.#active) return;
    const entry = this.#queue.shift();
    if (entry === undefined) return;
    this.#release(entry);
    if (entry.options.signal?.aborted === true) {
      entry.resolve(err(this.#cancelled(entry.options.signal)));
      this.#drain();
      return;
    }
    this.#active = true;
    void this.#executeEntry(entry)
      .then(entry.resolve)
      .finally(() => {
        this.#active = false;
        if (this.#closedFailure === undefined) this.#drain();
      });
  }

  async #executeEntry(
    entry: QueuedRequest,
  ): Promise<GhidraQueuedRequestResult> {
    const signal = entry.options.signal;
    // An interruptible request is first asked to stop: `interrupt` writes the
    // cancel, and the wire keeps waiting for the reply until `abandon` fires.
    const interruption =
      signal !== undefined &&
      this.interruption?.interruptible(entry.method) === true
        ? {
            grace: this.interruption.grace,
            interrupt: new AbortController(),
            abandon: new AbortController(),
          }
        : undefined;
    let grace: NodeJS.Timeout | undefined;
    let cancellation:
      | {
          readonly failure: GhidraSessionError;
          readonly cleanup: Promise<
            | {
                readonly kind: "returned";
                readonly value: Result<null, AnalysisError>;
              }
            | { readonly kind: "rejected"; readonly cause: unknown }
          >;
        }
      | undefined;
    const closeSession = (graceExpired = false): void => {
      if (cancellation !== undefined) return;
      this.failQueued(
        this.failure(
          "process",
          graceExpired && interruption !== undefined
            ? `Ghidra session closed after active request cancellation: Ghidra did not answer the cancelled request within the cancel grace (${ghidraCancelGraceFacts(interruption.grace)}; set in the environment that starts REA)`
            : "Ghidra session closed after active request cancellation",
        ),
      );
      cancellation = {
        failure: this.#cancelled(signal),
        // Capture rejection immediately, including a synchronous callback throw.
        // Execution and finalization may settle in either order.
        cleanup: Promise.resolve()
          .then(() => this.onActiveCancellation())
          .then(
            (value) => ({ kind: "returned", value }),
            (cause: unknown) => ({ kind: "rejected", cause }),
          ),
      };
      interruption?.abandon.abort(signal?.reason);
    };
    const onAbort = (): void => {
      if (interruption === undefined) {
        closeSession();
        return;
      }
      interruption.interrupt.abort(signal?.reason);
      grace = setTimeout(() => {
        closeSession(true);
      }, interruption.grace.graceMs);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let result: GhidraQueuedRequestResult;
      try {
        result = await this.execute(
          entry.method,
          entry.parameters,
          interruption === undefined
            ? entry.options
            : {
                ...entry.options,
                signal: interruption.abandon.signal,
                interrupt: interruption.interrupt.signal,
              },
        );
      } catch (cause: unknown) {
        result = err(
          cause instanceof GhidraSessionError
            ? cause
            : this.failure(
                "protocol",
                "Ghidra serial request execution rejected unexpectedly",
                cause,
              ),
        );
      }
      if (
        interruption !== undefined &&
        cancellation === undefined &&
        signal?.aborted === true
      ) {
        // A bridge reply shows the handler finished this request, so the
        // session and the requests queued behind it stay. A reply that raced
        // the cancel is still a cancelled call; an unrelated failure stays
        // primary.
        if (result.ok || isGhidraRemoteCancellation(result.error))
          return err(this.#cancelled(signal));
        if (result.error.kind === "remote") return result;
        // No reply was observed, so nothing shows the bridge stopped.
        closeSession();
      }
      if (cancellation === undefined) return result;
      // An observed bridge reply stays primary, but it must carry the session
      // close so its projection does not promise that the session is usable.
      const primary = result.ok
        ? cancellation.failure
        : result.error.kind === "remote"
          ? result.error.withConcurrentCancellation({
              reason: signal?.reason,
            })
          : result.error;
      const cleanup = await cancellation.cleanup;
      if (cleanup.kind === "rejected")
        return err(
          this.#withUnexpectedCleanupRejection(primary, cleanup.cause),
        );
      return err(
        cleanup.value.ok
          ? primary
          : primary.withCleanupFailure(cleanup.value.error),
      );
    } finally {
      clearTimeout(grace);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #cancelled(signal: AbortSignal | undefined): GhidraSessionError {
    return this.failure(
      "cancelled",
      "Ghidra request was cancelled",
      signal?.reason,
      signal === undefined ? {} : { cancellation: { reason: signal.reason } },
    );
  }

  #rejectQueued(entry: QueuedRequest, result: GhidraQueuedRequestResult): void {
    const index = this.#queue.indexOf(entry);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#release(entry);
    entry.resolve(result);
  }

  #withUnexpectedCleanupRejection(
    primary: GhidraSessionError,
    cause: unknown,
  ): GhidraSessionError {
    const described = this.failure(primary.kind, primary.message, cause);
    const rejection = described.diagnostics.failure_cause;
    const cleanupFailure = new ProviderCleanupError(
      "ghidra",
      ["Ghidra cancellation cleanup"],
      {
        reason: "Cancellation cleanup rejected before release was confirmed",
        unexpected_cleanup_rejection: rejection ?? { type: typeof cause },
      },
      { cause },
    );
    return primary.withCleanupFailure(cleanupFailure, {
      ...primary.diagnostics,
      unexpected_cleanup_rejection: rejection ?? { type: typeof cause },
    });
  }

  #release(entry: QueuedRequest): void {
    if (entry.options.signal !== undefined && entry.onAbort !== undefined)
      entry.options.signal.removeEventListener("abort", entry.onAbort);
  }
}
