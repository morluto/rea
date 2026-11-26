import type { AnalysisError } from "../domain/analysisErrorBase.js";

export class QueuedProviderClose {
  #requested = false;
  #attempt: Promise<void> | undefined;

  /** Admission stays closed even when cleanup needs another attempt. */
  get requested(): boolean {
    return this.#requested;
  }

  closeAfter(
    tail: Promise<void>,
    cleanup: () => Promise<AnalysisError | undefined>,
  ): Promise<void> {
    this.#requested = true;
    this.#attempt ??= tail
      .then(async () => {
        const failure = await cleanup();
        if (failure !== undefined) throw failure;
      })
      .catch((cause: unknown) => {
        this.#attempt = undefined;
        throw cause;
      });
    return this.#attempt;
  }
}
