/**
 * Read-ahead outlives the request that queued it. The signal on that request
 * still owns the workers after the reply, including while the caller commits
 * files, journals, or reads the next function. Aborting it abandons them.
 * Only a later request that carries its own read-ahead replaces that owner.
 * Another request on a different signal leaves the watch in place.
 */
export class GhidraReadAheadCancellation {
  #signal: AbortSignal | undefined;
  #onAbort: (() => void) | undefined;
  #sending = false;

  constructor(private readonly abandon: () => Promise<void>) {}

  /**
   * A request that carries read-ahead is about to run. The same signal keeps
   * its watch. A different signal becomes the owner, because the bridge has
   * one worker pool and disposing it would stop the new window. A request
   * that does not carry read-ahead must not call this.
   */
  takeOwnership(signal: AbortSignal | undefined): void {
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
