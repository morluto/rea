/** Result of an abort-aware interval wait. */
export type AbortableWaitResult = "elapsed" | "aborted";

/** Wait for an interval while removing the supplied abort listener on settle. */
export const waitForAbortableDelay = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<AbortableWaitResult> => {
  if (signal?.aborted === true) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const settle = (result: AbortableWaitResult): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => settle("aborted");
    const timer = setTimeout(
      () => settle("elapsed"),
      Math.max(0, milliseconds),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

/**
 * One absolute deadline shared by every phase of a provider startup handshake.
 *
 * The deadline owns its timer and the listener attached to an optional caller
 * signal. Adapters must dispose it after startup succeeds or fails.
 */
export class ProviderStartupDeadline {
  readonly #controller = new AbortController();
  readonly #deadlineAt: number;
  readonly #externalSignal: AbortSignal | undefined;
  readonly #onExternalAbort: () => void;
  #timer: NodeJS.Timeout | undefined;
  #interruption: "cancelled" | "timeout" | undefined;

  constructor(
    readonly timeoutMs: number,
    signal?: AbortSignal,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new RangeError("Provider startup timeout must be positive");
    this.#deadlineAt = Date.now() + timeoutMs;
    this.#externalSignal = signal;
    this.#onExternalAbort = () => {
      if (this.#controller.signal.aborted) return;
      if (Date.now() >= this.#deadlineAt) {
        this.#interruption = "timeout";
        this.#abort(
          new DOMException("Provider startup deadline elapsed", "TimeoutError"),
        );
        return;
      }
      this.#interruption = "cancelled";
      this.#abort(signal?.reason);
    };
    if (signal?.aborted === true) {
      this.#onExternalAbort();
      return;
    }
    signal?.addEventListener("abort", this.#onExternalAbort, { once: true });
    this.#timer = setTimeout(() => {
      if (this.#controller.signal.aborted) return;
      this.#interruption = "timeout";
      this.#abort(
        new DOMException("Provider startup deadline elapsed", "TimeoutError"),
      );
    }, timeoutMs);
  }

  /** Composite signal aborted by either the caller or the absolute deadline. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** First control path that interrupted startup, if any. */
  get interruption(): "cancelled" | "timeout" | undefined {
    return (
      this.#interruption ??
      (Date.now() >= this.#deadlineAt ? "timeout" : undefined)
    );
  }

  /** Milliseconds still available to the next startup phase. */
  remainingMs(): number {
    return Math.max(0, this.#deadlineAt - Date.now());
  }

  /** Wait for at most one polling interval under the shared deadline signal. */
  wait(milliseconds: number): Promise<AbortableWaitResult> {
    return waitForAbortableDelay(
      Math.min(milliseconds, this.remainingMs()),
      this.signal,
    );
  }

  /** Release the deadline timer and external abort listener. */
  dispose(): void {
    this.#clearTimer();
    this.#externalSignal?.removeEventListener("abort", this.#onExternalAbort);
  }

  #abort(reason: unknown): void {
    this.#clearTimer();
    this.#externalSignal?.removeEventListener("abort", this.#onExternalAbort);
    this.#controller.abort(reason);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
