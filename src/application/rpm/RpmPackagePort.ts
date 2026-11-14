import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectRpmPackageInput,
  RpmPackage,
} from "../../domain/rpm/package.js";
import type { Result } from "../../domain/result.js";

/** Stable read and RPM header decoding, independent of rpm/dnf install or payload unpack. */
export interface RpmPackagePort {
  readonly identity: ProviderIdentity;
  close(): Promise<void>;
  inspect(
    input: InspectRpmPackageInput,
    options?: ExecutionOptions,
  ): Promise<Result<RpmPackage, AnalysisError>>;
}
