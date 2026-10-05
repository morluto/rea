import type {
  ArtifactInventoryResult,
  ArtifactNode,
  IntegrityContradiction,
} from "../../domain/artifactGraph.js";

/** Resolved integrity behavior admitted to the artifact scanner. */
export type ArtifactIntegrityPolicy =
  | { readonly mode: "fail" }
  | { readonly mode: "record-and-continue" };

export const STRICT_INTEGRITY_POLICY: ArtifactIntegrityPolicy = {
  mode: "fail",
};

/** Options shared by artifact inventory scans. */
export interface ArtifactInventoryOptions {
  readonly signal?: AbortSignal | undefined;
  readonly integrity?: ArtifactIntegrityPolicy | undefined;
}

/** Immutable inventory produced by one complete artifact scan. */
export interface ArtifactInventorySnapshot {
  readonly manifest: ArtifactInventoryResult["manifest"];
  readonly nodes: readonly ArtifactNode[];
  readonly occurrences: ArtifactInventoryResult["occurrences"];
  readonly edges: ArtifactInventoryResult["edges"];
  readonly provenance: ReadonlyArray<
    ArtifactInventoryResult["provenance"][number]
  >;
  readonly integrity_contradictions: readonly IntegrityContradiction[];
  readonly limitations: readonly string[];
}
