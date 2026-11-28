import { z } from "zod";

import { evidenceSubjectTarget } from "../evidence.js";
import { ok } from "../result.js";
import { vsixRegistrationCorrelationSchema } from "../vsix/vsixRegistrationCorrelation.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";
import {
  boundedViewLimitations,
  completeWithinViewCoverage,
} from "./analysisViewCoverage.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";

/** Counts only; command rows and source positions stay in the complete parent. */
export const vsixRegistrationCorrelationSummarySchema =
  vsixRegistrationCorrelationSchema
    .pick({
      summary: true,
      source_evidence: true,
      semantic_graph_truncated: true,
    })
    .extend({
      command_count: z.int().nonnegative(),
      menu_count: z.int().nonnegative().nullable(),
      entry_point_count: z.int().nonnegative(),
      unanalyzed_entry_point_count: z.int().nonnegative(),
      limitation_count: z.int().nonnegative(),
    });

const readCorrelation = createAnalysisViewResultReader(
  vsixRegistrationCorrelationSchema,
);

/** Summarize a retained correlation without recomputing it. */
export const projectVsixRegistrationCorrelationView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<SummaryAnalysisView>(admitted, "summary");
  if (view === undefined)
    return invalidAnalysisView(
      "VS Code registration correlation Evidence supports the summary view.",
    );
  const parsed = readCorrelation(parent);
  if (!parsed.ok) return parsed;
  const result = parsed.value;
  // The correlation's subject is the selected package.
  const target = evidenceSubjectTarget(parent.subject);
  if (target === undefined)
    return invalidAnalysisView(
      "VS Code registration correlation Evidence names no local package.",
    );
  return ok({
    parent_evidence_id: parent.evidenceId,
    parent_operation: "correlate_vsix_registrations" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: target.path, sha256: target.sha256 },
    limitations: boundedViewLimitations(parent, result.limitations, []),
    unknowns: [],
    kind: "summary" as const,
    view,
    summary: {
      summary: result.summary,
      source_evidence: result.source_evidence,
      semantic_graph_truncated: result.semantic_graph_truncated,
      command_count: result.commands.length,
      menu_count: result.menus?.length ?? null,
      entry_point_count: result.entry_points.length,
      unanalyzed_entry_point_count: result.entry_points.filter(
        ({ analyzed }) => !analyzed,
      ).length,
      limitation_count: result.limitations.length,
    },
    coverage: completeWithinViewCoverage(result.commands.length),
  });
};
