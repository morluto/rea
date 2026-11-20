import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  InspectMavenGradleMetadataInput,
  MavenGradleMetadata,
} from "../../domain/java/mavenGradleMetadata.js";

/** Stable read and POM/module decoding, independent of Maven or Gradle. */
export interface MavenGradleMetadataPort {
  readonly identity: ProviderIdentity;
  close(): Promise<void>;
  inspect(
    input: InspectMavenGradleMetadataInput,
    options?: ExecutionOptions,
  ): Promise<Result<MavenGradleMetadata, AnalysisError>>;
}
