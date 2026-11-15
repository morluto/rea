import type {
  AnalysisCleanupReleaseClaim,
  AnalysisError,
} from "./analysisErrorBase.js";

/**
 * Release recorded by an owner that retries its cleanup in place instead of
 * through one `close()`. Errors bound to it read the release when asked; it is
 * never pushed to them. Start a new one for each unreleased cleanup.
 */
export class AnalysisCleanupRelease implements AnalysisCleanupReleaseClaim {
  #released = false;

  get cleanupReleased(): boolean {
    return this.#released;
  }

  /** Let `error` report this owner's release whenever it is asked. */
  bind<T extends AnalysisError>(error: T): T {
    return error.bindCleanupReleaseClaim(this);
  }

  confirm(): void {
    this.#released = true;
  }
}
