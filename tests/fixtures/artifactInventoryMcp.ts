import { expect } from "vitest";
import type { AnalysisViewRequest } from "../../src/domain/analysisView/analysisViewRequest.js";
import {
  analysisViewResultSchema,
  artifactInventorySummaryViewResultSchema,
} from "../../src/domain/analysisView/analysisViewResult.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import type { SharedMcpCall } from "../support/cli/cliFixture.js";

export async function inspectInventorySummary(call: SharedMcpCall) {
  const result = await call("inspect_artifact", { detail: "summary" });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return artifactInventorySummaryViewResultSchema.parse(
    parseEvidence(result.structuredContent).normalized_result,
  );
}

export async function inspectRetainedOccurrences(
  call: SharedMcpCall,
  evidenceId: string,
  selection: Pick<
    Extract<
      AnalysisViewRequest,
      { kind: "inventory"; collection: "occurrences" }
    >,
    "fields" | "logical_paths"
  >,
) {
  const result = await call("inspect_analysis_view", {
    source: { kind: "retained-evidence", evidence_id: evidenceId },
    view: { kind: "inventory", collection: "occurrences", ...selection },
  });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return analysisViewResultSchema.parse(
    parseEvidence(result.structuredContent).normalized_result,
  );
}
