import { canonicalDigest } from "./comparisonSemantics.js";
import type {
  ArtifactEdge,
  ArtifactNode,
  ArtifactOccurrence,
  IntegrityContradiction,
} from "./artifactGraph.js";

/** Content-address an artifact independently of where it was observed. */
export const artifactIdForContent = (sha256: string): string =>
  `art_${canonicalDigest({ sha256 }, "Artifact")}`;

/** Identify an occurrence by its root and exact logical location. */
export const occurrenceIdForLocation = (input: {
  readonly rootArtifactId: string;
  readonly logicalPath: string;
  readonly entryKind: ArtifactOccurrence["entry_kind"];
}): string =>
  input.logicalPath === "."
    ? `occ_${canonicalDigest({ root: input.rootArtifactId }, "Artifact")}`
    : `occ_${canonicalDigest(
        {
          root_artifact_id: input.rootArtifactId,
          logical_path: input.logicalPath,
          entry_kind: input.entryKind,
        },
        "Artifact",
      )}`;

/** Commit to graph members in the ordering established by the inventory owner. */
export const artifactGraphDigest = (input: {
  readonly nodes: readonly ArtifactNode[];
  readonly occurrences: readonly ArtifactOccurrence[];
  readonly edges: readonly ArtifactEdge[];
  readonly contradictions: readonly IntegrityContradiction[];
}): string =>
  canonicalDigest(
    {
      nodes: input.nodes,
      occurrences: input.occurrences,
      edges: input.edges,
      integrity_contradictions: input.contradictions,
    },
    "Artifact",
  );

/** Bind a root artifact to its graph commitment. */
export const artifactManifestId = (
  rootArtifactId: string,
  graphSha256: string,
): string =>
  `agm_${canonicalDigest(
    { root_artifact_id: rootArtifactId, graph_sha256: graphSha256 },
    "Artifact",
  )}`;

/** Identify one integrity disagreement at its observed logical path. */
export const artifactContradictionId = (input: {
  readonly rootArtifactId: string;
  readonly logicalPath: string;
  readonly declaredSha256: string;
  readonly observedSha256: string;
}): string =>
  `ic_${canonicalDigest(
    {
      root_artifact_id: input.rootArtifactId,
      logical_path: input.logicalPath,
      declared_sha256: input.declaredSha256,
      observed_sha256: input.observedSha256,
    },
    "Artifact",
  )}`;

/** Identify an edge by its semantic relationship and exact occurrence. */
export const artifactEdgeId = (
  semantic: Pick<
    ArtifactEdge,
    | "parent_artifact_id"
    | "child_artifact_id"
    | "relation"
    | "occurrence_id"
    | "logical_path"
  >,
): string => `edge_${canonicalDigest(semantic, "Artifact")}`;
