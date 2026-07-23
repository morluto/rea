import { performance } from "node:perf_hooks";

import type { ProgressReporter } from "../application/ProgressReporter.js";
import {
  HopperCancelledError,
  type HopperError,
  HopperProcessError,
  HopperProtocolError,
  HopperTimeoutError,
} from "../domain/errors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";

export type HopperRequestResult = Result<JsonValue, HopperError>;

export interface HopperRequestQueueOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly progress?: ProgressReporter;
}

export interface HopperRequestActivity {
  readonly requestId: number;
  readonly operation: string;
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly callerState: "waiting" | "timed_out" | "cancelled";
  readonly queuedRequests: number;
}

type RequestSender = (
  request: {
    readonly id: number;
    readonly method: string;
    readonly params: JsonValue;
  },
  failed: () => void,
) => void;

interface QueuedRequest {
  readonly id: number;
  readonly method: string;
  readonly params: JsonValue;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly deadline: number;
  readonly progress: ProgressReporter | undefined;
  readonly resolve: (result: HopperRequestResult) => void;
  readonly timer: NodeJS.Timeout;
  readonly onAbort: (() => void) | undefined;
  callerState: "waiting" | "timed_out" | "cancelled";
  callerSettled: boolean;
  startedAt: number | undefined;
  heartbeat: NodeJS.Timeout | undefined;
}

/** Bounded FIFO that keeps the wire serialized until Hopper actually replies. */
export class HopperRequestQueue {
  readonly #queue: QueuedRequest[] = [];
  #active: QueuedRequest | undefined;

  constructor(
    private readonly maximum: number,
    private readonly send: RequestSender,
  ) {}

  /** Queue one request, counting queue wait against its caller deadline. */
  run(
    id: number,
    method: string,
    params: JsonValue,
    options: HopperRequestQueueOptions,
  ): Promise<HopperRequestResult> {
    if (options.signal?.aborted === true)
      return Promise.resolve(err(new HopperCancelledError()));
    if (options.timeoutMs <= 0)
      return Promise.resolve(err(new HopperTimeoutError(options.timeoutMs)));
    if (this.#size() >= this.maximum)
      return Promise.resolve(
        err(
          new HopperProtocolError(
            `Hopper serial request queue reached its ${String(this.maximum)}-request limit`,
          ),
        ),
      );
    return new Promise((resolve) => {
      let entry: QueuedRequest;
      const onAbort =
        options.signal === undefined ? undefined : () => this.#cancel(entry);
      const timer = setTimeout(() => this.#timeout(entry), options.timeoutMs);
      entry = {
        id,
        method,
        params,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        deadline: performance.now() + options.timeoutMs,
        progress: options.progress,
        resolve,
        timer,
        onAbort,
        callerState: "waiting",
        callerSettled: false,
        startedAt: undefined,
        heartbeat: undefined,
      };
      this.#queue.push(entry);
      if (onAbort !== undefined)
        options.signal?.addEventListener("abort", onAbort, { once: true });
      if (this.#active !== undefined || this.#queue.length > 1)
        this.#report(
          entry,
          `${method} queued behind ${String(this.#size() - 1)} Hopper request(s)`,
        );
      this.#drain();
    });
  }

  /** Settle the active wire request. False identifies an unexpected response id. */
  accept(id: number, result: HopperRequestResult): boolean {
    const entry = this.#active;
    if (entry === undefined || entry.id !== id) return false;
    this.#releaseWire(entry);
    if (!entry.callerSettled) this.#settleCaller(entry, result, "waiting");
    this.#active = undefined;
    this.#drain();
    return true;
  }

  /** Fail the active wire request and every request still waiting in the FIFO. */
  failAll(error: HopperError): void {
    const active = this.#active;
    this.#active = undefined;
    if (active !== undefined) {
      this.#releaseWire(active);
      if (!active.callerSettled)
        this.#settleCaller(active, err(error), "waiting");
    }
    for (const entry of this.#queue.splice(0))
      this.#settleCaller(entry, err(error), "waiting");
  }

  /** Snapshot the one request still occupying Hopper's serial Python thread. */
  activity(): HopperRequestActivity | null {
    const active = this.#active;
    if (active === undefined || active.startedAt === undefined) return null;
    return {
      requestId: active.id,
      operation: active.method,
      elapsedMs: Math.max(0, Math.round(performance.now() - active.startedAt)),
      timeoutMs: active.timeoutMs,
      callerState: active.callerState,
      queuedRequests: this.#queue.length,
    };
  }

  /** Return whether an id belongs to a request that has not crossed the wire. */
  hasQueued(id: number): boolean {
    return this.#queue.some((entry) => entry.id === id);
  }

  /** Number of caller requests waiting behind the active bridge operation. */
  queuedCount(): number {
    return this.#queue.length;
  }

  #size(): number {
    return this.#queue.length + (this.#active === undefined ? 0 : 1);
  }

  #drain(): void {
    if (this.#active !== undefined) return;
    const entry = this.#queue.shift();
    if (entry === undefined) return;
    const remaining = entry.deadline - performance.now();
    if (entry.signal?.aborted === true || remaining <= 0) {
      this.#settleCaller(
        entry,
        entry.signal?.aborted === true
          ? err(new HopperCancelledError())
          : err(new HopperTimeoutError(entry.timeoutMs)),
        entry.signal?.aborted === true ? "cancelled" : "timed_out",
      );
      this.#drain();
      return;
    }
    this.#active = entry;
    entry.startedAt = performance.now();
    this.#report(entry, `${entry.method} started on Hopper's serial bridge`);
    entry.heartbeat = setInterval(() => {
      if (entry.callerSettled || entry.startedAt === undefined) return;
      const elapsed = Math.round(performance.now() - entry.startedAt);
      this.#report(
        entry,
        `${entry.method} is still running in Hopper (${String(elapsed)} ms elapsed)`,
      );
    }, 1_000);
    try {
      this.send(
        { id: entry.id, method: entry.method, params: entry.params },
        () => this.accept(entry.id, err(new HopperProcessError(null))),
      );
    } catch (cause: unknown) {
      this.accept(
        entry.id,
        err(new HopperProtocolError("Hopper socket write failed", { cause })),
      );
    }
  }

  #timeout(entry: QueuedRequest): void {
    if (entry.callerSettled) return;
    if (this.#active === entry) {
      this.#settleCaller(
        entry,
        err(new HopperTimeoutError(entry.timeoutMs)),
        "timed_out",
      );
      return;
    }
    const index = this.#queue.indexOf(entry);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#settleCaller(
      entry,
      err(new HopperTimeoutError(entry.timeoutMs)),
      "timed_out",
    );
  }

  #cancel(entry: QueuedRequest): void {
    if (entry.callerSettled) return;
    if (this.#active === entry) {
      this.#settleCaller(entry, err(new HopperCancelledError()), "cancelled");
      return;
    }
    const index = this.#queue.indexOf(entry);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#settleCaller(entry, err(new HopperCancelledError()), "cancelled");
  }

  #settleCaller(
    entry: QueuedRequest,
    result: HopperRequestResult,
    callerState: QueuedRequest["callerState"],
  ): void {
    if (entry.callerSettled) return;
    entry.callerSettled = true;
    entry.callerState = callerState;
    if (this.#active === entry && entry.heartbeat !== undefined) {
      clearInterval(entry.heartbeat);
      entry.heartbeat = undefined;
    }
    clearTimeout(entry.timer);
    if (entry.signal !== undefined && entry.onAbort !== undefined)
      entry.signal.removeEventListener("abort", entry.onAbort);
    entry.resolve(result);
  }

  #releaseWire(entry: QueuedRequest): void {
    if (entry.heartbeat !== undefined) clearInterval(entry.heartbeat);
    entry.heartbeat = undefined;
    clearTimeout(entry.timer);
    if (entry.signal !== undefined && entry.onAbort !== undefined)
      entry.signal.removeEventListener("abort", entry.onAbort);
  }

  #report(entry: QueuedRequest, message: string): void {
    void entry.progress
      ?.report({
        phase: "hopper_request",
        completed: 0,
        total: 1,
        message,
      })
      .catch(() => undefined);
  }
}
