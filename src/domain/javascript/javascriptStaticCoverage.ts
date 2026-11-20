import { javaScriptSemanticPrecisionSchema } from "./javascriptSemanticPrecision.js";
import { z } from "zod";
import { analysisParameterLimitSchema } from "../analysisSettingDefinitions.js";
import { javaScriptSemanticResourceLimitSchema } from "./javascriptSemanticValueTypes.js";
import { javaScriptRefusedPhaseSchema } from "./javascriptSemanticWorkAllowance.js";

/** Independent observations from one inert static pass; no runtime completeness claim. */
export const javaScriptStaticCoverageSchema = z.strictObject({
  syntax: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("complete"),
      error_count: z.literal(0),
    }),
    z.strictObject({
      status: z.literal("recovered"),
      error_count: z.int().positive(),
    }),
    z.strictObject({ status: z.literal("failed"), error_count: z.null() }),
    z.strictObject({
      status: z.literal("not-examined"),
      error_count: z.null(),
    }),
  ]),
  semantics: z.strictObject({
    unknown_findings: z.int().nonnegative().nullable(),
    uncertainty: z.array(
      z.enum([
        "dynamic-findings",
        "returned-reference-widening",
        "type-only-module-side-effect",
        "conditional-loader",
        "commonjs-wrapper-redeclaration",
      ]),
    ),
  }),
  examination: z.strictObject({
    // domain-vocabulary: whether the static pass ran without hitting a semantic_precision budget, was limited by one, or was not run.
    status: z.enum(["complete", "limited", "not-examined"]),
    semantic_resource_limits: z.array(javaScriptSemanticResourceLimitSchema),
    semantic_precision: javaScriptSemanticPrecisionSchema.optional(),
    electron_call_paths_limited: z.boolean(),
    /** The `semantic_precision` budgets that limited this source. */
    controls: z.array(analysisParameterLimitSchema).min(1).exactOptional(),
    /** The analysis phase whose work allowance refused this source. */
    refused_phase: javaScriptRefusedPhaseSchema.exactOptional(),
  }),
  applicability: z.strictObject({ electron: z.enum(["observed", "unknown"]) }),
  unexamined_reason: z.string().min(1).exactOptional(),
});

export type JavaScriptStaticCoverage = z.infer<
  typeof javaScriptStaticCoverageSchema
>;

/** Preserve the established conservative summary, independently of finer facts. */
export const javaScriptStaticParseStatus = (
  coverage: JavaScriptStaticCoverage,
): "complete" | "partial" | "failed" =>
  coverage.syntax.status === "failed" ||
  coverage.syntax.status === "not-examined"
    ? "failed"
    : coverage.syntax.status === "recovered" ||
        coverage.examination.status === "not-examined" ||
        // An unknown finding count cannot establish that none were found.
        coverage.semantics.unknown_findings !== 0 ||
        coverage.semantics.uncertainty.includes("conditional-loader") ||
        coverage.examination.semantic_resource_limits.includes(
          "alias-selections",
        )
      ? "partial"
      : "complete";

/** Unperformed work has no measured syntax, finding count or framework applicability. */
export const unexaminedJavaScriptStaticCoverage = (
  reason: string,
): JavaScriptStaticCoverage => ({
  syntax: { status: "not-examined", error_count: null },
  semantics: { unknown_findings: null, uncertainty: [] },
  examination: {
    status: "not-examined",
    semantic_resource_limits: [],
    electron_call_paths_limited: false,
  },
  applicability: { electron: "unknown" },
  unexamined_reason: reason,
});
