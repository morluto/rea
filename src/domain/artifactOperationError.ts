import { AnalysisError } from "./analysisErrorBase.js";

/** Artifact inventory or extraction failed a typed safety boundary. */
export class ArtifactOperationError extends AnalysisError {
  readonly _tag = "ArtifactOperationError";

  constructor(
    readonly operation:
      | "inventory_artifact"
      | "inspect_artifact"
      | "extract_artifact"
      | "decode_interface_builder"
      | "inspect_asset_catalog"
      | "inspect_keyed_archive"
      | "analyze_javascript_application",
    readonly reason:
      | "cancelled"
      | "format"
      | "integrity"
      | "limit"
      | "path"
      | "unavailable"
      | "io",
    readonly artifactDetails?: Readonly<{
      logicalPath: string;
      declaredSha256: string | null;
      calculatedSha256: string | null;
      unpacked: boolean;
    }>,
  ) {
    super(
      artifactDetails === undefined
        ? `Artifact ${operation} failed: ${reason}`
        : `Artifact ${operation} failed: ${reason} at ${artifactDetails.logicalPath} (declared_sha256=${artifactDetails.declaredSha256 ?? "unavailable"}, calculated_sha256=${artifactDetails.calculatedSha256 ?? "unavailable"}, unpacked=${String(artifactDetails.unpacked)})`,
    );
  }
}
