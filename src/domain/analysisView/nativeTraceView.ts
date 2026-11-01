import { z } from "zod";
import { jsonValueSchema } from "../jsonValue.js";
import { literalFeatureMatchSchema } from "../native/literalFeatureMatch.js";
import {
  literalFeatureReferenceSchema,
  literalFeatureTraceResultSchema,
  literalReferenceOwner,
} from "../native/literalFeatureTrace.js";
import { err, ok } from "../result.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { selectViewRows } from "./selectViewRows.js";

const OPERATION = "trace_feature" as const;
const ownerSchema = z.enum(["found", "not-found", "unavailable"]);
const page = {
  kind: z.literal("native-trace"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
};

/** Page one retained collection of a completed literal feature trace. */
export const nativeTraceViewRequestSchema = z.discriminatedUnion("collection", [
  z.strictObject({
    ...page,
    collection: z.literal("references"),
    where: z
      .strictObject({
        target_addresses: z
          .array(z.string())
          .optional()
          .describe(
            "Exact match addresses as recorded; no address normalization. Omitted selects all; [] selects none.",
          ),
        owners: z
          .array(ownerSchema)
          .optional()
          .describe(
            "Containing-procedure outcome: found, not-found (outside segments or no procedure) or unavailable (the provider could not resolve ownership).",
          ),
      })
      .default({}),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("matches"),
    where: z
      .strictObject({
        types: z.array(z.enum(["string", "procedure"])).optional(),
      })
      .default({}),
  }),
  z.strictObject({ ...page, collection: z.literal("residual_unknowns") }),
]);
type NativeTraceViewRequest = z.output<typeof nativeTraceViewRequestSchema>;

const sourceIndex = z.int().nonnegative();
/** source_index addresses the complete retained array, so duplicates stay distinct. */
export const nativeTraceViewItemsSchema = z.union([
  z.array(
    z.strictObject({
      source_index: sourceIndex,
      owner: ownerSchema,
      reference: literalFeatureReferenceSchema,
    }),
  ),
  z.array(
    z.strictObject({
      source_index: sourceIndex,
      match: literalFeatureMatchSchema,
    }),
  ),
  z.array(z.strictObject({ source_index: sourceIndex, unknown: z.string() })),
]);

const counts = z.int().nonnegative();
/** Trace identity, provider outcome and counts repeated with every page. */
export const nativeTraceViewContextSchema = z.strictObject({
  query: z.string(),
  search_mode: z.literal("literal"),
  truncated: z
    .boolean()
    .describe("The provider reported a reference cap for at least one match."),
});
export const nativeTraceSummarySchema = nativeTraceViewContextSchema.extend({
  matches: z.strictObject({
    total: counts,
    string: counts,
    procedure: counts,
  }),
  references: z.strictObject({
    total: counts,
    found: counts,
    "not-found": counts,
    unavailable: counts,
  }),
  residual_unknowns: counts,
});

const readTrace = createAnalysisViewResultReader(
  literalFeatureTraceResultSchema,
);
const selected = <Value>(values: readonly Value[] | undefined) =>
  values === undefined ? undefined : new Set(values);

/** Select retained trace rows without another provider read or reinterpretation. */
export const projectNativeTraceView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<SummaryAnalysisView | NativeTraceViewRequest>(
    admitted,
    "summary",
    "native-trace",
  );
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Native feature traces support summary and native-trace pages of references, matches or residual_unknowns.",
        },
      ]),
    );
  const parsed = readTrace(parent);
  if (!parsed.ok) return parsed;
  const trace = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: OPERATION,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact ?? null,
    source_provider: parent.provider ?? null,
    source_analysis_profile_digest: parent.analysisProfile?.digest ?? null,
    source_parameters: jsonValueSchema.parse(parent.parameters ?? null),
    limitations: boundedViewMessages(
      parent.limitations,
      parent.evidenceId,
      "limitations",
    ),
    // Residual unknowns can number one per reference; page them instead of
    // repeating every text in each view.
    unknowns: [
      "Counts and pages describe the provider-reported matches and references retained by this trace, not complete discovery. A missing row does not establish an absent reference.",
      ...(trace.truncated
        ? [
            "truncated is true: the provider reported a reference cap, so references beyond it were not observed.",
          ]
        : []),
      ...(trace.residual_unknowns.length > 0
        ? [
            `${String(trace.residual_unknowns.length)} residual unknowns remain in the parent trace; page them with collection residual_unknowns.`,
          ]
        : []),
    ],
  };
  const context = {
    query: trace.query,
    search_mode: trace.search_mode,
    truncated: trace.truncated,
  };
  if (view.kind === "summary") {
    const owners = { found: 0, "not-found": 0, unavailable: 0 };
    for (const reference of trace.references)
      owners[literalReferenceOwner(reference)] += 1;
    const strings = trace.matches.filter(({ type }) => type === "string");
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      summary: {
        ...context,
        matches: {
          total: trace.matches.length,
          string: strings.length,
          procedure: trace.matches.length - strings.length,
        },
        references: { total: trace.references.length, ...owners },
        residual_unknowns: trace.residual_unknowns.length,
      },
      coverage: completeWithinViewCoverage(1, 1),
    });
  }
  const rows = (() => {
    if (view.collection === "residual_unknowns")
      return selectViewRows(
        trace.residual_unknowns,
        view,
        () => true,
        (unknown, source_index) => ({ source_index, unknown }),
      );
    if (view.collection === "matches") {
      const types = selected(view.where.types);
      return selectViewRows(
        trace.matches,
        view,
        (match) => types === undefined || types.has(match.type),
        (match, source_index) => ({ source_index, match }),
      );
    }
    const targets = selected(view.where.target_addresses);
    const owners = selected(view.where.owners);
    return selectViewRows(
      trace.references,
      view,
      (reference) =>
        (targets === undefined || targets.has(reference.target_address)) &&
        (owners === undefined || owners.has(literalReferenceOwner(reference))),
      (reference, source_index) => ({
        source_index,
        owner: literalReferenceOwner(reference),
        reference,
      }),
    );
  })();
  return ok({
    ...shared,
    ...context,
    kind: "native-trace" as const,
    view,
    items: rows.rows,
    coverage: pageViewCoverage(view.offset, rows.rows.length, rows.total),
  });
};
