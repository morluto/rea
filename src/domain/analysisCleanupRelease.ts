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

  /**
   * Let a failure reported by another producer read this release only when
   * its cleanup has no owner of its own; an owned failure keeps reading that
   * owner, so a later release of its resources is not hidden behind this one.
   */
  bindUnowned<T extends AnalysisError>(error: T): T {
    return error.cleanupIncomplete && !error.hasCleanupOwner
      ? this.bind(error)
      : error;
  }

  confirm(): void {
    this.#released = true;
  }
}
