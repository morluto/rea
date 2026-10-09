import type { AnalysisError } from "../analysisErrorBase.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import type { FunctionDossier } from "../hopperValues.js";
import { jsonValueSchema } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import {
  analysisViewInputError,
  type AnalysisViewParent,
  type AnalysisViewRequest,
  type UnsignedAnalysisView,
} from "./analysisView.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

type NativeView = Extract<AnalysisViewRequest, { readonly kind: "native" }>;
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
  const unknowns: string[] = [];
  if (flow === null) unknowns.push("native_value_flow was not recorded");
  else if (!flow.available)
    unknowns.push("native_value_flow unavailable: " + flow.reason);
  else if (flow.truncated)
    unknowns.push(
      "native_value_flow is truncated; omitted observations remain unknown",
    );
  if (dossier.native_api?.available === false)
    unknowns.push("native_api unavailable: " + dossier.native_api.reason);
  return {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "analyze_function" as const,
    parent_digest: parent.evidenceId.slice(3),
    procedure_address: dossier.procedure.address || null,
    artifact,
    limitations: uniqueSorted([
      ...parent.limitations,
      ...dossier.limitations,
      ...(flow?.limitations ?? []),
    ]),
    unknowns: uniqueSorted(unknowns),
  };
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
  if (view.facet === "procedure" || view.facet === "value_flow_summary") {
    if (view.offset !== 0)
      return err(viewError("Singleton native facets require offset 0."));
    if (view.facet === "procedure") return ok(singleton(dossier.procedure));
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
    const body = dossier.pseudocode;
    const start = Math.min(view.offset, body.length);
    const high = (n: number) => n >= 0xd800 && n <= 0xdbff;
    const low = (n: number) => n >= 0xdc00 && n <= 0xdfff;
    if (
      start > 0 &&
      start < body.length &&
      high(body.charCodeAt(start - 1)) &&
      low(body.charCodeAt(start))
    )
      return err(
        viewError("Pseudocode offset splits a UTF-16 surrogate pair."),
      );
    let end = Math.min(start + view.limit, body.length);
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
      kind: "native",
      view,
      item: { text: body.slice(start, end), unit: "utf16-code-units" },
      coverage: pageViewCoverage(start, end - start, body.length),
      ...common,
    });
  }
  const rows = (() => {
    switch (view.facet) {
      case "assembly":
        return dossier.assembly;
      case "callers":
        return dossier.callers;
      case "callees":
        return dossier.callees;
      case "incoming_references":
        return dossier.incoming_references;
      case "outgoing_references":
        return dossier.outgoing_references;
      case "value_flow_operations":
        return flow?.available ? flow.operations : null;
      case "value_flow_def_use":
        return flow?.available ? flow.def_use : null;
      case "value_flow_effects":
        return flow?.available ? flow.effects : null;
      case "value_flow_parameters":
        return flow?.available ? flow.parameters : null;
      case "value_flow_parameter_uses":
        return flow?.available ? flow.parameter_uses : null;
    }
  })();
  if (rows === null)
    return ok(
      singleton({
        available: false,
        reason: flow?.available === false ? flow.reason : "not recorded",
      }),
    );
  if (rows === undefined) return err(viewError("Unknown native facet."));
  const items = rows.slice(view.offset, view.offset + view.limit);
  return ok({
    kind: "native",
    view,
    item: jsonValueSchema.parse(items),
    coverage: pageViewCoverage(view.offset, items.length, rows.length),
    ...common,
  });
};
