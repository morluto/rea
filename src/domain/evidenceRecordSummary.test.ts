import { expect, it } from "vitest";

import { createEvidence } from "./evidence.js";
import { createEvidenceBundle } from "./evidenceBundle.js";
import { summarizeEvidenceBundle } from "./evidenceRecordSummary.js";

it("preserves native identity independently of missing or incompatible value-flow metadata", () => {
  const records = [
    undefined,
    {
      available: true,
      truncated: true,
      omitted_operations_lower_bound: 1,
      known_omitted_inputs: 0,
      known_omitted_edges: 2,
    },
    { available: true, truncated: true },
    { available: false, reason: "Decompiler unavailable" },
  ].map((flow) =>
    createEvidence(
      { path: "/fixtures/native.exe", format: "pe", sha256: "a".repeat(64) },
      { id: "provider", name: "Provider", version: "1" },
      {
        operation: "analyze_function",
        parameters: {},
        result: {
          procedure: { address: "space:0x10", name: "entry" },
          ...(flow === undefined ? {} : { native_value_flow: flow }),
        },
      },
    ),
  );
  const summary = summarizeEvidenceBundle(createEvidenceBundle(records), {
    procedure_address: "space:0x10",
  });
  expect(summary.matching_records).toBe(4);
  const native = summary.records.map((r) => r.native_dossier);
  expect(
    native.every((r) => r.available && r.procedure_address === "space:0x10"),
  ).toBe(true);
  expect(native).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value_flow: { status: "not-recorded" } }),
      expect.objectContaining({
        value_flow: {
          status: "observed",
          truncated: true,
          omitted_operations_lower_bound: 1,
          known_omitted_inputs: 0,
          known_omitted_edges: 2,
        },
      }),
      expect.objectContaining({
        value_flow: { status: "unknown", reason: expect.any(String) },
      }),
      expect.objectContaining({
        value_flow: { status: "unavailable", reason: "Decompiler unavailable" },
      }),
    ]),
  );
});

it.each([
  {
    flow: {
      available: true,
      truncated: false,
      omitted_operations_lower_bound: 2,
      known_omitted_inputs: 3,
      known_omitted_edges: 4,
      operations: "full collections are not parsed",
    },
    expected: {
      status: "observed",
      truncated: false,
      omitted_operations_lower_bound: 2,
      known_omitted_inputs: 3,
      known_omitted_edges: 4,
    },
  },
  {
    flow: { available: false, reason: "" },
    expected: { status: "unknown", reason: expect.any(String) },
  },
  {
    flow: { available: true, truncated: false, known_omitted_edges: -1 },
    expected: { status: "unknown", reason: expect.any(String) },
  },
  {
    flow: { available: true, truncated: false, known_omitted_inputs: null },
    expected: { status: "unknown", reason: expect.any(String) },
  },
])(
  "projects retained flow metadata without requiring current full payloads: $flow",
  ({ flow, expected }) => {
    const record = createEvidence(
      { path: "/fixtures/native.exe", format: "pe", sha256: "a".repeat(64) },
      { id: "provider", name: "Provider", version: "1" },
      {
        operation: "analyze_function",
        parameters: {},
        result: {
          procedure: { address: "space:0x10", name: "entry" },
          native_value_flow: flow,
        },
      },
    );
    const summary = summarizeEvidenceBundle(createEvidenceBundle([record]));
    expect(summary.records[0]?.native_dossier).toEqual({
      available: true,
      procedure_address: "space:0x10",
      procedure_name: "entry",
      value_flow: expected,
    });
    expect(record.normalized_result).toMatchObject({ native_value_flow: flow });
  },
);

it("filters directory records by their tree digest, like file records by theirs", () => {
  const provider = { id: "provider", name: "Provider", version: "1" };
  const observation = {
    operation: "inventory_artifact",
    parameters: {},
    result: {},
  };
  const directory = createEvidence(
    {
      path: "/fixtures/build",
      sha256: "d".repeat(64),
      format: "directory",
      tree: { algorithm: "rea-directory-tree", version: 1 },
    },
    provider,
    observation,
  );
  const file = createEvidence(
    { path: "/fixtures/build.zip", format: "zip", sha256: "f".repeat(64) },
    provider,
    observation,
  );
  const bundle = createEvidenceBundle([directory, file]);
  for (const [digest, expected] of [
    ["d".repeat(64), directory.evidence_id],
    ["f".repeat(64), file.evidence_id],
  ] as const) {
    const summary = summarizeEvidenceBundle(bundle, { target_sha256: digest });
    expect(summary.matching_records).toBe(1);
    expect(summary.records.map(({ evidence_id }) => evidence_id)).toEqual([
      expected,
    ]);
  }
});
