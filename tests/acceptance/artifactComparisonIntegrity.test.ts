import { expect, it } from "vitest";
import { ARTIFACT_COMPARISON_EXAMPLE } from "../../src/contracts/artifactComparisonExample.js";
import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import {
  artifactContradictionId,
  artifactGraphDigest,
  artifactManifestId,
  occurrenceIdForLocation,
} from "../../src/domain/artifactIdentity.js";
import { createEvidence } from "../../src/domain/evidence.js";
import { connectArtifactComparisonMcp } from "../fixtures/artifactComparisonMcp.js";

const duplicateInventory = (mismatched: boolean) => {
  // Recommit a synthetic imported inventory; this does not claim that a real archive produced these members.
  const inventory = artifactInventoryResultSchema.parse(
    ARTIFACT_COMPARISON_EXAMPLE.left.normalized_result,
  );
  const root = inventory.occurrences[0];
  if (root === undefined) throw new Error("Missing root");
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    inventory.occurrences.push({
      ...root,
      occurrence_id: occurrenceIdForLocation({
        rootArtifactId: inventory.manifest.root_artifact_id,
        logicalPath: "duplicate",
        entryKind: "file",
        ...(ordinal === 0 ? {} : { duplicateOrdinal: ordinal }),
      }),
      parent_occurrence_id: root.occurrence_id,
      logical_path: "duplicate",
      hash_status: ordinal === 1 && mismatched ? "mismatched" : "verified",
      ...(ordinal === 1 && mismatched
        ? {
            declared_integrity: {
              algorithm: "sha256" as const,
              digest: "f".repeat(64),
            },
          }
        : {}),
    });
  }
  if (mismatched) {
    const occurrence = inventory.occurrences[2];
    if (occurrence === undefined) throw new Error("Missing duplicate");
    const integrity = {
      declared_sha256: "f".repeat(64),
      observed_sha256: inventory.manifest.root_sha256,
    };
    inventory.integrity_contradictions.push({
      contradiction_id: artifactContradictionId({
        rootArtifactId: inventory.manifest.root_artifact_id,
        logicalPath: occurrence.logical_path,
        integrity,
      }),
      occurrence_id: occurrence.occurrence_id,
      parent_artifact_id: inventory.manifest.root_artifact_id,
      logical_path: occurrence.logical_path,
      ...integrity,
      entry_kind: "file",
      unpacked: false,
      trust: "observed-untrusted",
      provenance: "container-integrity-metadata-versus-observed-bytes",
      limitations: ["Observed bytes contradict declared integrity metadata."],
    });
  }
  inventory.manifest.occurrence_count = inventory.occurrences.length;
  inventory.coverage = { scope: "container-entries", status: "complete" };
  inventory.manifest.graph_sha256 = artifactGraphDigest({
    nodes: inventory.nodes,
    occurrences: inventory.occurrences,
    edges: inventory.edges,
    contradictions: inventory.integrity_contradictions,
  });
  inventory.manifest.manifest_id = artifactManifestId(
    inventory.manifest.root_artifact_id,
    inventory.manifest.graph_sha256,
  );
  return createEvidence(
    {
      path: "synthetic",
      sha256: inventory.manifest.root_sha256,
      format: inventory.manifest.root_format,
    },
    ARTIFACT_COMPARISON_EXAMPLE.left.provider,
    {
      operation: "inventory_artifact",
      parameters: {},
      result: inventory,
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
};

it("retains an integrity contradiction when duplicate paths cannot be paired", async () => {
  const mismatch = duplicateInventory(true);
  const clean = duplicateInventory(false);
  const { compare } = await connectArtifactComparisonMcp();
  for (const [left, right] of [
    [mismatch, clean],
    [clean, mismatch],
  ] as const) {
    expect(await compare(left, right)).toMatchObject({
      status: "contradiction",
      integrity_mismatch_evidence_ids: [mismatch.evidence_id],
      changes: [
        {
          logical_path: "duplicate",
          classification: "contradiction",
          dimensions: ["availability", "integrity"],
        },
      ],
      limitations: expect.arrayContaining([
        expect.stringContaining("Duplicate logical paths"),
      ]),
    });
  }
  expect(await compare(clean, clean)).toMatchObject({
    status: "unknown",
    changes: [
      {
        logical_path: "duplicate",
        classification: "unknown",
        dimensions: ["availability"],
      },
    ],
  });
});
