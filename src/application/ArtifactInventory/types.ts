import type {
  ArtifactInventoryResult,
  ArtifactNode,
  IntegrityContradiction,
} from "../../domain/artifactGraph.js";

export interface InventoryPageInput {
  readonly nodeOffset: number;
  readonly nodeLimit: number;
  readonly occurrenceOffset: number;
  readonly occurrenceLimit: number;
  readonly edgeOffset: number;
  readonly edgeLimit: number;
}

/** Resolved native mount authority admitted to the artifact reader. */
export type ArtifactNativeMountPolicy =
  | { readonly status: "disabled" }
  | { readonly status: "approved" };

export const NATIVE_MOUNT_DISABLED: ArtifactNativeMountPolicy = {
  status: "disabled",
};

/** Resolved integrity behavior admitted to the artifact scanner. */
export type ArtifactIntegrityPolicy =
  | { readonly mode: "fail" }
  | {
      readonly mode: "record-and-continue";
      readonly maxMismatches: number;
    };

export const STRICT_INTEGRITY_POLICY: ArtifactIntegrityPolicy = {
  mode: "fail",
};

/** Options shared by artifact inventory scans. */
export interface ArtifactInventoryOptions {
  readonly signal?: AbortSignal | undefined;
  readonly nativeMount?: ArtifactNativeMountPolicy | undefined;
  readonly integrity?: ArtifactIntegrityPolicy | undefined;
}

/** Immutable inventory produced by one complete artifact scan. */
export interface ArtifactInventorySnapshot {
  readonly manifest: ArtifactInventoryResult["manifest"];
  readonly nodes: readonly ArtifactNode[];
  readonly occurrences: ArtifactInventoryResult["occurrences"]["items"];
  readonly edges: ArtifactInventoryResult["edges"]["items"];
  readonly limits: ArtifactInventoryResult["limits"];
  readonly provenance: ReadonlyArray<
    ArtifactInventoryResult["provenance"][number]
  >;
  readonly integrity_contradictions: readonly IntegrityContradiction[];
  readonly limitations: readonly string[];
}
