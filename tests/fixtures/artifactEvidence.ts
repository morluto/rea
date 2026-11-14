import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
} from "../../src/domain/artifactGraph.js";
import {
  artifactGraphDigest,
  artifactManifestId,
} from "../../src/domain/artifactIdentity.js";
import { createEvidence, type Evidence } from "../../src/domain/evidence.js";

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
  if (source.subject === null)
    throw new TypeError("Inventory has no artifact subject");
  const occurrences = inventory.occurrences.map(alter);
  const graphSha256 = artifactGraphDigest({
    nodes: inventory.nodes,
    occurrences,
    edges: inventory.edges,
    contradictions: inventory.integrity_contradictions,
  });
  return createEvidence(
    {
      path: source.subject.local_path,
      sha256: inventory.manifest.root_sha256,
      format: inventory.manifest.root_format,
    },
    source.provider,
    {
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
    },
  );
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
  if (subject === null)
    throw new TypeError("Inventory has no artifact subject");
  return Array.from({ length: count }, (_, index) =>
    createEvidence(
      {
        path: subject.local_path,
        sha256: subject.digest.sha256,
        format: subject.format,
      },
      evidence.provider,
      {
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
      },
    ),
  );
};
