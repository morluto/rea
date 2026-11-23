import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { cancelledBy, carriedReason } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";

/** A queued single-function request found the export finished first. */
export const KUNA_EXPORT_READY = Symbol("kuna-export-ready");

export type KunaSingleFunctionOutcome =
  | Result<string, AnalysisError>
  | typeof KUNA_EXPORT_READY;

/** One single-function run that every request for its address shares. */
interface SingleFunctionRun {
  readonly outcome: Promise<KunaSingleFunctionOutcome>;
  /** Stops the run once every waiter has left. */
  readonly controller: AbortController;
  waiters: number;
}

/**
 * Completed single-function texts a session keeps while it has no export
 * reader. Each repeat would otherwise analyze the whole image again; after a
 * failed export that holds for the rest of the session.
 */
const SINGLE_FUNCTION_TEXT_CACHE_BYTES = 16 * 1024 * 1024;
/** Charged per kept text beside its UTF-8 bytes. */
const SINGLE_FUNCTION_TEXT_ENTRY_BYTES = 256;

interface SingleFunctionText {
  readonly text: string;
  readonly bytes: number;
}

/**
 * Coalesces concurrent single-function Kuna decompile requests by address and
 * caches completed texts in a bounded LRU until the project export supersedes them.
 */
export class KunaSingleFunctionCache {
  readonly #runs = new Map<string, SingleFunctionRun>();
  readonly #texts = new Map<string, SingleFunctionText>();
  #textBytes = 0;

  constructor(
    private readonly sessionSignal: AbortSignal,
    private readonly canKeep: () => boolean,
    private readonly own: <T>(work: Promise<T>) => Promise<T>,
    private readonly classifyFailure: (
      operation: string,
      cause: unknown,
    ) => AnalysisError,
  ) {}

  /**
   * Join an in-flight single-function run or return a cached text. A cancelled
   * caller leaves immediately when others still wait, or aborts the run when it
   * was the last waiter.
   */
  join(
    operation: string,
    address: string,
    signal: AbortSignal | undefined,
    start: (runSignal: AbortSignal) => Promise<KunaSingleFunctionOutcome>,
  ): Promise<KunaSingleFunctionOutcome> {
    if (signal?.aborted)
      return Promise.resolve(err(cancelledBy(operation, signal)));
    const kept = this.#texts.get(address);
    if (kept !== undefined) {
      this.#texts.delete(address);
      this.#texts.set(address, kept);
      return Promise.resolve(ok(kept.text));
    }
    let run = this.#runs.get(address);
    if (run === undefined) {
      const controller = new AbortController();
      const created: SingleFunctionRun = {
        controller,
        waiters: 0,
        outcome: this.own(
          start(AbortSignal.any([this.sessionSignal, controller.signal])).catch(
            (cause: unknown) => err(this.classifyFailure(operation, cause)),
          ),
        ),
      };
      this.#runs.set(address, created);
      void created.outcome.then((outcome) => {
        // A run whose waiters all left was already replaced or removed.
        if (this.#runs.get(address) !== created) return;
        this.#runs.delete(address);
        if (outcome !== KUNA_EXPORT_READY && outcome.ok)
          this.#keep(address, outcome.value);
      });
      run = created;
    }
    const shared = run;
    shared.waiters += 1;
    return new Promise((resolve) => {
      let waiting = true;
      const leave = () => {
        waiting = false;
        shared.waiters -= 1;
      };
      const onAbort = () => {
        if (!waiting) return;
        leave();
        if (shared.waiters > 0) {
          resolve(err(cancelledBy(operation, carriedReason(signal?.reason))));
          return;
        }
        // A run whose waiters all left winds down; a new request starts afresh.
        if (this.#runs.get(address) === shared) this.#runs.delete(address);
        shared.controller.abort(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void shared.outcome.then((outcome) => {
        signal?.removeEventListener("abort", onAbort);
        if (waiting) leave();
        resolve(outcome);
      });
    });
  }

  /** Drop all cached single-function texts (e.g. when project export or close supersedes them). */
  clear(): void {
    this.#texts.clear();
    this.#textBytes = 0;
  }

  /** Keep a completed text within budget, dropping the least recently used. */
  #keep(address: string, text: string): void {
    if (!this.canKeep()) return;
    const bytes = Buffer.byteLength(text) + SINGLE_FUNCTION_TEXT_ENTRY_BYTES;
    if (bytes > SINGLE_FUNCTION_TEXT_CACHE_BYTES) return;
    this.#texts.set(address, { text, bytes });
    this.#textBytes += bytes;
    while (this.#textBytes > SINGLE_FUNCTION_TEXT_CACHE_BYTES) {
      const oldest = this.#texts.entries().next().value;
      if (oldest === undefined) break;
      this.#texts.delete(oldest[0]);
      this.#textBytes -= oldest[1].bytes;
    }
  }
}
