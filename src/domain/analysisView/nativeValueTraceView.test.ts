import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import {
  analysisViewResultSchema,
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";

it("summarizes trace Evidence retained before unknowns named a related procedure", () => {
  const target = { path: "/samples/a.out", sha256: "a".repeat(64), bytes: 16 };
  const trace = {
    seed: "0x1000",
    target_sha256: target.sha256,
    nodes: [],
    edges: [],
    procedures: [],
    unknowns: [
      {
        procedure: "0x1000",
        address: "0x1004",
        reason: "Call target unresolved",
      },
    ],
    total_nodes: 0,
    total_edges: 0,
    decompilations: 1,
    next_offset: null,
    page_truncated: false,
    traversal: { status: "complete" },
    truncated: false,
    limitations: [],
  };
  const evidence = createEvidence(
    { ...target, format: "file" },
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "trace_native_values",
      parameters: { procedure: "0x1000" },
      result: trace,
      confidence: "derived",
      authority: "historical-reference",
    },
  );
  const parent: AnalysisViewParent = {
    predicateType: evidence.predicate_type,
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    normalizedResult: trace,
    subject: evidence.subject,
    limitations: evidence.limitations,
  };
  const summary = projectAnalysisView(parent, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  expect(analysisViewResultSchema.parse(summary.value)).toMatchObject({
    kind: "summary",
    parent_operation: "trace_native_values",
    summary: { seed: "0x1000", unknown_count: 1 },
  });
  expect(JSON.stringify(summary.value)).toContain(
    "0x1000 at 0x1004: Call target unresolved",
  );
  // The retained Evidence is read, not rewritten.
  expect(trace.unknowns[0]).not.toHaveProperty("related_procedure");
});
