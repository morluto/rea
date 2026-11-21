import { expect, it } from "vitest";

import { createEvidence } from "../../../src/domain/evidence.js";
import { err, ok } from "../../../src/domain/result.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { finishCliEvidenceCommand } from "../../../src/cli/cliEvidenceCallerPath.js";

it("binds authenticated partial Evidence but preserves raw partial observations", async () => {
  const evidence = createEvidence(
    { path: "/tmp/selected", sha256: "a".repeat(64), format: "file" },
    { id: "test", name: "Test", version: "1" },
    { operation: "inspect", parameters: {}, result: null },
  );
  for (const [partial, expected] of [
    [
      evidence,
      { evidence_id: evidence.evidence_id, caller_input_path: "./selected" },
    ],
    [
      {
        kind: "file-snapshot-hash",
        path: "/tmp/selected",
        sha256: "a".repeat(64),
        bytes: 1,
      },
      {
        kind: "file-snapshot-hash",
        path: "/tmp/selected",
        sha256: "a".repeat(64),
        bytes: 1,
      },
    ],
  ] as const) {
    const result = await finishCliEvidenceCommand(
      "./selected",
      async () =>
        err(
          new AnalysisCancelledError("inspect", {
            partialObservation: partial,
          }),
        ),
      { close: async () => {} },
      "test",
      "inspect",
      new AbortController().signal,
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.details?.partial_observation).toMatchObject(expected);
    if ("kind" in expected)
      expect(result.error.details?.partial_observation).toEqual(expected);
  }
});

it("preserves both direct input spellings when final cleanup fails", async () => {
  const evidence = createEvidence(
    { path: "/tmp/schema", sha256: "a".repeat(64), format: "file" },
    { id: "test", name: "Test", version: "1" },
    { operation: "inspect", parameters: {}, result: null },
  );
  const result = await finishCliEvidenceCommand(
    "./schema",
    async () => ok(evidence),
    {
      close: async () => {
        throw new Error("cleanup failed");
      },
    },
    "test",
    "inspect",
    new AbortController().signal,
    { operations_path: "./queries 雪.graphql" },
  );
  if (result.ok) throw new Error("Expected cleanup failure");
  expect(result.error).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      partial_observation: {
        evidence_id: evidence.evidence_id,
        caller_input_path: "./schema",
        caller_input_paths: { operations_path: "./queries 雪.graphql" },
      },
    },
  });
  expect(evidence).not.toHaveProperty("caller_input_path");
  expect(evidence).not.toHaveProperty("caller_input_paths");
});
