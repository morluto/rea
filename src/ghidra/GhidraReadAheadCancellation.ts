/**
 * Read-ahead outlives the request that queued it. The signal on that request
 * still owns the workers after the reply, including while the caller commits
 * files, journals, or reads the next function. Aborting it abandons them.
 * A later request on a different signal is a different workflow and must not
 * be abandoned by the previous signal.
 */
export class GhidraReadAheadCancellation {
  #signal: AbortSignal | undefined;
  #onAbort: (() => void) | undefined;
  #sending = false;

  constructor(private readonly abandon: () => Promise<void>) {}

  /**
   * A Program request is about to run. The same signal keeps its watch; a
   * different signal replaces the workflow, so the previous abort no longer
   * applies.
   */
  noteRequest(signal: AbortSignal | undefined): void {
    if (signal === undefined || signal === this.#signal) return;
    this.#drop();
  }

  /** The latest read-ahead request has settled under `signal`. */
  watch(signal: AbortSignal | undefined): void {
    if (signal === undefined) return;
    if (signal === this.#signal && this.#onAbort !== undefined) {
      if (signal.aborted) this.#onAbort();
      return;
    }
    this.#drop();
    const onAbort = (): void => {
      this.#drop();
      this.#send();
    };
    this.#signal = signal;
    this.#onAbort = onAbort;
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  /** The session can no longer accept a bridge request. */
  stop(): void {
    this.#drop();
  }

  #drop(): void {
    if (this.#signal !== undefined && this.#onAbort !== undefined)
      this.#signal.removeEventListener("abort", this.#onAbort);
    this.#signal = undefined;
    this.#onAbort = undefined;
  }

  #send(): void {
    if (this.#sending) return;
    this.#sending = true;
    void this.abandon().finally(() => {
      this.#sending = false;
    });
  }
}
