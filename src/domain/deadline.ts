import { MAX_NODE_TIMER_DELAY_MS } from "./analysisResourceLimits.js";

const validBudget = (name: string, milliseconds: number): number => {
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > MAX_NODE_TIMER_DELAY_MS
  )
    throw new RangeError(
      `${name} must be a finite millisecond count from 0 to ${String(MAX_NODE_TIMER_DELAY_MS)}`,
    );
  return milliseconds;
};

/**
 * One monotonic deadline with a work budget and a separate finalize budget.
 *
 * The work budget starts when the deadline is created. The finalize budget
 * starts when finalization begins, so work that used its whole budget, or
 * overran it, still gets a bounded window to drain output, record evidence and
 * release what it owns. Wall-clock changes never move either budget.
 */
export class Deadline {
  readonly #endsAt: number;

  private constructor(
    /** Work budget in milliseconds. */
    readonly workMs: number,
    /** Budget a finalizer gets once work stops, in milliseconds. */
    readonly finalizeMs: number,
  ) {
    this.#endsAt = performance.now() + workMs;
  }

  /** A deadline whose work budget starts now. Omitting `finalizeMs` grants none. */
  static after(
    workMs: number,
    options: { readonly finalizeMs?: number } = {},
  ): Deadline {
    return new Deadline(
      validBudget("Deadline work budget", workMs),
      validBudget("Deadline finalize budget", options.finalizeMs ?? 0),
    );
  }

  /** Whole milliseconds of work budget left; zero once it has elapsed. */
  remainingMs(): number {
    return Math.max(0, Math.ceil(this.#endsAt - performance.now()));
  }

  /** Whether the work budget has elapsed. */
  expired(): boolean {
    return performance.now() >= this.#endsAt;
  }

  /**
   * Start the finalize budget now, whether or not work expired. The result
   * is the deadline finalization runs under; it grants no further budget.
   */
  beginFinalize(): Deadline {
    return new Deadline(this.finalizeMs, 0);
  }
}
