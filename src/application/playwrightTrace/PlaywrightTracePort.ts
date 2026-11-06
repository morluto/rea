import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type { PlaywrightTrace } from "../../domain/playwrightTrace/playwrightTrace.js";

/** Producer parsing and archive ownership stay with the offline format adapter. */
export interface PlaywrightTracePort {
  inspect(
    path: string,
    signal?: AbortSignal,
  ): Promise<Result<PlaywrightTrace, AnalysisError>>;
}
