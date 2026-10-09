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
import { javascriptApplicationAnalysisResultSchema } from "../javascript/javascriptApplicationAnalysis.js";
import { projectBinaryLayoutView } from "./binaryLayoutView.js";
import { projectJavaScriptApplicationView } from "./javascriptApplicationView.js";

/** Pinned MCP SDK stdio receive-buffer size that oversized complete results already hit. */
const MCP_STDIO_RECEIVE_BUFFER_BYTES = 10_485_760;
/** Bytes reserved for the JSON-RPC envelope, matching MCP result encoding. */
const MCP_JSONRPC_ENVELOPE_RESERVE_BYTES = 1_024;
/**
 * evidenceResultOf duplicates the view inside Evidence, and MCP then encodes
 * structured JSON plus escaped text.
 */
const MCP_VIEW_REPRESENTATION_EXPANSION = 4;
/** PATH_MAX-sized identity row plus ELF section/symbol scalar fields. */
const WORST_CASE_PAGE_ITEM_BYTES = 6_144;
const VIEW_ENVELOPE_BYTES = 8_192;
const HEADROOM_NUMERATOR = 3;
const HEADROOM_DENOMINATOR = 4;

/**
 * Largest caller `limit` that keeps a worst-case page inside the pinned 10 MiB
 * stdio budget after Evidence wrapping and repeated MCP encodings, with 25%
 * headroom. Not an arbitrary row cap: it is derived from measured identity-row
 * and envelope sizes against the SDK buffer and Node string limit.
 */
export const MEASURED_PAGE_LIMIT = Math.floor(
  ((MCP_STDIO_RECEIVE_BUFFER_BYTES -
    MCP_JSONRPC_ENVELOPE_RESERVE_BYTES -
    MCP_VIEW_REPRESENTATION_EXPANSION * VIEW_ENVELOPE_BYTES) *
    HEADROOM_NUMERATOR) /
    (HEADROOM_DENOMINATOR *
      MCP_VIEW_REPRESENTATION_EXPANSION *
      WORST_CASE_PAGE_ITEM_BYTES),
);

/** Public name of the selected-view workflow. */
export const INSPECT_ANALYSIS_VIEW_OPERATION = "inspect_analysis_view" as const;

const summaryViewSchema = z.strictObject({ kind: z.literal("summary") });
const facetViewSchema = z.strictObject({
  kind: z.literal("facet"),
  facet: z.enum(["mitigations", "linkage"]),
});
const itemSelectorSchema = z.union([
  z.strictObject({ index: z.number().int().nonnegative() }),
  z.strictObject({ name: z.string().min(1) }),
  z.strictObject({ path: z.string().min(1) }),
  z.strictObject({ node_id: z.string().min(1) }),
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
  limit: z.number().int().positive().max(MEASURED_PAGE_LIMIT),
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

/** Coverage for a summary, facet, or single selected object. */
export const completeWithinViewCoverage = (
  examined: number,
  total: number,
): AnalysisViewCoverage => ({
  status: "complete-within-view",
  examined,
  total,
  next_offset: null,
  exhausted: true,
});

/** Coverage for a stable page, including an offset past the collection. */
export const pageViewCoverage = (
  offset: number,
  examined: number,
  total: number,
): AnalysisViewCoverage => {
  const exhausted = offset >= total || offset + examined >= total;
  return {
    status: examined === 0 ? "empty" : "page",
    examined,
    total,
    next_offset: exhausted ? null : offset + examined,
    exhausted,
  };
};

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
    const analysis = javascriptApplicationAnalysisResultSchema.safeParse(
      parent.normalizedResult,
    );
    if (!analysis.success)
      return err(
        analysisViewInputError([
          {
            path: ["source"],
            reason: "invalid_value",
            message:
              "Parent Evidence result does not match analyze_javascript_application.",
          },
        ]),
      );
    const projected = projectJavaScriptApplicationView(
      parent,
      analysis.data,
      view,
    );
    return projected.ok ? ok(sealAnalysisView(projected.value)) : projected;
  }
  return err(unsupportedParent(parent));
};
