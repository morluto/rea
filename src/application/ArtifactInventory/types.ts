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

/** Per-request authority combined with operator-owned native mount policy. */
export interface ArtifactNativeMountPolicy {
  readonly nativeMountApproved: boolean;
  readonly nativeMountEnabled: boolean;
}

export const NATIVE_MOUNT_DISABLED: ArtifactNativeMountPolicy = {
  nativeMountApproved: false,
  nativeMountEnabled: false,
};

/** Explicit caller approval bounded by operator-owned integrity policy. */
export interface ArtifactIntegrityPolicy {
  readonly mode: "fail" | "record-and-continue";
  readonly approved: boolean;
  readonly enabled: boolean;
  readonly maxMismatches: number;
}

export const STRICT_INTEGRITY_POLICY: ArtifactIntegrityPolicy = {
  mode: "fail",
  approved: false,
  enabled: false,
  maxMismatches: 1,
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
