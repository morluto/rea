import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectVsixPackageInput,
  VsixPackage,
} from "../../domain/vsix/vsixPackage.js";
import type { Result } from "../../domain/result.js";

/** Stable read and .vsix ZIP/manifest decoding, independent of install or a marketplace. */
export interface VsixPackagePort {
  readonly identity: ProviderIdentity;
  close(): Promise<void>;
  inspect(
    input: InspectVsixPackageInput,
    options?: ExecutionOptions,
  ): Promise<Result<VsixPackage, AnalysisError>>;
}
