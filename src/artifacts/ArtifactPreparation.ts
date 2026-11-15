import { artifactReadCancelledBy } from "./ArtifactFileOperation.js";

/** Share one preparation while allowing another caller to retry its cancellation. */
export class ArtifactPreparation {
  #pending:
    | {
        readonly signal: AbortSignal | undefined;
        readonly promise: Promise<void>;
      }
    | undefined;

  async run(
    signal: AbortSignal | undefined,
    prepare: () => Promise<void>,
    assertOpen: () => void,
  ): Promise<void> {
    for (;;) {
      const pending = (this.#pending ??= { signal, promise: prepare() });
      try {
        await pending.promise;
        return;
      } catch (cause: unknown) {
        if (this.#pending === pending) this.#pending = undefined;
        if (
          pending.signal !== signal &&
          signal?.aborted !== true &&
          artifactReadCancelledBy(cause, pending.signal)
        ) {
          assertOpen();
          continue;
        }
        throw cause;
      }
    }
  }

  clear(): void {
    this.#pending = undefined;
  }
}
