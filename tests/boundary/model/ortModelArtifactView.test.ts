import { resolve } from "node:path";
import { expect, it } from "vitest";

import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { createModelArtifactEvidence } from "../../../src/domain/model/modelArtifactEvidence.js";
import {
  modelArtifactSchema,
  type ModelArtifact,
} from "../../../src/domain/model/modelArtifact.js";

const location = {
  source_offset: 64,
  source_length: 16,
  json_pointer: null,
};
const reportFixture = (): ModelArtifact => ({
  artifact: {
    path: resolve("synthetic.ort"),
    file_size: 512,
    header_sha256: "ab".repeat(32),
    header_length: 512,
    sha256: null,
    bytes_read: 512,
    read_scope: "full-file",
  },
  format: "ort",
  version: null,
  ort_version: "6",
  file_identifier: "ORTM",
  byte_order: "little",
  alignment: null,
  tensor_data_offset: null,
  metadata: [],
  tensors: [],
  inputs: [
    {
      index: 0,
      name: "images",
      type: "FLOAT",
      type_id: 1,
      type_kind: "tensor",
      shape: [
        { kind: "symbol", symbol: "batch" },
        { kind: "value", value: "3" },
        { kind: "unknown" },
      ],
      ...location,
    },
    {
      index: 1,
      name: "unknown",
      type: null,
      type_id: null,
      type_kind: "unknown",
      shape: null,
      ...location,
    },
  ],
  outputs: [
    {
      index: 0,
      name: "score",
      type: "FLOAT",
      type_id: 1,
      type_kind: "tensor",
      shape: [],
      ...location,
    },
  ],
  operators: [
    {
      index: 0,
      name: "",
      op_type: "Identity",
      domain: "",
      since_version: 13,
      ...location,
    },
    {
      index: 1,
      name: "",
      op_type: "QuickGelu",
      domain: "com.microsoft",
      since_version: 1,
      ...location,
    },
  ],
  totals: {
    confidence: "derived",
    parameter_count: "0",
    tensor_bytes: 0,
    by_type: [],
  },
  coverage: {
    header: "partial",
    tensor_data: "not-interpreted",
    array_values: "complete",
    tensor_ranges: "complete",
    storage_sizes: "complete",
    inputs: "partial",
    outputs: "complete",
    operators: "complete",
    initializers: "complete",
  },
  limitations: ["One input type is unresolved."],
});
const retain = (report = reportFixture()) =>
  createModelArtifactEvidence(
    report,
    { id: "model-artifact", name: "REA model header reader", version: null },
    { path: report.artifact.path, hash: "header" },
  );

it("keeps ORT graph declarations in retained Evidence while summarizing counts", async () => {
  const parent = retain();
  const before = JSON.stringify(parent);
  const project = (view: unknown) =>
    inspectAnalysisView(
      {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view,
      },
      (id) => (id === parent.evidence_id ? parent : undefined),
    );
  const summary = await project({ kind: "summary" });
  if (!summary.ok) throw summary.error;
  expect(summary.value.normalized_result).toMatchObject({
    summary: {
      format: "ort",
      ort_version: "6",
      file_identifier: "ORTM",
      counts: { inputs: 2, outputs: 1, operators: 2 },
      coverage: { header: "partial", inputs: "partial" },
    },
  });
  const serialized = JSON.stringify(summary.value.normalized_result);
  expect(serialized).not.toContain('"images"');
  expect(serialized).not.toContain('"QuickGelu"');

  const first = await project({
    kind: "model-artifact",
    collection: "inputs",
    limit: 1,
  });
  if (!first.ok) throw first.error;
  expect(first.value.normalized_result).toMatchObject({
    items: [reportFixture().inputs![0]],
    coverage: { total: 2, next_offset: 1, exhausted: false },
    source_coverage: { inputs: "partial" },
  });
  const unknown = await project({
    kind: "model-artifact",
    collection: "inputs",
    names: ["unknown"],
    fields: ["name", "type", "shape"],
  });
  if (!unknown.ok) throw unknown.error;
  expect(unknown.value.normalized_result).toMatchObject({
    items: [{ index: 1, name: "unknown", type: null, shape: null }],
  });
  const scalar = await project({
    kind: "model-artifact",
    collection: "outputs",
  });
  if (!scalar.ok) throw scalar.error;
  expect(scalar.value.normalized_result).toMatchObject({
    items: [{ name: "score", shape: [] }],
  });
  const operators = await project({
    kind: "model-artifact",
    collection: "operators",
    domains: ["com.microsoft"],
    op_types: ["QuickGelu"],
    fields: ["op_type", "domain", "since_version"],
  });
  if (!operators.ok) throw operators.error;
  expect(operators.value.normalized_result).toMatchObject({
    items: [
      {
        index: 1,
        op_type: "QuickGelu",
        domain: "com.microsoft",
        since_version: 1,
      },
    ],
    coverage: { total: 1, exhausted: true },
  });
  expect(JSON.stringify(parent)).toBe(before);
});

it("rejects ambiguous graph identities and non-positional operator indexes", () => {
  const duplicate = reportFixture();
  duplicate.inputs![1]!.name = "images";
  expect(modelArtifactSchema.safeParse(duplicate).success).toBe(false);
  const misplaced = reportFixture();
  misplaced.operators![1]!.index = 0;
  expect(modelArtifactSchema.safeParse(misplaced).success).toBe(false);
  expect(modelArtifactSchema.safeParse(reportFixture()).success).toBe(true);
});

it("does not reinterpret historical Evidence without graph observations as an empty graph", async () => {
  const report = reportFixture();
  delete report.inputs;
  delete report.outputs;
  delete report.operators;
  const parent = retain(report);
  const result = await inspectAnalysisView({
    source: { kind: "inline", evidence: parent },
    view: { kind: "model-artifact", collection: "inputs" },
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      issues: [{ path: ["view", "collection"], reason: "invalid_value" }],
    },
  });
});
