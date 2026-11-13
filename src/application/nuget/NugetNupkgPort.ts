import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectNugetNupkgInput,
  NugetNupkg,
} from "../../domain/nuget/nupkg.js";
import type { Result } from "../../domain/result.js";

/** Stable read and .nupkg ZIP/.nuspec decoding, independent of restore or a feed. */
export interface NugetNupkgPort {
  readonly identity: ProviderIdentity;
  close(): Promise<void>;
  inspect(
    input: InspectNugetNupkgInput,
    options?: ExecutionOptions,
  ): Promise<Result<NugetNupkg, AnalysisError>>;
}
