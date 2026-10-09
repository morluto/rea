import { z } from "zod";

import {
  AnalysisInputError,
  type AnalysisInputIssue,
  AnalysisUnsupportedTargetError,
} from "../analysisErrorCore.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { evidenceSchema } from "../evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { binaryLayoutSchema } from "../native/binaryLayout.js";
import {
  parseOwnedJavaScriptApplicationAnalysisSteps,
  type JavaScriptApplicationAnalysisResult,
} from "../javascript/javascriptApplicationAnalysis.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import { projectBinaryLayoutView } from "./binaryLayoutView.js";
import { projectJavaScriptApplicationView } from "./javascriptApplicationView.js";

/** Public name of the selected-view workflow. */
export const INSPECT_ANALYSIS_VIEW_OPERATION = "inspect_analysis_view" as const;

const summaryViewSchema = z.strictObject({ kind: z.literal("summary") });
const facetViewSchema = z.strictObject({
  kind: z.literal("facet"),
  facet: z.enum(["mitigations", "linkage"]),
});
const itemSelectorSchema = z.union([
  z.strictObject({ index: z.number().int().nonnegative() }),
  z.strictObject({ name: z.string() }),
  z.strictObject({ path: z.string() }),
  z.strictObject({ node_id: prefixedDigestSchema("jag_node") }),
]);
const itemViewSchema = z
  .strictObject({
    kind: z.literal("item"),
    collection: z.enum(["sections", "symbols", "modules"]),
    selector: itemSelectorSchema,
  })
  .superRefine((value, context) => {
    const selector = value.selector;
    if (value.collection === "modules") {
      if (!("path" in selector) && !("node_id" in selector))
        context.addIssue({
          code: "custom",
          path: ["selector"],
          message:
            "Module items are selected by exact path or node_id, not index or name.",
        });
      return;
    }
    if (!("index" in selector) && !("name" in selector))
      context.addIssue({
        code: "custom",
        path: ["selector"],
        message:
          "Section and symbol items are selected by index or exact name, not path or node_id.",
      });
  });
const pageViewSchema = z.strictObject({
  kind: z.literal("page"),
  collection: z.enum(["sections", "symbols", "modules"]),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

/** Caller-selected projection of already completed analysis Evidence. */
export const analysisViewRequestSchema = z.discriminatedUnion("kind", [
  summaryViewSchema,
  facetViewSchema,
  itemViewSchema,
  pageViewSchema,
]);

/** Inline Evidence or an exact same-session retained reference. */
export const analysisViewSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("retained-evidence"),
    evidence_id: prefixedDigestSchema("ev"),
  }),
  z.strictObject({
    kind: z.literal("inline"),
    evidence: evidenceSchema,
  }),
]);

/** Public inspect_analysis_view input. */
export const inspectAnalysisViewInputSchema = z.strictObject({
  source: analysisViewSourceSchema,
  view: analysisViewRequestSchema,
});

const coverageSchema = z.strictObject({
  status: z.enum(["complete-within-view", "page", "empty"]),
  examined: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
  exhausted: z.boolean(),
});

const artifactSchema = z.strictObject({
  path: z.string().min(1),
  sha256: digestSchema,
});

const layoutSummarySchema = z.strictObject({
  bytes: z.number().int().nonnegative(),
  format: z.literal("elf"),
  architecture: z.strictObject({
    machine: z.literal("EM_X86_64"),
    bits: z.literal(64),
    byte_order: z.literal("little"),
  }),
  image_type: z.enum(["ET_EXEC", "ET_DYN", "ET_REL"]),
  entry: z.strictObject({
    reported_value: z.string().min(1),
    meaning: z.enum(["linked-virtual-address", "not-applicable", "absent"]),
    execution_status: z.literal("unknown"),
  }),
  counts: z.strictObject({
    sections: z.number().int().nonnegative(),
    segments: z.number().int().nonnegative(),
    symbols: z.number().int().nonnegative(),
    relocations: z.number().int().nonnegative(),
  }),
  limitation_count: z.number().int().nonnegative(),
});

const javascriptSummarySchema = z.strictObject({
  input_path: z.string().min(1),
  format: z.enum(["asar", "directory"]),
  root_artifact_sha256: digestSchema,
  statistics: jsonObjectSchema,
  electron: jsonObjectSchema,
  coverage: jsonObjectSchema,
  limitation_count: z.number().int().nonnegative(),
});

const viewResultBase = {
  parent_evidence_id: prefixedDigestSchema("ev"),
  parent_operation: z.enum([
    "inspect_binary_layout",
    "analyze_javascript_application",
  ]),
  parent_digest: digestSchema,
  view_digest: digestSchema,
  artifact: artifactSchema,
  coverage: coverageSchema,
  limitations: z.array(z.string()),
  unknowns: z.array(z.string()),
} as const;

/** Projected facts for one selected view of retained analysis Evidence. */
export const analysisViewResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("summary"),
    view: summaryViewSchema,
    summary: z.union([layoutSummarySchema, javascriptSummarySchema]),
    ...viewResultBase,
  }),
  z.strictObject({
    kind: z.literal("facet"),
    view: facetViewSchema,
    facet: jsonValueSchema,
    ...viewResultBase,
  }),
  z.strictObject({
    kind: z.literal("item"),
    view: itemViewSchema,
    item: jsonValueSchema,
    ...viewResultBase,
  }),
  z.strictObject({
    kind: z.literal("page"),
    view: pageViewSchema,
    items: z.array(jsonValueSchema),
    ...viewResultBase,
  }),
]);

export type AnalysisViewRequest = z.output<typeof analysisViewRequestSchema>;
export type InspectAnalysisViewInput = z.output<
  typeof inspectAnalysisViewInputSchema
>;
export type AnalysisViewResult = z.output<typeof analysisViewResultSchema>;
export type AnalysisViewCoverage = z.output<typeof coverageSchema>;

/** Parent record already resolved from inline Evidence or a session reference. */
export interface AnalysisViewParent {
  readonly evidenceId: string;
  readonly operation: string;
  readonly normalizedResult: unknown;
  readonly limitations: readonly string[];
}

export {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

/** Construct a typed input failure for one selected-view constraint. */
export const analysisViewInputError = (
  issues: readonly AnalysisInputIssue[],
): AnalysisInputError =>
  new AnalysisInputError(INSPECT_ANALYSIS_VIEW_OPERATION, undefined, issues);

/** SHA-256 of the canonical projected JSON, excluding this digest field. */
export const analysisViewDigest = (
  projection: Omit<AnalysisViewResult, "view_digest">,
): string => digestCanonicalValue(projection, "Analysis view");

/** View payload before the content digest is attached. */
export type UnsignedAnalysisView =
  | Omit<
      Extract<AnalysisViewResult, { readonly kind: "summary" }>,
      "view_digest"
    >
  | Omit<Extract<AnalysisViewResult, { readonly kind: "facet" }>, "view_digest">
  | Omit<Extract<AnalysisViewResult, { readonly kind: "item" }>, "view_digest">
  | Omit<Extract<AnalysisViewResult, { readonly kind: "page" }>, "view_digest">;

/** Attach the content digest that must change when projected bytes change. */
export const sealAnalysisView = (
  projection: UnsignedAnalysisView,
): AnalysisViewResult =>
  analysisViewResultSchema.parse({
    ...projection,
    view_digest: analysisViewDigest(projection),
  });

const parentDigest = (evidenceId: string): string => evidenceId.slice(3);

const parseJavaScriptParent = (
  input: unknown,
): Result<JavaScriptApplicationAnalysisResult, AnalysisError> => {
  try {
    // Only the existing realm-private graph proofs permit reuse. Imported or
    // merely frozen graphs still receive full canonical validation.
    const steps = parseOwnedJavaScriptApplicationAnalysisSteps(input);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return ok(step.value);
  } catch (cause: unknown) {
    if (!(cause instanceof z.ZodError)) throw cause;
    return err(
      analysisInputErrorFromIssues(
        INSPECT_ANALYSIS_VIEW_OPERATION,
        cause.issues.map((issue) => ({
          ...issue,
          path: ["source", "normalized_result", ...issue.path],
        })),
        { source: { normalized_result: input } },
        { cause },
      ),
    );
  }
};

const unsupportedParent = (
  parent: AnalysisViewParent,
): AnalysisUnsupportedTargetError =>
  new AnalysisUnsupportedTargetError(
    INSPECT_ANALYSIS_VIEW_OPERATION,
    parentArtifactPath(parent),
    `Parent Evidence operation ${JSON.stringify(parent.operation)} is not inspect_binary_layout or analyze_javascript_application.`,
  );

const parentArtifactPath = (parent: AnalysisViewParent): string => {
  if (
    typeof parent.normalizedResult === "object" &&
    parent.normalizedResult !== null &&
    "artifact" in parent.normalizedResult &&
    typeof parent.normalizedResult.artifact === "object" &&
    parent.normalizedResult.artifact !== null &&
    "path" in parent.normalizedResult.artifact &&
    typeof parent.normalizedResult.artifact.path === "string"
  )
    return parent.normalizedResult.artifact.path;
  if (
    typeof parent.normalizedResult === "object" &&
    parent.normalizedResult !== null &&
    "input_path" in parent.normalizedResult &&
    typeof parent.normalizedResult.input_path === "string"
  )
    return parent.normalizedResult.input_path;
  return parent.evidenceId;
};

/** Project one selected view from authenticated parent analysis Evidence. */
export const projectAnalysisView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<AnalysisViewResult, AnalysisError> => {
  const digest = parentDigest(parent.evidenceId);
  if (!digestSchema.safeParse(digest).success)
    return err(
      analysisViewInputError([
        {
          path: ["source"],
          reason: "invalid_format",
          message: "Parent Evidence ID is not a digest-backed identifier.",
        },
      ]),
    );
  if (parent.operation === "inspect_binary_layout") {
    const layout = binaryLayoutSchema.safeParse(parent.normalizedResult);
    if (!layout.success)
      return err(
        analysisViewInputError([
          {
            path: ["source"],
            reason: "invalid_value",
            message:
              "Parent Evidence result does not match inspect_binary_layout.",
          },
        ]),
      );
    const projected = projectBinaryLayoutView(parent, layout.data, view);
    return projected.ok ? ok(sealAnalysisView(projected.value)) : projected;
  }
  if (parent.operation === "analyze_javascript_application") {
    const analysis = parseJavaScriptParent(parent.normalizedResult);
    if (!analysis.ok) return analysis;
    const projected = projectJavaScriptApplicationView(
      parent,
      analysis.value,
      view,
    );
    return projected.ok ? ok(sealAnalysisView(projected.value)) : projected;
  }
  return err(unsupportedParent(parent));
};
