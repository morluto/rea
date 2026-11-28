import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  DebPackage,
  InspectDebPackageInput,
} from "../../domain/deb/debPackage.js";
import type { Result } from "../../domain/result.js";

/** Stable read and .deb ar/tar decoding, independent of dpkg or an analysis target. */
export interface DebPackagePort {
  readonly identity: ProviderIdentity;
  close(): Promise<void>;
  inspect(
    input: InspectDebPackageInput,
    options?: ExecutionOptions,
  ): Promise<Result<DebPackage, AnalysisError>>;
}
