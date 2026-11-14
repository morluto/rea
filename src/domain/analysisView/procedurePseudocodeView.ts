import { z } from "zod";

import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import { err, ok } from "../result.js";
import {
  parseAnalysisViewResult,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type NativeFacetAnalysisView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import { completeWithinViewCoverage } from "./analysisViewCoverage.js";
import { analysisTextPage } from "./analysisViewText.js";
import { procedurePseudocodeSelectionSchema } from "./procedurePseudocodeSchemas.js";

const unavailable = {
  available: false as const,
  reason: "Provider returned null" as const,
};

/** Project the original scalar observation, never another decompilation or a synthetic dossier. */
export const projectProcedurePseudocodeView = (
  parent: AnalysisViewParent,
  request: AdmittedView,
) => {
  const view = ownedView<SummaryAnalysisView | NativeFacetAnalysisView>(
    request,
    "summary",
    "native",
  );
  if (
    view === undefined ||
    (view.kind === "native" && view.facet !== "pseudocode")
  )
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "procedure_pseudo_code Evidence supports summary or native pseudocode views.",
        },
      ]),
    );
  if (parent.artifact == null)
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message: "Pseudocode Evidence requires an artifact-bound subject.",
        },
      ]),
    );
  const parsed = parseAnalysisViewResult(z.string().nullable(), parent);
  if (!parsed.ok) return parsed;
  const selection = procedurePseudocodeSelectionSchema.safeParse(
    parent.parameters,
  );
  if (!selection.success)
    return err(
      analysisInputErrorFromIssues(
        "inspect_analysis_view",
        selection.error.issues.map((issue) => ({
          ...issue,
          path: ["source", "parameters", ...issue.path],
        })),
        { source: { parameters: parent.parameters } },
        { cause: selection.error },
      ),
    );
  const text = parsed.value;
  const common = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "procedure_pseudo_code" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact,
    limitations: [...parent.limitations],
    unknowns:
      text === null
        ? [
            "Provider returned null; this does not establish absence of a function.",
          ]
        : [],
  };
  if (view.kind === "summary")
    return ok({
      kind: "summary" as const,
      view,
      ...common,
      summary: {
        selection: selection.data,
        pseudocode:
          text === null
            ? unavailable
            : {
                available: true as const,
                code_units: text.length,
                unit: "utf16-code-units" as const,
              },
      },
      coverage: completeWithinViewCoverage(1, 1),
    });
  if (text === null)
    return ok({
      kind: "native" as const,
      view,
      ...common,
      procedure_address: null,
      item: unavailable,
      coverage: completeWithinViewCoverage(1, 1),
    });
  const page = analysisTextPage(text, view.offset, view.limit);
  return page.ok
    ? ok({
        kind: "native" as const,
        view,
        ...common,
        procedure_address: null,
        ...page.value,
      })
    : page;
};
