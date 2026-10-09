import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";

const inventory = (digit: string) => {
  const sha = digit.repeat(64);
  const artifactId = `art_${digestCanonicalValue({ sha256: sha }, "Artifact example")}`;
  const occurrenceId = `occ_${digestCanonicalValue({ root: artifactId }, "Artifact example")}`;
  const nodes = [
    {
      artifact_id: artifactId,
      format: "file",
      sha256: sha,
      size: 1,
      media_type: null,
      architecture: null,
      content_state: "materialized",
      limitations: [],
    },
  ];
  const occurrences = [
    {
      occurrence_id: occurrenceId,
      artifact_id: artifactId,
      parent_occurrence_id: null,
      logical_path: ".",
      entry_kind: "file",
      artifact_kind: "resource",
      artifact_format: "file",
      declared_size: 1,
      compressed_size: null,
      executable: false,
      encrypted: false,
      hash_status: "verified",
      source_location: null,
      limitations: [],
    },
  ];
  const graphSha256 = digestCanonicalValue(
    {
      nodes,
      occurrences,
      edges: [],
      integrity_contradictions: [],
    },
    "Artifact example",
  );
  return jsonValueSchema.parse({
    manifest: {
      manifest_id: `agm_${digestCanonicalValue(
        {
          root_artifact_id: artifactId,
          graph_sha256: graphSha256,
        },
        "Artifact example",
      )}`,
      root_artifact_id: artifactId,
      root_sha256: sha,
      root_format: "file",
      graph_sha256: graphSha256,
      node_count: nodes.length,
      occurrence_count: occurrences.length,
      edge_count: 0,
    },
    nodes,
    occurrences,
    edges: [],
    provenance: [],
    limitations: [],
  });
};

const provider = {
  id: "rea-artifact",
  name: "REA artifact graph",
  version: "1",
} as const;

/** Canonical complete inputs used to advertise artifact comparison. */
export const ARTIFACT_COMPARISON_EXAMPLE = {
  left: createEvidence(
    { path: "fixture-left", sha256: "0".repeat(64), format: "file" },
    provider,
    {
      operation: "inventory_artifact",
      parameters: {},
      result: inventory("0"),
      confidence: "observed",
      authority: "shipped-artifact",
    },
  ),
  right: createEvidence(
    { path: "fixture-right", sha256: "1".repeat(64), format: "file" },
    provider,
    {
      operation: "inventory_artifact",
      parameters: {},
      result: inventory("1"),
      confidence: "observed",
      authority: "shipped-artifact",
    },
  ),
} as const;
