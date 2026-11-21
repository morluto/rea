import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectOciImageLayoutInput,
  OciImageLayout,
} from "../../domain/oci/imageLayout.js";
import type { Result } from "../../domain/result.js";

/** Stable directory read of an OCI image layout, independent of a registry. */
export interface OciImageLayoutPort {
  readonly identity: ProviderIdentity;
  close(): Promise<void>;
  inspect(
    input: InspectOciImageLayoutInput,
    options?: ExecutionOptions,
  ): Promise<Result<OciImageLayout, AnalysisError>>;
}
