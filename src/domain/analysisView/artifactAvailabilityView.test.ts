import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import type { ErlangBeam } from "../erlang/beam.js";
import type { ModelArtifact } from "../model/modelArtifact.js";
import { projectAnalysisView } from "./analysisView.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";

const parent = (
  operation: string,
  result: ErlangBeam | ModelArtifact,
): AnalysisViewParent => {
  const evidence = createEvidence(
    { path: result.artifact.path, sha256: "a".repeat(64), format: "file" },
    { id: "fixture", name: "Fixture reader", version: "1" },
    { operation, parameters: {}, result },
  );
  return {
    predicateType: evidence.predicate_type,
    evidenceId: evidence.evidence_id,
    operation,
    subject: evidence.subject,
    normalizedResult: result,
    limitations: [],
  };
};

const beam: ErlangBeam = {
  artifact: {
    path: "/artifacts/module.beam",
    sha256: "a".repeat(64),
    bytes: 12,
  },
  form: { location: { offset: 0, bytes: 12 }, size: 4 },
  chunks: [],
  atoms: null,
  atom_encoding: null,
  exports: null,
  imports: null,
  lambdas: null,
  code: null,
  module: null,
  coverage: { status: "complete", examined_chunks: 0, atoms: 0 },
  limitations: [],
};

it.each(["atoms", "exports", "imports", "lambdas"] as const)(
  "distinguishes unavailable BEAM %s from a decoded empty table",
  (collection) => {
    for (const available of [false, true]) {
      const result = projectAnalysisView(
        parent("inspect_erlang_beam", {
          ...beam,
          [collection]: available ? [] : null,
        }),
        { kind: "beam", collection, offset: 7, limit: 1 },
      );
      if (!result.ok) throw result.error;
      expect(result.value.coverage).toEqual({
        status: available ? "empty" : "unavailable",
        examined: 0,
        total: available ? 0 : null,
        next_offset: null,
        exhausted: available,
      });
      expect(result.value).toMatchObject({ page: { collection, items: [] } });
      if (!available)
        expect(result.value.unknowns.join(" ")).toContain(
          `No ${collection} table was decoded`,
        );
    }
  },
);

const model: ModelArtifact = {
  artifact: {
    path: "/artifacts/model.gguf",
    file_size: 32,
    header_sha256: "a".repeat(64),
    header_length: 32,
    sha256: "a".repeat(64),
    bytes_read: 32,
    read_scope: "full-file",
  },
  format: "gguf",
  version: 3,
  byte_order: "little",
  alignment: 32,
  tensor_data_offset: 32,
  metadata: [],
  tensors: [],
  totals: {
    confidence: "derived",
    parameter_count: "0",
    tensor_bytes: 0,
    by_type: [],
  },
  coverage: {
    header: "complete",
    tensor_data: "not-interpreted",
    array_values: "preview",
    tensor_ranges: "partial",
    storage_sizes: "partial",
  },
  limitations: [
    "Array metadata retains only the requested preview; storage sizes remain unknown.",
  ],
};

it.each(["metadata", "tensors", "types"] as const)(
  "retains producer limitations on model %s pages with no envelope warnings",
  (collection) => {
    const input = parent("inspect_model_artifact", model);
    const result = projectAnalysisView(input, {
      kind: "model-artifact",
      collection,
      offset: 0,
      limit: 1,
    });
    if (!result.ok) throw result.error;
    expect(result.value.limitations).toEqual(model.limitations);
    expect(input.limitations).toEqual([]);
  },
);
