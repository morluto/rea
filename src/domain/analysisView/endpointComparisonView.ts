import { z } from "zod";
import type { StaticObservedEndpointComparison } from "../javascript/staticObservedEndpointSchemas.js";
import type { JsonValue } from "../jsonValue.js";
import {
  comparedStaticEndpointSchema,
  comparedObservedGroupSchema,
  endpointMatchSchema,
  staticObservedEndpointComparisonSchema,
} from "../javascript/staticObservedEndpointSchemas.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { selectViewRows } from "./selectViewRows.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import { err, ok } from "../result.js";

const page = {
  kind: z.literal("endpoint-comparison"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
};
export const endpointComparisonViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      ...page,
      collection: z.literal("static-endpoints"),
      endpoint_ids: z
        .array(comparedStaticEndpointSchema.shape.endpoint_id)
        .optional(),
      statuses: z.array(comparedStaticEndpointSchema.shape.status).optional(),
      fields: z.array(comparedStaticEndpointSchema.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("observed-groups"),
      group_ids: z.array(comparedObservedGroupSchema.shape.group_id).optional(),
      statuses: z.array(comparedObservedGroupSchema.shape.status).optional(),
      fields: z.array(comparedObservedGroupSchema.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("matches"),
      endpoint_ids: z.array(endpointMatchSchema.shape.endpoint_id).optional(),
      group_ids: z.array(endpointMatchSchema.shape.group_id).optional(),
      fields: z.array(endpointMatchSchema.keyof()).optional(),
    }),
  ],
);
export const endpointComparisonViewItemsSchema = z.union([
  z.array(
    comparedStaticEndpointSchema
      .partial()
      .required({ endpoint_id: true, node_id: true, observation_id: true }),
  ),
  z.array(comparedObservedGroupSchema.partial().required({ group_id: true })),
  z.array(
    endpointMatchSchema
      .partial()
      .required({ match_id: true, endpoint_id: true, group_id: true }),
  ),
]);
export const endpointComparisonViewContextSchema =
  staticObservedEndpointComparisonSchema.omit({
    static_endpoints: true,
    observed_groups: true,
    matches: true,
    limitations: true,
  });
const readReport = createAnalysisViewResultReader(
  staticObservedEndpointComparisonSchema,
);
const set = (values: readonly string[] | undefined) =>
  values === undefined ? undefined : new Set(values);
const fieldsOf = (row: object, fields: readonly string[]) => {
  const source = row as Record<string, JsonValue>;
  return Object.fromEntries(fields.map((field) => [field, source[field]!]));
};

const selectComparisonRows = (
  report: StaticObservedEndpointComparison,
  view: z.output<typeof endpointComparisonViewRequestSchema>,
) => {
  const { static_endpoints, observed_groups, matches } = report;
  let selected: {
    rows: z.output<typeof endpointComparisonViewItemsSchema>;
    total: number;
  };
  if (view.collection === "static-endpoints") {
    const ids = set(view.endpoint_ids),
      statuses = set(view.statuses);
    selected = selectViewRows(
      static_endpoints,
      view,
      (row) =>
        (ids === undefined || ids.has(row.endpoint_id)) &&
        (statuses === undefined || statuses.has(row.status)),
      (row) => ({
        ...fieldsOf(
          row,
          view.fields ?? [
            "method",
            "method_basis",
            "origin",
            "origin_basis",
            "path",
            "status",
            "reason",
          ],
        ),
        endpoint_id: row.endpoint_id,
        node_id: row.node_id,
        observation_id: row.observation_id,
      }),
    );
  } else if (view.collection === "observed-groups") {
    const ids = set(view.group_ids),
      statuses = set(view.statuses);
    selected = selectViewRows(
      observed_groups,
      view,
      (row) =>
        (ids === undefined || ids.has(row.group_id)) &&
        (statuses === undefined || statuses.has(row.status)),
      (row) => ({
        ...fieldsOf(
          row,
          view.fields ?? [
            "method",
            "origin",
            "path_template",
            "status",
            "reason",
          ],
        ),
        group_id: row.group_id,
      }),
    );
  } else {
    const endpoints = set(view.endpoint_ids),
      groups = set(view.group_ids);
    selected = selectViewRows(
      matches,
      view,
      (row) =>
        (endpoints === undefined || endpoints.has(row.endpoint_id)) &&
        (groups === undefined || groups.has(row.group_id)),
      (row) => ({
        ...fieldsOf(row, view.fields ?? ["basis", "supporting_record_ordinal"]),
        match_id: row.match_id,
        endpoint_id: row.endpoint_id,
        group_id: row.group_id,
      }),
    );
  }
  return selected;
};

/** Page completed classifications; filters never reclassify a subset or upgrade source coverage. */
export const projectEndpointComparisonView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<
    SummaryAnalysisView | z.output<typeof endpointComparisonViewRequestSchema>
  >(admitted, "summary", "endpoint-comparison");
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Endpoint comparisons support summary and endpoint-comparison pages",
        },
      ]),
    );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const {
    static_endpoints: _static,
    observed_groups: _observed,
    matches: _matches,
    limitations,
    ...context
  } = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "compare_static_and_observed_endpoints" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: null,
    limitations: boundedViewMessages(
      [...parent.limitations, ...limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns:
      parsed.value.summary.unknown > 0
        ? [
            "Some static endpoint observations cannot be classified; page static-endpoints with status unknown for their reasons.",
          ]
        : [],
  };
  if (view.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      summary: context,
      coverage: completeWithinViewCoverage(1, 1),
    });
  const selected = selectComparisonRows(parsed.value, view);
  return ok({
    ...shared,
    ...context,
    kind: "endpoint-comparison" as const,
    view,
    items: selected.rows,
    coverage: pageViewCoverage(
      view.offset,
      selected.rows.length,
      selected.total,
    ),
  });
};
