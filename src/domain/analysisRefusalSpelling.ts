import { AsyncLocalStorage } from "node:async_hooks";
import type { AnalysisCallerLifetime } from "./analysisErrorBase.js";

/**
 * How an adapter names what a generated refusal recovery asks the caller to
 * change. Recovery is rendered once, at projection, in the spelling of the
 * adapter that delivers it; no adapter rewrites the sentence afterwards.
 */
export interface AnalysisRefusalSpelling {
  /** The caller's lifetime, which selects a setting's route; else the projection's. */
  readonly callerLifetime?: AnalysisCallerLifetime;
  /** The adapter's name for `operation`'s per-call control `parameter`. */
  readonly control: (parameter: string, operation: string) => string;
  /** The next request to `operation` that accepts that control. */
  readonly call: (operation: string) => string;
}

/** MCP names a control by its contract field and the call by its tool. */
export const MCP_REFUSAL_SPELLING: AnalysisRefusalSpelling = {
  control: (parameter) => parameter,
  call: (operation) => `the next ${operation} call`,
};

const spellings = new AsyncLocalStorage<AnalysisRefusalSpelling>();

/** Render refusal recovery inside `run` in an adapter's spelling. */
export const runWithAnalysisRefusalSpelling = <Value>(
  spelling: AnalysisRefusalSpelling,
  run: () => Value,
): Value => spellings.run(spelling, run);

/** The spelling of the adapter delivering this async stack's output; MCP by default. */
export const currentAnalysisRefusalSpelling = (): AnalysisRefusalSpelling =>
  spellings.getStore() ?? MCP_REFUSAL_SPELLING;
