/**
 * Read-ahead outlives the request that queued it. The signal on that request
 * still owns the workers after the reply, including while the caller commits
 * files, journals, or reads the next function. Aborting it abandons them.
 * Only a later request that carries its own read-ahead replaces that owner.
 * Another request on a different signal leaves the watch in place.
 */
export class GhidraReadAheadCancellation {
  #generation = 0;
  /** `null` is a window admitted with no signal. `undefined` means none yet. */
  #owner: AbortSignal | null | undefined;
  #signal: AbortSignal | undefined;
  #onAbort: (() => void) | undefined;
  #sendingGeneration: number | undefined;

  constructor(
    private readonly abandon: (generation: number) => Promise<void>,
  ) {}

  /**
   * The carrying read-ahead request has been admitted. `signal` becomes the
   * owner, including when it is absent: a window with no signal still
   * replaces the previous owner so that owner's abort cannot dispose it.
   * A later `watch` from an older request cannot take the owner back.
   * Call this only once the request is admitted. A request rejected while
   * queued must not call it.
   */
  takeOwnership(signal: AbortSignal | undefined): void {
    this.#generation += 1;
    this.#owner = signal ?? null;
    this.#drop();
  }

  /** Whether an abandon queued for `generation` still owns the workers. */
  owns(generation: number | undefined): boolean {
    return generation !== undefined && generation === this.#generation;
  }

  /**
   * The read-ahead request for `signal` has settled. Arms that signal only
   * when it is still the owner. The queue can already have accepted a newer
   * read-ahead before this request's `finally` runs.
   */
  watch(signal: AbortSignal | undefined): void {
    if (signal === undefined || this.#owner !== signal) return;
    if (signal === this.#signal && this.#onAbort !== undefined) {
      if (signal.aborted) this.#onAbort();
      return;
    }
    this.#drop();
    const generation = this.#generation;
    const onAbort = (): void => {
      this.#drop();
      this.#send(generation);
    };
    this.#signal = signal;
    this.#onAbort = onAbort;
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  /** The session can no longer accept a bridge request. */
  stop(): void {
    this.#owner = undefined;
    this.#drop();
  }

  #drop(): void {
    if (this.#signal !== undefined && this.#onAbort !== undefined)
      this.#signal.removeEventListener("abort", this.#onAbort);
    this.#signal = undefined;
    this.#onAbort = undefined;
  }

  #send(generation: number): void {
    if (this.#sendingGeneration === generation) return;
    this.#sendingGeneration = generation;
    void this.abandon(generation).finally(() => {
      if (this.#sendingGeneration === generation)
        this.#sendingGeneration = undefined;
    });
  }
}
