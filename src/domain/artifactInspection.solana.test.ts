import { expect, it } from "vitest";
import {
  artifactGraphDigest,
  artifactIdForContent,
  artifactManifestId,
  occurrenceIdForLocation,
} from "./artifactIdentity.js";
import type { ArtifactNode, ArtifactOccurrence } from "./artifactGraph.js";
import { createArtifactInspection } from "./artifactInspection.js";
import { createEvidence } from "./evidence.js";
import { jsonValueSchema } from "./jsonValue.js";

/** A complete one-file inventory whose root is an ELF image. */
const elfInventoryEvidence = () => {
  const sha = "a".repeat(64);
  const artifactId = artifactIdForContent(sha);
  const nodes: ArtifactNode[] = [
    {
      artifact_id: artifactId,
      format: "elf",
      sha256: sha,
      size: 4096,
      media_type: null,
      architecture: null,
      content_state: "materialized",
      limitations: [],
    },
  ];
  const occurrences: ArtifactOccurrence[] = [
    {
      occurrence_id: occurrenceIdForLocation({
        rootArtifactId: artifactId,
        logicalPath: ".",
        entryKind: "file",
      }),
      artifact_id: artifactId,
      parent_occurrence_id: null,
      relationship_coverage: "complete",
      logical_path: ".",
      entry_kind: "file",
      artifact_kind: "executable",
      artifact_format: "elf",
      declared_size: 4096,
      compressed_size: null,
      executable: true,
      encrypted: false,
      hash_status: "verified",
      source_location: null,
      limitations: [],
    },
  ];
  const graphSha256 = artifactGraphDigest({
    nodes,
    occurrences,
    edges: [],
    contradictions: [],
  });
  const result = jsonValueSchema.parse({
    manifest: {
      manifest_id: artifactManifestId(artifactId, graphSha256),
      root_artifact_id: artifactId,
      root_sha256: sha,
      root_format: "elf",
      graph_sha256: graphSha256,
      node_count: nodes.length,
      occurrence_count: occurrences.length,
      edge_count: 0,
    },
    nodes,
    occurrences,
    edges: [],
    provenance: [],
    integrity_contradictions: [],
    coverage: { scope: "root", status: "complete" },
    limitations: [],
  });
  return createEvidence(
    { path: "program.so", sha256: sha, format: "elf" },
    { id: "rea-artifact", name: "REA artifact graph", version: "1" },
    {
      operation: "inventory_artifact",
      parameters: {},
      result,
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
};

it("routes an sBPF root image to the dedicated Solana analyzer", () => {
  const inspection = createArtifactInspection(elfInventoryEvidence(), {
    format: "elf",
    machine: 263,
  });
  expect(inspection.next_probes).toEqual([
    {
      operation: "analyze_solana_program",
      rationale:
        "The ELF header names machine 263 (EM_BPF): a Solana sBPF program. The dedicated analyzer decodes its dispatch, syscalls and strings execution-free; the native ELF readers do not read sBPF.",
      authority: "artifact-bytes",
    },
  ]);
});

it("keeps the generic ELF readers for a native machine", () => {
  const inspection = createArtifactInspection(elfInventoryEvidence(), {
    format: "elf",
    machine: 62,
  });
  const operations = inspection.next_probes.map((probe) => probe.operation);
  expect(operations).toContain("inspect_elf_dependencies");
  expect(operations).not.toContain("analyze_solana_program");
});
