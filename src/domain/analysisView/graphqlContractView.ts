import { z } from "zod";
import {
  graphqlContractSchema,
  graphqlTypeSchema,
  graphqlFieldSchema,
  graphqlDefinitionSchema,
  graphqlReferenceSchema,
  graphqlSpreadSchema,
  graphqlDiagnosticSchema,
  type GraphqlContract,
} from "../apiContract/graphqlContract.js";
import { graphqlContractViewRequestSchema } from "../apiContract/graphqlContractQuery.js";
import type { JsonValue } from "../jsonValue.js";
import { err, ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
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
import { analysisViewInputError } from "./analysisViewErrors.js";
import { selectViewRows } from "./selectViewRows.js";

export const graphqlContractViewContextSchema = graphqlContractSchema.omit({
  types: true,
  fields: true,
  definitions: true,
  references: true,
  fragment_spreads: true,
  diagnostics: true,
  limitations: true,
});
export const graphqlContractViewItemsSchema = z.union([
  z.array(
    graphqlTypeSchema.partial().required({ type_id: true, source: true }),
  ),
  z.array(
    graphqlFieldSchema
      .partial()
      .required({ field_id: true, owner_type_id: true, source: true }),
  ),
  z.array(
    graphqlDefinitionSchema
      .partial()
      .required({ definition_id: true, source: true }),
  ),
  z.array(
    graphqlReferenceSchema.partial().required({
      reference_id: true,
      definition_id: true,
      source: true,
      state: true,
      reason: true,
    }),
  ),
  z.array(
    graphqlSpreadSchema.partial().required({
      spread_id: true,
      definition_id: true,
      source: true,
      state: true,
    }),
  ),
  z.array(
    graphqlDiagnosticSchema.partial().required({
      diagnostic_id: true,
      source: true,
      source_role: true,
      code: true,
    }),
  ),
]);
type View = z.output<typeof graphqlContractViewRequestSchema>;
const values = (selected: readonly string[] | undefined) =>
  selected === undefined ? undefined : new Set(selected);

/** Scan retained facts once; allocate projections only for the selected page. */
const select = <Row extends object, Key extends keyof Row>(
  rows: readonly Row[],
  view: View,
  filters: Partial<Record<keyof Row, ReadonlySet<string> | undefined>>,
  columns: {
    readonly defaults: readonly string[];
    readonly required: readonly Key[];
  },
) => {
  const keys = [
    ...new Set<string | keyof Row>([
      ...(view.fields ?? columns.defaults),
      ...columns.required,
    ]),
  ];
  return selectViewRows(
    rows,
    view,
    (row) => {
      for (const key in filters) {
        const selected = filters[key];
        if (
          selected !== undefined &&
          (typeof row[key] !== "string" || !selected.has(row[key] as string))
        )
          return false;
      }
      return true;
    },
    (row) => {
      const source = row as Record<keyof Row, JsonValue>;
      return Object.fromEntries(
        keys.map((key) => [key, source[key as keyof Row]]),
      ) as Partial<Row> & Pick<Row, Key>;
    },
  );
};
const referenceColumns = {
  defaults: [
    "field_name",
    "response_key",
    "parent_type_name",
    "schema_field_id",
    "result_type",
    "parent_reference_id",
  ],
  required: ["reference_id", "definition_id", "source", "state", "reason"],
} as const;

const selectRows = (report: GraphqlContract, view: View) => {
  switch (view.collection) {
    case "types":
      return select(
        report.types,
        view,
        {
          type_id: values(view.type_ids),
          name: values(view.names),
        },
        {
          defaults: ["name", "kind", "extension"],
          required: ["type_id", "source"],
        },
      );
    case "fields":
      return select(
        report.fields,
        view,
        {
          field_id: values(view.field_ids),
          field_key: values(view.field_keys),
          owner_type_name: values(view.owner_type_names),
        },
        {
          defaults: ["field_key", "kind", "type_ref"],
          required: ["field_id", "owner_type_id", "source"],
        },
      );
    case "definitions":
      return select(
        report.definitions,
        view,
        {
          definition_id: values(view.definition_ids),
          name: values(view.names),
          kind: values(view.kinds),
        },
        {
          defaults: ["name", "kind", "type_condition"],
          required: ["definition_id", "source"],
        },
      );
    case "references":
      return select(
        report.references,
        view,
        {
          reference_id: values(view.reference_ids),
          definition_id: values(view.definition_ids),
          schema_field_id: values(view.schema_field_ids),
          state: values(view.states),
        },
        referenceColumns,
      );
    case "fragment-spreads":
      return select(
        report.fragment_spreads,
        view,
        {
          definition_id: values(view.definition_ids),
          name: values(view.names),
          state: values(view.states),
        },
        {
          defaults: [
            "name",
            "target_definition_id",
            "matching_definitions",
            "parent_reference_id",
          ],
          required: ["spread_id", "definition_id", "source", "state"],
        },
      );
    case "diagnostics":
      return select(
        report.diagnostics,
        view,
        {
          code: values(view.codes),
        },
        {
          defaults: ["message"],
          required: ["diagnostic_id", "source", "source_role", "code"],
        },
      );
  }
};

/** Source coverage and unknown bindings remain independent of page exhaustion. */
export const projectGraphqlContractView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
  report: GraphqlContract,
) => {
  const view = ownedView<SummaryAnalysisView | View>(
    admitted,
    "summary",
    "graphql-contract",
  );
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "GraphQL inventories support summary and graphql-contract pages.",
        },
      ]),
    );
  const {
    types: _types,
    fields: _fields,
    definitions: _definitions,
    references: _references,
    fragment_spreads: _spreads,
    diagnostics: _diagnostics,
    limitations,
    ...context
  } = report;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_api_contract" as const,
    parent_digest: parent.evidenceId.slice(3),
    limitations: boundedViewMessages(
      [...parent.limitations, ...limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns:
      context.source_coverage.status === "partial"
        ? [
            "Unresolved bindings, fragment edges or unavailable parsing/model stages limit this inventory; inspect references, fragment-spreads and diagnostics.",
          ]
        : [],
  };
  if (view.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      artifact: {
        path: context.artifact.path,
        sha256: context.artifact.sha256,
      },
      summary: context,
      coverage: completeWithinViewCoverage(1, 1),
    });
  const selected = selectRows(report, view);
  return ok({
    ...shared,
    ...context,
    view,
    items: selected.rows,
    coverage: pageViewCoverage(
      view.offset,
      selected.rows.length,
      selected.total,
    ),
  });
};
