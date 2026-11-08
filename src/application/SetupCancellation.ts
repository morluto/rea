import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";

/** Preserve the caller's exact reason while setup unwinds its resource owners. */
export const assertSetupActive = (
  signal?: AbortSignal,
  failure?: string,
): void => {
  if (signal?.aborted)
    throw new AnalysisCancelledError("setup", {
      cause: signal.reason,
      ...(failure === undefined
        ? {}
        : { diagnostics: { setup_failure: failure } }),
    });
};
