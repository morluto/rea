import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";

/** Preserve the caller's exact reason while setup unwinds its resource owners. */
export const assertSetupActive = (signal?: AbortSignal): void => {
  if (signal?.aborted)
    throw new AnalysisCancelledError("setup", { cause: signal.reason });
};
