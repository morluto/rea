import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { err, type Result } from "../../domain/result.js";
import { ABORTED, waitForAbortable } from "../../process/AbortablePromise.js";

/**
 * One build computer's calls, each run alone in the order it arrived, so a
 * witness stage is admitted, read and filed with no action or other step in
 * between. Closing cancels the call running and refuses those waiting.
 */
export class DesktopBuildTurns {
  #tail: Promise<void> = Promise.resolve();
  readonly #closing = new AbortController();

  /** Run `work` once every call before it has ended; its signal also aborts when the computer closes. */
  async run<Value>(
    operation: string,
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<Result<Value, AnalysisError>>,
  ): Promise<Result<Value, AnalysisError>> {
    const turn = AbortSignal.any([signal, this.#closing.signal]);
    const { previous, release } = this.#enqueue();
    if ((await waitForAbortable(previous, turn)) === ABORTED || turn.aborted) {
      // A call that never ran keeps its place until the one before it ends, so the next still waits for that one.
      void previous.then(release);
      return err(new AnalysisCancelledError(operation, { cause: turn.reason }));
    }
    try {
      return await work(turn);
    } finally {
      release();
    }
  }

  /** Cancel the call running and those waiting, then run `work` once the running one has ended. */
  async close<Value>(work: () => Promise<Value>): Promise<Value> {
    this.#closing.abort(new Error("The build computer was closed."));
    const { previous, release } = this.#enqueue();
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  /** Take the next place: the end of the call before it, and the release of this one. */
  #enqueue(): {
    readonly previous: Promise<void>;
    readonly release: () => void;
  } {
    const previous = this.#tail;
    let release = (): void => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { previous, release };
  }
}
