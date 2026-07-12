import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";

const inventory = (digit: string) => {
  const sha = digit.repeat(64);
  const artifactId = `art_${sha}`;
  const occurrenceId = `occ_${sha}`;
  return jsonValueSchema.parse({
    manifest: {
      schema_version: 1,
      manifest_id: `agm_${sha}`,
      root_artifact_id: artifactId,
      root_sha256: sha,
      root_format: "file",
      graph_sha256: sha,
      node_count: 1,
      occurrence_count: 1,
      edge_count: 0,
    },
    nodes: {
      items: [
        {
          artifact_id: artifactId,
          kind: "resource",
          format: "file",
          sha256: sha,
          size: 1,
          media_type: null,
          architecture: null,
          executable: false,
          content_state: "materialized",
          limitations: [],
        },
      ],
      offset: 0,
      limit: 100,
      total: 1,
      next_offset: null,
    },
    occurrences: {
      items: [
        {
          occurrence_id: occurrenceId,
          artifact_id: artifactId,
          parent_occurrence_id: null,
          logical_path: ".",
          entry_kind: "file",
          declared_size: 1,
          compressed_size: null,
          executable: false,
          encrypted: false,
          hash_status: "verified",
          source_location: null,
          limitations: [],
        },
      ],
      offset: 0,
      limit: 100,
      total: 1,
      next_offset: null,
    },
    edges: { items: [], offset: 0, limit: 100, total: 0, next_offset: null },
    limits: {
      max_entries: 100,
      max_total_bytes: 1024,
      max_entry_bytes: 1024,
      max_compression_ratio: 10,
      max_depth: 10,
      max_path_bytes: 256,
    },
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
  left: createEvidence(undefined, provider, {
    operation: "inventory_artifact",
    parameters: {},
    result: inventory("0"),
    confidence: "observed",
    authority: "shipped-artifact",
  }),
  right: createEvidence(undefined, provider, {
    operation: "inventory_artifact",
    parameters: {},
    result: inventory("1"),
    confidence: "observed",
    authority: "shipped-artifact",
  }),
} as const;
