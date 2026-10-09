import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";

const inventory = (format: "apk" | "ipa" | "directory", digit: string) => {
  const sha = digit.repeat(64);
  const artifactId = `art_${digestCanonicalValue({ sha256: sha }, "Artifact inventory")}`;
  const occurrenceId = `occ_${digestCanonicalValue(
    { root: artifactId },
    "Artifact inventory",
  )}`;
  const nodes = [
    {
      artifact_id: artifactId,
      format: format === "directory" ? "directory" : "zip",
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
      artifact_format: format,
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
    "Artifact inventory",
  );
  return jsonValueSchema.parse({
    manifest: {
      manifest_id: `agm_${digestCanonicalValue(
        {
          root_artifact_id: artifactId,
          graph_sha256: graphSha256,
        },
        "Artifact inventory",
      )}`,
      root_artifact_id: artifactId,
      root_sha256: sha,
      root_format: format,
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
  id: "rea-artifact-graph",
  name: "REA safe artifact graph provider",
  version: "1",
} as const;

/** Catalog example for Android application inventory projection. */
export const ANDROID_APPLICATION_GRAPH_EXAMPLE = {
  inventory_evidence: [
    createEvidence(
      { path: "Fixture.apk", sha256: "a".repeat(64), format: "apk" },
      provider,
      {
        operation: "inventory_artifact",
        parameters: {},
        result: inventory("apk", "a"),
        confidence: "observed",
        authority: "shipped-artifact",
      },
    ),
  ],
};

/** Catalog example for Apple application inventory projection. */
export const APPLE_APPLICATION_GRAPH_EXAMPLE = {
  inventory_evidence: [
    createEvidence(
      { path: "Fixture.ipa", sha256: "b".repeat(64), format: "ipa" },
      provider,
      {
        operation: "inventory_artifact",
        parameters: {},
        result: inventory("ipa", "b"),
        confidence: "observed",
        authority: "shipped-artifact",
      },
    ),
  ],
};

/** Catalog example for a macOS application bundle inventoried as a directory. */
export const MACOS_APPLICATION_GRAPH_EXAMPLE = {
  inventory_evidence: [
    createEvidence(
      { path: "Fixture.app", sha256: "c".repeat(64), format: "directory" },
      provider,
      {
        operation: "inventory_artifact",
        parameters: {},
        result: inventory("directory", "c"),
        confidence: "observed",
        authority: "shipped-artifact",
      },
    ),
  ],
};
