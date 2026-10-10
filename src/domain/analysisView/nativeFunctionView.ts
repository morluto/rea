import type { AnalysisError } from "../analysisErrorBase.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import type { FunctionDossier } from "../hopperValues.js";
import { jsonValueSchema } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import {
  analysisViewInputError,
  type AnalysisViewCoverage,
  type AnalysisViewParent,
  type AnalysisViewRequest,
  type UnsignedAnalysisView,
} from "./analysisView.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

type Artifact = { readonly path: string; readonly sha256: string };

const viewError = (message: string): AnalysisError =>
  analysisViewInputError([
    { path: ["view"], reason: "invalid_value", message },
  ]);

const parentFields = (
  parent: AnalysisViewParent,
  dossier: FunctionDossier,
  artifact: Artifact,
) => {
  const flow = dossier.native_value_flow;
  const api = dossier.native_api;
  const unknowns: string[] = [];
  if (flow === null) unknowns.push("native_value_flow was not recorded");
  else if (!flow.available)
    unknowns.push("native_value_flow unavailable: " + flow.reason);
  else if (flow.truncated)
    unknowns.push(
      "native_value_flow is truncated; omitted observations remain unknown",
    );
  if (api === null) unknowns.push("native_api was not recorded");
  else if (!api.available)
    unknowns.push(
      "native_api unavailable: " + api.reason,
      ...api.residual_unknowns,
    );
  return {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "analyze_function" as const,
    parent_digest: parent.evidenceId.slice(3),
    procedure_address: dossier.procedure.address,
    artifact,
    limitations: uniqueSorted([
      ...parent.limitations,
      ...dossier.limitations,
      ...(flow?.limitations ?? []),
      ...(api?.available ? api.limitations : []),
    ]),
    unknowns: uniqueSorted(unknowns),
  };
};

const pseudocodePage = (
  body: string,
  offset: number,
  limit: number,
): Result<
  {
    readonly item: { readonly text: string; readonly unit: "utf16-code-units" };
    readonly coverage: AnalysisViewCoverage;
  },
  AnalysisError
> => {
  const start = Math.min(offset, body.length);
  const high = (n: number) => n >= 0xd800 && n <= 0xdbff;
  const low = (n: number) => n >= 0xdc00 && n <= 0xdfff;
  if (
    start > 0 &&
    start < body.length &&
    high(body.charCodeAt(start - 1)) &&
    low(body.charCodeAt(start))
  )
    return err(viewError("Pseudocode offset splits a UTF-16 surrogate pair."));
  let end = Math.min(start + limit, body.length);
  if (
    end > start &&
    end < body.length &&
    high(body.charCodeAt(end - 1)) &&
    low(body.charCodeAt(end))
  )
    end--;
  if (end === start && start < body.length)
    return err(
      viewError(
        "Increase pseudocode limit to include the next complete Unicode character.",
      ),
    );
  return ok({
    item: { text: body.slice(start, end), unit: "utf16-code-units" },
    coverage: pageViewCoverage(start, end - start, body.length),
  });
};

const nativeRows = (
  dossier: FunctionDossier,
  facet: Exclude<
    Extract<AnalysisViewRequest, { readonly kind: "native" }>["facet"],
    "procedure" | "pseudocode" | "native_api" | "value_flow_summary"
  >,
): readonly unknown[] | undefined => {
  const sourceFlow = dossier.native_value_flow;
  const flow = sourceFlow?.available ? sourceFlow : undefined;
  return {
    assembly: dossier.assembly,
    basic_blocks: dossier.basic_blocks,
    comments: dossier.comments,
    callers: dossier.callers,
    callees: dossier.callees,
    incoming_references: dossier.incoming_references,
    outgoing_references: dossier.outgoing_references,
    unresolved_calls: dossier.unresolved_calls,
    referenced_strings: dossier.referenced_strings,
    referenced_names: dossier.referenced_names,
    value_flow_operations: flow?.operations,
    value_flow_def_use: flow?.def_use,
    value_flow_effects: flow?.effects,
    value_flow_parameters: flow?.parameters,
    value_flow_parameter_uses: flow?.parameter_uses,
  }[facet];
};

/** Project bounded native function facets from complete retained Evidence without reanalysis. */
export const projectNativeFunctionView = (
  parent: AnalysisViewParent,
  dossier: FunctionDossier,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "native")
    return err(viewError("analyze_function Evidence requires a native view."));
  const artifact = parent.artifact;
  if (!artifact)
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message:
            "Native function Evidence requires an artifact-bound subject.",
        },
      ]),
    );
  const common = parentFields(parent, dossier, artifact);
  const singleton = (item: unknown): UnsignedAnalysisView => ({
    kind: "native",
    view,
    item: jsonValueSchema.parse(item),
    coverage: completeWithinViewCoverage(1, 1),
    ...common,
  });
  const flow = dossier.native_value_flow;
  if (
    view.facet === "procedure" ||
    view.facet === "native_api" ||
    view.facet === "value_flow_summary"
  ) {
    if (view.offset !== 0)
      return err(viewError("Singleton native facets require offset 0."));
    if (view.facet === "procedure") return ok(singleton(dossier.procedure));
    if (view.facet === "native_api")
      return ok(
        singleton(
          dossier.native_api ?? { available: false, reason: "not recorded" },
        ),
      );
    const status =
      flow === null
        ? { available: false, reason: "not recorded" }
        : !flow.available
          ? { available: false, reason: flow.reason }
          : {
              available: true,
              provenance: flow.provenance,
              truncated: flow.truncated,
              omitted_operations_lower_bound:
                flow.omitted_operations_lower_bound,
              known_omitted_inputs: flow.known_omitted_inputs,
              known_omitted_edges: flow.known_omitted_edges,
              operations: flow.operations.length,
              def_use: flow.def_use.length,
              effects: flow.effects.length,
              parameters: flow.parameters.length,
              parameter_uses: flow.parameter_uses.length,
            };
    return ok(singleton(status));
  }
  if (view.facet === "pseudocode") {
    const page = pseudocodePage(dossier.pseudocode, view.offset, view.limit);
    return page.ok
      ? ok({ kind: "native", view, ...page.value, ...common })
      : page;
  }
  const rows = nativeRows(dossier, view.facet);
  if (rows === undefined)
    return ok(
      singleton({
        available: false,
        // Only value-flow facets inherit the value-flow failure reason; an
        // older dossier simply has no unresolved_calls record.
        reason:
          view.facet.startsWith("value_flow_") && flow?.available === false
            ? flow.reason
            : "not recorded",
      }),
    );
  const items = rows.slice(view.offset, view.offset + view.limit);
  return ok({
    kind: "native",
    view,
    item: jsonValueSchema.parse(items),
    coverage: pageViewCoverage(view.offset, items.length, rows.length),
    ...common,
  });
};
