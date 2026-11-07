import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { err, type Result } from "../../domain/result.js";

/** Work in progress REA must stop and await when it closes its build computers. */
interface Pending {
  readonly settled: Promise<unknown>;
  readonly stop: AbortController;
}

/** Long work the build tools own, such as a computer's start or a measure's solves, which closing stops and awaits. */
export class DesktopBuildOwnedWork {
  readonly #pending = new Set<Pending>();
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

  /** Refuse new work, stop what runs and wait for it to settle. */
  async close(): Promise<void> {
    this.#closed = true;
    const pending = [...this.#pending];
    for (const work of pending)
      work.stop.abort(new Error("REA is closing its build computers"));
    await Promise.allSettled(pending.map((work) => work.settled));
  }
}
