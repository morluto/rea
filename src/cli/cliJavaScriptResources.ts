import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";

/**
 * One parked JavaScript worker for one CLI host. A healthy worker stays
 * parked between that host's commands. Independent hosts do not share it.
 * This owner is separate from the analysis command so the executable can
 * close it without loading JavaScript analysis for commands that never used it.
 */
export class CliJavaScriptAnalysisHost {
  #retainedScope: ArtifactResourceScope | undefined;
  /** One shutdown shared by the exit callback and the dispatch `finally`. */
  #closing: Promise<void> | undefined;

  scope(): ArtifactResourceScope {
    this.#retainedScope ??= new ArtifactResourceScope();
    return this.#retainedScope;
  }

  /**
   * Stop this host's worker. Overlapping callers share the attempt in flight.
   * The scope stays owned when shutdown fails, so the next call retries.
   */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    const scope = this.#retainedScope;
    if (scope === undefined) return Promise.resolve();
    let published: Promise<void>;
    published = scope
      .close()
      .then(() => {
        if (this.#retainedScope === scope) this.#retainedScope = undefined;
      })
      .finally(() => {
        if (this.#closing === published) this.#closing = undefined;
      });
    this.#closing = published;
    return published;
  }
}

/** Process CLI host used when a caller does not pass its own host. */
export const processJavaScriptAnalysis = new CliJavaScriptAnalysisHost();

/** Stop the process-owned JavaScript worker. */
export const closeCliJavaScriptResources = (
  host: CliJavaScriptAnalysisHost = processJavaScriptAnalysis,
): Promise<void> => host.close();
