import { z } from "zod";
import { literalFeatureMatchSchema } from "../native/literalFeatureMatch.js";
import {
  literalFeatureReferenceSchema,
  literalFeatureTraceSchema,
} from "../native/literalFeatureTrace.js";
import { jsonValueSchema } from "../jsonValue.js";
import { err, ok } from "../result.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import { selectViewRows } from "./selectViewRows.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

const page = {
  kind: z.literal("native-feature-trace"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
};
export const nativeFeatureTraceRequests = {
  matches: z.strictObject({
    ...page,
    collection: z.literal("matches"),
    address: z
      .string()
      .min(1)
      .optional()
      .describe("Select rows with this exact retained address."),
  }),
  references: z.strictObject({
    ...page,
    collection: z.literal("references"),
    source_address: z
      .string()
      .min(1)
      .optional()
      .describe("Select this exact retained source address."),
    target_address: z
      .string()
      .min(1)
      .optional()
      .describe("Select this exact retained target address."),
  }),
  unknowns: z.strictObject({ ...page, collection: z.literal("unknowns") }),
} as const;
export const nativeFeatureTraceViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    nativeFeatureTraceRequests.matches,
    nativeFeatureTraceRequests.references,
    nativeFeatureTraceRequests.unknowns,
  ],
);

const row = <T extends z.ZodType>(value: T) =>
  z.strictObject({ source_index: z.int().nonnegative(), value });
export const nativeFeatureTraceViewItems = {
  matches: z.strictObject({
    collection: z.literal("matches"),
    rows: z.array(row(literalFeatureMatchSchema)),
  }),
  references: z.strictObject({
    collection: z.literal("references"),
    rows: z.array(row(literalFeatureReferenceSchema)),
  }),
  unknowns: z.strictObject({
    collection: z.literal("unknowns"),
    rows: z.array(row(z.string())),
  }),
} as const;
export const nativeFeatureTraceSummarySchema = z.strictObject({
  query: z.string(),
  search_mode: z.literal("literal"),
  matches: z.int().nonnegative(),
  references: z.int().nonnegative(),
  unknowns: z.int().nonnegative(),
  truncated: z.boolean(),
});

const readTrace = createAnalysisViewResultReader(literalFeatureTraceSchema);

/** Page retained trace rows without collapsing independently resolvable unknowns. */
export const projectNativeFeatureTraceView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (view.kind !== "summary" && view.kind !== "native-feature-trace")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Native feature traces support summary and native-feature-trace views.",
        },
      ]),
    );
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof nativeFeatureTraceViewRequestSchema>
  >(view, "summary", "native-feature-trace");
  const parsed = readTrace(parent);
  if (!parsed.ok) return parsed;
  const trace = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "trace_feature" as const,
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
    unknowns: [
      "Page coverage describes retained trace rows, not completeness of provider discovery. See the retained unknowns and source Evidence for limitations.",
    ],
    summary: {
      query: trace.query,
      search_mode: trace.search_mode,
      matches: trace.matches.length,
      references: trace.references.length,
      unknowns: trace.residual_unknowns.length,
      truncated: trace.truncated,
    },
  };
  if (view.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      coverage: completeWithinViewCoverage(
        trace.matches.length +
          trace.references.length +
          trace.residual_unknowns.length,
        trace.matches.length +
          trace.references.length +
          trace.residual_unknowns.length,
      ),
    });
  const select = <Value>(
    values: readonly Value[],
    matches?: (value: Value) => boolean,
  ) => {
    if (matches === undefined) {
      const rows = values
        .slice(view.offset, view.offset + view.limit)
        .map((value, index) => ({ source_index: view.offset + index, value }));
      return {
        rows,
        coverage: pageViewCoverage(view.offset, rows.length, values.length),
      };
    }
    const { rows, total } = selectViewRows(
      values,
      view,
      matches,
      (value, source_index) => ({ source_index, value }),
    );
    return {
      rows,
      coverage: pageViewCoverage(view.offset, rows.length, total),
    };
  };
  switch (view.collection) {
    case "matches": {
      const { rows, coverage } = select(
        trace.matches,
        view.address === undefined
          ? undefined
          : (row) => row.address === view.address,
      );
      return ok({
        ...shared,
        kind: "native-feature-trace" as const,
        view: { ...view, collection: "matches" as const },
        items: { collection: "matches" as const, rows },
        coverage,
      });
    }
    case "references": {
      const { rows, coverage } = select(
        trace.references,
        view.source_address === undefined && view.target_address === undefined
          ? undefined
          : (row) =>
              (view.source_address === undefined ||
                row.source_address === view.source_address) &&
              (view.target_address === undefined ||
                row.target_address === view.target_address),
      );
      return ok({
        ...shared,
        kind: "native-feature-trace" as const,
        view: { ...view, collection: "references" as const },
        items: { collection: "references" as const, rows },
        coverage,
      });
    }
    case "unknowns": {
      const { rows, coverage } = select(trace.residual_unknowns);
      return ok({
        ...shared,
        kind: "native-feature-trace" as const,
        view: { ...view, collection: "unknowns" as const },
        items: { collection: "unknowns" as const, rows },
        coverage,
      });
    }
  }
};
