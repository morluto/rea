import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { err, type Result } from "../../domain/result.js";
import type { ProviderProcessSupervisor } from "../../process/ProviderProcess.js";

/** Work in progress REA must stop and await when it closes its build computers. */
interface Pending {
  readonly settled: Promise<unknown>;
  readonly stop: AbortController;
}

/** A helper process whose cleanup failed, kept so closing can retry it. */
type RetainedOwner = Pick<ProviderProcessSupervisor, "stop" | "dispose">;

/** Long work the build tools own, such as a computer's start or a measure's solves, which closing stops and awaits. */
export class DesktopBuildOwnedWork {
  readonly resources = new ArtifactResourceScope();
  readonly #pending = new Set<Pending>();
  readonly #retained = new Set<RetainedOwner>();
  #closed = false;

  /** Run work that closing stops, refused once closing has begun. */
  async run<Value>(
    operation: string,
    signal: AbortSignal,
    work: (stopping: AbortSignal) => Promise<Result<Value, AnalysisError>>,
  ): Promise<Result<Value, AnalysisError>> {
    if (this.#closed)
      return err(
        new AnalysisCancelledError(operation, {
          cause: new Error("REA is closing its build computers"),
        }),
      );
    const stop = new AbortController();
    const settled = work(AbortSignal.any([signal, stop.signal]));
    const pending = { settled, stop };
    this.#pending.add(pending);
    try {
      return await settled;
    } finally {
      this.#pending.delete(pending);
    }
  }

  /** Keep a helper whose cleanup could not be confirmed, for closing to retry. */
  retain(owner: RetainedOwner): void {
    this.#retained.add(owner);
  }

  /** Refuse new work, stop what runs and wait for it, then retry kept cleanups; an error for each still failing. */
  async close(): Promise<Error[]> {
    this.#closed = true;
    const pending = [...this.#pending];
    for (const work of pending)
      work.stop.abort(new Error("REA is closing its build computers"));
    await Promise.allSettled(pending.map((work) => work.settled));
    const failures: Error[] = [];
    try {
      await this.resources.retryCleanup();
    } catch (cause) {
      failures.push(cause instanceof Error ? cause : new Error(String(cause)));
    }
    for (const owner of this.#retained) {
      const stopped = await owner.stop();
      if (stopped.status === "incomplete") {
        failures.push(new Error(stopped.reason));
        continue;
      }
      owner.dispose();
      this.#retained.delete(owner);
    }
    return failures;
  }
}
