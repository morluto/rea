import { performance } from "node:perf_hooks";

import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import type { GhidraRequestOptions } from "./GhidraClientTypes.js";
import type { GhidraSessionError } from "./GhidraSessionError.js";

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
  kind: "cancelled" | "timeout" | "protocol",
  message: string,
  timeoutMs?: number,
) => GhidraSessionError;

interface QueuedRequest {
  readonly method: string;
  readonly parameters: JsonValue;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly deadline: number;
  readonly resolve: (result: GhidraQueuedRequestResult) => void;
  readonly timer: NodeJS.Timeout;
  readonly onAbort: (() => void) | undefined;
}

/** Bounded FIFO that admits one Ghidra Program request at a time. */
export class GhidraRequestQueue {
  readonly #queue: QueuedRequest[] = [];
  #active = false;
  #size = 0;

  constructor(
    private readonly maximum: number,
    private readonly execute: GhidraRequestExecutor,
    private readonly failure: GhidraQueueFailureFactory,
  ) {}

  /** Queue one request, counting queue wait against its declared deadline. */
  run(
    method: string,
    parameters: JsonValue,
    options: GhidraRequestOptions & { readonly timeoutMs: number },
  ): Promise<GhidraQueuedRequestResult> {
    if (options.signal?.aborted === true)
      return Promise.resolve(
        err(this.failure("cancelled", "Ghidra request was cancelled")),
      );
    if (options.timeoutMs <= 0)
      return Promise.resolve(
        err(
          this.failure(
            "timeout",
            "Ghidra request deadline elapsed",
            options.timeoutMs,
          ),
        ),
      );
    if (this.#size >= this.maximum)
      return Promise.resolve(
        err(
          this.failure(
            "protocol",
            `Ghidra serial request queue reached its ${String(this.maximum)}-request limit`,
          ),
        ),
      );
    this.#size += 1;
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
      const timer = setTimeout(
        () =>
          this.#rejectQueued(
            entry,
            err(
              this.failure(
                "timeout",
                "Ghidra request deadline elapsed in the serial queue",
                options.timeoutMs,
              ),
            ),
          ),
        options.timeoutMs,
      );
      entry = {
        method,
        parameters,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        deadline: performance.now() + options.timeoutMs,
        resolve,
        timer,
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
    for (const entry of this.#queue.splice(0)) {
      this.#release(entry);
      this.#size -= 1;
      entry.resolve(err(failure));
    }
  }

  #drain(): void {
    if (this.#active) return;
    const entry = this.#queue.shift();
    if (entry === undefined) return;
    this.#release(entry);
    const remaining = entry.deadline - performance.now();
    if (entry.signal?.aborted === true || remaining <= 0) {
      this.#size -= 1;
      entry.resolve(
        err(
          entry.signal?.aborted === true
            ? this.failure("cancelled", "Ghidra request was cancelled")
            : this.failure(
                "timeout",
                "Ghidra request deadline elapsed in the serial queue",
                entry.timeoutMs,
              ),
        ),
      );
      this.#drain();
      return;
    }
    this.#active = true;
    void this.execute(entry.method, entry.parameters, {
      ...(entry.signal === undefined ? {} : { signal: entry.signal }),
      timeoutMs: remaining,
    })
      .then(entry.resolve)
      .catch(() =>
        entry.resolve(
          err(
            this.failure(
              "protocol",
              "Ghidra serial request execution rejected unexpectedly",
            ),
          ),
        ),
      )
      .finally(() => {
        this.#active = false;
        this.#size -= 1;
        this.#drain();
      });
  }

  #rejectQueued(entry: QueuedRequest, result: GhidraQueuedRequestResult): void {
    const index = this.#queue.indexOf(entry);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#release(entry);
    this.#size -= 1;
    entry.resolve(result);
  }

  #release(entry: QueuedRequest): void {
    clearTimeout(entry.timer);
    if (entry.signal !== undefined && entry.onAbort !== undefined)
      entry.signal.removeEventListener("abort", entry.onAbort);
  }
}
