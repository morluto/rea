import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import type { GhidraRequestOptions } from "./GhidraClientTypes.js";
import type {
  GhidraSessionError,
  GhidraSessionFailureKind,
} from "./GhidraSessionError.js";

/** Result settled by one queued Ghidra Program request. */
export type GhidraQueuedRequestResult = Result<JsonValue, GhidraSessionError>;
/** Socket execution seam used after a request reaches the queue head. */
export type GhidraRequestExecutor = (
  method: string,
  parameters: JsonValue,
  options: GhidraRequestOptions,
) => Promise<GhidraQueuedRequestResult>;
/** Bind queue failures to the owning client's live diagnostics. */
export type GhidraQueueFailureFactory = (
  kind: GhidraSessionFailureKind,
  message: string,
  cause?: unknown,
) => GhidraSessionError;

/** Stop the provider session when an admitted operation is cancelled. */
export type GhidraActiveCancellationHandler = () => Promise<void>;

interface QueuedRequest {
  readonly method: string;
  readonly parameters: JsonValue;
  readonly signal: AbortSignal | undefined;
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
    private readonly failure: GhidraQueueFailureFactory,
    private readonly onActiveCancellation: GhidraActiveCancellationHandler,
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
      return Promise.resolve(
        err(this.failure("cancelled", "Ghidra request was cancelled")),
      );
    return new Promise((resolve) => {
      let entry: QueuedRequest;
      const onAbort =
        options.signal === undefined
          ? undefined
          : () =>
              this.#rejectQueued(
                entry,
                err(this.failure("cancelled", "Ghidra request was cancelled")),
              );
      entry = {
        method,
        parameters,
        signal: options.signal,
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
    if (entry.signal?.aborted === true) {
      entry.resolve(
        err(this.failure("cancelled", "Ghidra request was cancelled")),
      );
      this.#drain();
      return;
    }
    this.#active = true;
    let executionSettled = false;
    let activeCancellation: Promise<void> | undefined;
    const onAbort =
      entry.signal === undefined
        ? undefined
        : () => {
            if (executionSettled) return;
            this.failQueued(
              this.failure(
                "process",
                "Ghidra session closed after active request cancellation",
              ),
            );
            activeCancellation = this.onActiveCancellation();
          };
    if (onAbort !== undefined)
      entry.signal?.addEventListener("abort", onAbort, { once: true });
    void this.execute(
      entry.method,
      entry.parameters,
      entry.signal === undefined ? {} : { signal: entry.signal },
    )
      .then(async (result) => {
        if (activeCancellation !== undefined) {
          try {
            await activeCancellation;
          } catch (cause: unknown) {
            result = err(
              this.failure(
                "process",
                cause instanceof Error
                  ? `Ghidra cleanup after cancellation failed: ${cause.message}`
                  : "Ghidra cleanup after cancellation failed",
                cause,
              ),
            );
          }
        }
        executionSettled = true;
        entry.resolve(result);
      })
      .catch(() => {
        executionSettled = true;
        entry.resolve(
          err(
            this.failure(
              "protocol",
              "Ghidra serial request execution rejected unexpectedly",
            ),
          ),
        );
      })
      .finally(() => {
        if (entry.signal !== undefined && onAbort !== undefined)
          entry.signal.removeEventListener("abort", onAbort);
        this.#active = false;
        if (this.#closedFailure === undefined) this.#drain();
      });
  }

  #rejectQueued(entry: QueuedRequest, result: GhidraQueuedRequestResult): void {
    const index = this.#queue.indexOf(entry);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#release(entry);
    entry.resolve(result);
  }

  #release(entry: QueuedRequest): void {
    if (entry.signal !== undefined && entry.onAbort !== undefined)
      entry.signal.removeEventListener("abort", entry.onAbort);
  }
}
