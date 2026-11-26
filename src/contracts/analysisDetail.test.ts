import { expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";

import { projectAnalysisView } from "../domain/analysisView/analysisView.js";
import { binaryLayoutSummaryViewResultSchema } from "../domain/analysisView/summarySchemas/binaryLayoutSummarySchema.js";
import { javascriptApplicationSummaryViewResultSchema } from "../domain/analysisView/summarySchemas/javascriptApplicationSummarySchema.js";
import { analysisViewRequestSchema } from "../domain/analysisView/analysisViewRequest.js";
import {
  analysisViewCaptureEvidence,
  analysisViewJavaScriptEvidence,
  analysisViewLayoutEvidence,
  environmentStateCaptureFixture,
} from "../../tests/fixtures/analysisView.js";
import { toolContract } from "./toolContracts.js";
import { advertisedOutputJsonSchema } from "./toolSchemaMetadata.js";

const projectSummary = (parent: {
  readonly evidence_id: string;
  readonly predicate_type: string;
  readonly operation: string;
  readonly normalized_result: unknown;
  readonly limitations: readonly string[];
}) =>
  projectAnalysisView(
    {
      predicateType: parent.predicate_type,
      evidenceId: parent.evidence_id,
      operation: parent.operation,
      normalizedResult: parent.normalized_result,
      limitations: parent.limitations,
    },
    { kind: "summary" },
  );

it("advertises only that operation's summary from analysis detail outputs", () => {
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

  const ajv = new Ajv2020({
    strict: false,
    validateFormats: false,
    inlineRefs: false,
    code: { optimize: false },
  });
  const validators = Object.fromEntries(
    (
      [
        "inspect_binary_layout",
        "analyze_javascript_application",
        "inspect_analysis_view",
      ] as const
    ).map((name) => [
      name,
      ajv.compile(advertisedOutputJsonSchema(toolContract(name))),
    ]),
  );
  const layoutReceipt = {
    ...analysisViewLayoutEvidence(),
    normalized_result: layout.value,
  };
  const javascriptReceipt = {
    ...analysisViewJavaScriptEvidence(),
    normalized_result: javascript.value,
  };
  expect(validators.inspect_binary_layout!(layoutReceipt)).toBe(true);
  expect(validators.analyze_javascript_application!(javascriptReceipt)).toBe(
    true,
  );
  const parent = analysisViewCaptureEvidence(environmentStateCaptureFixture());
  const captureParent = {
    predicateType: parent.predicate_type,
    evidenceId: parent.evidence_id,
    operation: parent.operation,
    normalizedResult: parent.normalized_result,
    parameters: parent.parameters,
    subject: parent.subject,
    limitations: parent.limitations,
  };
  const captureSummary = projectAnalysisView(captureParent, {
    kind: "summary",
  });
  if (!captureSummary.ok) throw captureSummary.error;
  const captureReceipt = { ...parent, normalized_result: captureSummary.value };
  expect(validators.inspect_analysis_view!(captureReceipt)).toBe(true);
  expect(
    validators.inspect_binary_layout!({
      ...layoutReceipt,
      normalized_result: captureSummary.value,
    }),
  ).toBe(false);
  expect(
    validators.analyze_javascript_application!({
      ...javascriptReceipt,
      normalized_result: captureSummary.value,
    }),
  ).toBe(false);
  for (const kind of [
    "api-surface",
    "environment-manifest",
    "environment-state",
  ] as const) {
    const projected = projectAnalysisView(
      captureParent,
      analysisViewRequestSchema.parse({ kind }),
    );
    if (!projected.ok) throw projected.error;
    const receipt = { ...parent, normalized_result: projected.value };
    expect(validators.inspect_analysis_view!(receipt), kind).toBe(true);
    expect(
      validators.inspect_binary_layout!({
        ...layoutReceipt,
        normalized_result: projected.value,
      }),
      kind,
    ).toBe(false);
    expect(
      validators.analyze_javascript_application!({
        ...javascriptReceipt,
        normalized_result: projected.value,
      }),
      kind,
    ).toBe(false);
  }
});

/** The `detail` alternatives an input JSON Schema declares, with their defaults. */
const detailAlternatives = (
  schema: unknown,
): {
  readonly values: readonly unknown[];
  readonly defaults: readonly unknown[];
} => {
  const values: unknown[] = [];
  const defaults: unknown[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    const detail = (record.properties as Record<string, unknown> | undefined)
      ?.detail as Record<string, unknown> | undefined;
    if (detail !== undefined) {
      if (Array.isArray(detail.enum)) values.push(...detail.enum);
      if ("const" in detail) values.push(detail.const);
      if ("default" in detail) defaults.push(detail.default);
    }
    for (const key of ["anyOf", "oneOf", "allOf"])
      if (Array.isArray(record[key]))
        for (const child of record[key]) visit(child);
  };
  visit(schema);
  return { values, defaults };
};

it("registers the agent result budget for every contract whose omitted detail is budgeted", async () => {
  const [{ TOOL_CONTRACTS }, { AGENT_BUDGET_OPERATIONS }, { z }] =
    await Promise.all([
      import("./toolContracts.js"),
      import("../domain/agentBudgetOperations.js"),
      import("zod"),
    ]);
  const budgeted = TOOL_CONTRACTS.flatMap((contract) => {
    if (contract.name === "get_evidence_bundle") return [];
    const { values, defaults } = detailAlternatives(
      z.toJSONSchema(contract.inputSchema, {
        io: "input",
        unrepresentable: "any",
      }),
    );
    return values.includes("summary") && !defaults.includes("summary")
      ? [contract.name]
      : [];
  });
  expect([...AGENT_BUDGET_OPERATIONS].sort()).toEqual(budgeted.sort());
});
