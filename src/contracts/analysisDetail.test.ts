import { expect, it } from "vitest";
import { z } from "zod";

import {
  binaryLayoutSummaryViewResultSchema,
  javascriptApplicationSummaryViewResultSchema,
  projectAnalysisView,
} from "../domain/analysisView/analysisView.js";
import {
  analysisViewJavaScriptEvidence,
  analysisViewLayoutEvidence,
} from "../../tests/fixtures/analysisView.js";
import { toolContract } from "./toolContracts.js";

const projectSummary = (parent: {
  readonly evidence_id: string;
  readonly operation: string;
  readonly normalized_result: unknown;
  readonly limitations: readonly string[];
}) =>
  projectAnalysisView(
    {
      evidenceId: parent.evidence_id,
      operation: parent.operation,
      normalizedResult: parent.normalized_result,
      limitations: parent.limitations,
    },
    { kind: "summary" },
  );

it("advertises only that operation's summary from analysis detail outputs", () => {
  for (const name of [
    "inspect_binary_layout",
    "analyze_javascript_application",
  ] as const) {
    const schema = JSON.stringify(
      z.toJSONSchema(toolContract(name).outputSchema),
    );
    expect(schema).not.toContain("api-surface");
    expect(schema).not.toContain("inspect_web_network_capture");
  }
  expect(
    JSON.stringify(
      z.toJSONSchema(toolContract("inspect_analysis_view").outputSchema),
    ),
  ).toContain("api-surface");

  const layout = projectSummary(analysisViewLayoutEvidence());
  const javascript = projectSummary(analysisViewJavaScriptEvidence());
  if (!layout.ok || !javascript.ok) throw new Error("Expected summaries");
  expect(
    binaryLayoutSummaryViewResultSchema.safeParse(layout.value).success,
  ).toBe(true);
  expect(
    javascriptApplicationSummaryViewResultSchema.safeParse(javascript.value)
      .success,
  ).toBe(true);
  expect(
    binaryLayoutSummaryViewResultSchema.safeParse(javascript.value).success,
  ).toBe(false);
});
