import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
} from "../../src/domain/artifactGraph.js";
import {
  artifactGraphDigest,
  artifactManifestId,
} from "../../src/domain/artifactIdentity.js";
import {
  createEvidence,
  evidenceSubjectInput,
  type Evidence,
} from "../../src/domain/evidence.js";

export const occurrenceAt = (evidence: Evidence, path: string) => {
  const found = artifactInventoryResultSchema
    .parse(evidence.normalized_result)
    .occurrences.find(({ logical_path }) => logical_path === path);
  if (found === undefined) throw new Error(`Missing ${path}`);
  return found;
};

/** Recommit altered inventory occurrences as a historically recorded observation. */
export const historicalInventoryEvidence = (
  source: Evidence,
  alter: (
    occurrence: ArtifactInventoryResult["occurrences"][number],
  ) => ArtifactInventoryResult["occurrences"][number],
  confidence: "observed" | "derived" = "derived",
): Evidence => {
  const inventory = artifactInventoryResultSchema.parse(
    source.normalized_result,
  );
  const occurrences = inventory.occurrences.map(alter);
  const graphSha256 = artifactGraphDigest({
    nodes: inventory.nodes,
    occurrences,
    edges: inventory.edges,
    contradictions: inventory.integrity_contradictions,
  });
  return createEvidence(evidenceSubjectInput(source.subject), source.provider, {
    operation: "inventory_artifact",
    parameters: {},
    result: {
      ...inventory,
      occurrences,
      manifest: {
        ...inventory.manifest,
        graph_sha256: graphSha256,
        manifest_id: artifactManifestId(
          inventory.manifest.root_artifact_id,
          graphSha256,
        ),
      },
    },
    confidence,
    authority: "shipped-artifact",
  });
};

/** Partition a real scan into authenticated partial observations for merge tests. */
export const fragmentInventoryEvidence = (
  evidence: Evidence,
  count: number,
): readonly Evidence[] => {
  const inventory = artifactInventoryResultSchema.parse(
    evidence.normalized_result,
  );
  const subject = evidence.subject;
  return Array.from({ length: count }, (_, index) =>
    createEvidence(evidenceSubjectInput(subject), evidence.provider, {
      operation: "inventory_artifact",
      parameters: evidence.parameters,
      confidence: "derived",
      authority: evidence.authority,
      result: {
        ...inventory,
        nodes: inventory.nodes.filter(
          (_, ordinal) => ordinal % count === index,
        ),
        occurrences: inventory.occurrences.filter(
          (_, ordinal) => ordinal % count === index,
        ),
        edges: inventory.edges.filter(
          (_, ordinal) => ordinal % count === index,
        ),
      },
    }),
  );
};
