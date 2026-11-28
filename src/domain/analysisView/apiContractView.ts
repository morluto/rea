import { graphqlContractSchema } from "../apiContract/graphqlContract.js";
import { projectGraphqlContractView } from "./graphqlContractView.js";
import { z } from "zod";
import {
  apiContractSchema,
  apiContractOperationSchema,
  apiContractPathReferenceSchema,
  apiContractDiagnosticSchema,
  API_CONTRACT_OPERATION,
  type ApiContract,
} from "../apiContract/apiContract.js";
import { apiContractViewRequestSchema } from "../apiContract/apiContractQuery.js";
import { ok } from "../result.js";
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
  boundedViewLimitations,
  completeWithinViewCoverage,
  selectedViewPage,
} from "./analysisViewCoverage.js";
import { pickFields, selectViewRows, filterSet } from "./selectViewRows.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";

export const apiContractViewContextSchema = apiContractSchema.omit({
  operations: true,
  path_item_references: true,
  diagnostics: true,
  limitations: true,
});
export const apiContractViewItemsSchema = z.union([
  z.array(
    apiContractOperationSchema.partial().required({
      operation_id: true,
      operation_key: true,
      source_pointer: true,
      state: true,
      reason: true,
    }),
  ),
  z.array(
    apiContractPathReferenceSchema.partial().required({
      reference_id: true,
      source_pointer: true,
      state: true,
      credential_redacted: true,
    }),
  ),
  z.array(
    apiContractDiagnosticSchema
      .partial()
      .required({ diagnostic_id: true, source_pointer: true, code: true }),
  ),
]);
const readReport = createAnalysisViewResultReader(
  z.union([apiContractSchema, graphqlContractSchema]),
);
const admits = (selection: ReadonlySet<string> | undefined, value: string) =>
  selection === undefined || selection.has(value);
const selectOperations = (
  report: ApiContract,
  view: Extract<
    z.output<typeof apiContractViewRequestSchema>,
    { collection: "operations" }
  >,
) => {
  const ids = filterSet(view.operation_ids),
    keys = filterSet(view.operation_keys),
    methods = filterSet(view.methods),
    paths = filterSet(view.paths),
    declared = filterSet(view.declared_ids),
    states = filterSet(view.states);
  const filtered =
    ids !== undefined ||
    keys !== undefined ||
    methods !== undefined ||
    paths !== undefined ||
    declared !== undefined ||
    states !== undefined;
  const fields = view.fields ?? ["method", "path", "declared_id"];
  return selectViewRows(
    report.operations,
    view,
    filtered
      ? (row) =>
          admits(ids, row.operation_id) &&
          admits(keys, row.operation_key) &&
          admits(methods, row.method) &&
          admits(paths, row.path) &&
          admits(states, row.state) &&
          (declared === undefined ||
            (row.declared_id !== null && declared.has(row.declared_id)))
      : undefined,
    (row) => ({
      ...pickFields(row, fields),
      operation_id: row.operation_id,
      operation_key: row.operation_key,
      source_pointer: row.source_pointer,
      state: row.state,
      reason: row.reason,
    }),
  );
};

const selectRows = (
  report: ApiContract,
  view: z.output<typeof apiContractViewRequestSchema>,
) => {
  if (view.collection === "operations") return selectOperations(report, view);
  if (view.collection === "path-item-references") {
    const ids = filterSet(view.reference_ids);
    const fields = view.fields ?? ["path", "reference"];
    return selectViewRows(
      report.path_item_references,
      view,
      ids === undefined ? undefined : (row) => ids.has(row.reference_id),
      (row) => ({
        ...pickFields(row, fields),
        reference_id: row.reference_id,
        source_pointer: row.source_pointer,
        state: row.state,
        credential_redacted: row.credential_redacted,
      }),
    );
  }
  const codes = filterSet(view.codes);
  const fields = view.fields ?? ["message"];
  return selectViewRows(
    report.diagnostics,
    view,
    codes === undefined ? undefined : (row) => codes.has(row.code),
    (row) => ({
      ...pickFields(row, fields),
      diagnostic_id: row.diagnostic_id,
      source_pointer: row.source_pointer,
      code: row.code,
    }),
  );
};

/** Queries borrow completed declarations; an exhausted page never upgrades source completeness. */
export const projectApiContractView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  if (parsed.value.format === "graphql-sdl")
    return projectGraphqlContractView(parent, admitted, parsed.value);
  const view = ownedView<
    SummaryAnalysisView | z.output<typeof apiContractViewRequestSchema>
  >(admitted, "summary", "api-contract");
  if (view === undefined)
    return invalidAnalysisView(
      "API contract inventories support summary and api-contract pages.",
    );
  const {
    operations: _operations,
    path_item_references: _references,
    diagnostics: _diagnostics,
    limitations,
    ...context
  } = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: API_CONTRACT_OPERATION,
    parent_digest: parent.evidenceId.slice(3),
    limitations: boundedViewLimitations(parent, limitations),
    unknowns:
      context.source_coverage.status === "partial"
        ? [
            "This inventory is partial. Inspect limitations for coverage and query path-item-references and diagnostics for any retained source pointers.",
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
      coverage: completeWithinViewCoverage(1),
    });
  const selected = selectRows(parsed.value, view);
  return ok({
    ...shared,
    ...context,
    kind: "api-contract" as const,
    view,
    ...selectedViewPage(view.offset, selected),
  });
};
