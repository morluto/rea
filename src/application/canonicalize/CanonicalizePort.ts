import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  CanonicalizeArtifactInput,
  CanonicalizeArtifact,
} from "../../domain/canonicalize/canonicalizeArtifact.js";
import type { Result } from "../../domain/result.js";

/** Stable read and deterministic, execution-free canonicalization of one artifact. */
export interface CanonicalizePort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  canonicalize(
    input: CanonicalizeArtifactInput,
    options?: ExecutionOptions,
  ): Promise<Result<CanonicalizeArtifact, AnalysisError>>;
}
