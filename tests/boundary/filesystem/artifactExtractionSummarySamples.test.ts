import { expect, it } from "vitest";

import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { createEvidence } from "../../../src/domain/evidence.js";

const digest = (character: string) => character.repeat(64);

/** An extraction whose cleanup left `count` long residual paths behind. */
const extraction = (count: number) =>
  artifactExtractionResultSchema.parse({
    manifest: {
      manifest_id: `agm_${digest("1")}`,
      root_artifact_id: `art_${digest("2")}`,
      root_sha256: digest("3"),
      root_format: "zip",
      graph_sha256: digest("4"),
      node_count: 1,
      occurrence_count: 1,
      edge_count: 0,
    },
    extraction_manifest: {
      extraction_id: `aex_${digest("5")}`,
      source_manifest_id: `agm_${digest("1")}`,
      selected_occurrence_ids: [],
      files_sha256: digest("6"),
      output_root_alias: "$OUTPUT_ROOT",
    },
    output_root: "/output",
    artifacts: [],
    containment_verified: true,
    cleanup: {
      attempted: true,
      verified: false,
      residual_paths: Array.from(
        { length: count },
        (_, index) => `${"d".repeat(1000)}/${String(index)}`,
      ),
    },
    coverage: { scope: "container-entries", status: "complete" },
    provenance: [],
    integrity_contradictions: [],
    limitations: [],
  });

const parent = createEvidence(
  { path: "/inputs/app.zip", sha256: digest("3"), format: "zip" },
  { id: "rea-artifacts", name: "REA artifacts", version: "1" },
  {
    operation: "extract_artifact",
    parameters: { output_root: "/output" },
    result: extraction(16),
  },
);

it("bounds each summary sample by bytes and pages the rest", async () => {
  const summary = await inspectAnalysisView({
    source: { kind: "inline", evidence: parent },
    view: { kind: "summary" },
  });
  if (!summary.ok) throw summary.error;
  // Each path is about 1 KB, so four fit the 4096-byte sample.
  expect(summary.value.normalized_result).toMatchObject({
    summary: {
      cleanup: {
        verified: false,
        residual_paths: { items: expect.any(Array), omitted: 12 },
      },
    },
  });
  const paged = await inspectAnalysisView({
    source: { kind: "inline", evidence: parent },
    view: {
      kind: "artifact-extraction",
      collection: "residual_paths",
      limit: 64,
    },
  });
  if (!paged.ok) throw paged.error;
  expect(paged.value.normalized_result).toMatchObject({
    coverage: { total: 16, exhausted: true },
  });
});
