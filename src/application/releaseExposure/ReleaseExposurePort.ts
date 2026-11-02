import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { RELEASE_EXPOSURE_PROVIDER } from "../../domain/investigationProviders.js";
import type { ReleaseExposureScan } from "../../domain/releaseExposure.js";
import type { Result } from "../../domain/result.js";

/** Receives each text member the reader admits. `location` names that member. */
export type ReleaseExposureTextVisitor = (
  text: string,
  location: string,
) => void;

/** Bounded, read-only view of one shipped artifact. */
export interface ReleaseExposurePort {
  readonly identity: typeof RELEASE_EXPOSURE_PROVIDER;
  inspect(
    input: { readonly path: string; readonly max_file_bytes?: number },
    options: ExecutionOptions | undefined,
    visitText: ReleaseExposureTextVisitor,
  ): Promise<Result<ReleaseExposureScan, AnalysisError>>;
  close(): Promise<void>;
}
