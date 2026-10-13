import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { err, ok, type Result } from "../result.js";
import {
  wasmArtifactSchema,
  wasmArtifactMatchesSubject,
} from "../wasm/wasmArtifact.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
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
import { analysisTextPage } from "./analysisViewText.js";

/** Source forms and text from completed WASM Evidence; this never executes a VM. */
export const wasmViewRequestSchema = z.strictObject({
  kind: z.literal("wasm"),
  facet: z.enum([
    "sections",
    "imports",
    "exports",
    "candidates",
    "glue",
    "wat",
    "headers",
    "details",
    "tool_profile",
  ]),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
});

export const wasmViewItemSchema = z.union([
  wasmArtifactSchema.shape.sections,
  wasmArtifactSchema.shape.imports,
  wasmArtifactSchema.shape.candidates,
  wasmArtifactSchema.shape.glue,
  wasmArtifactSchema.shape.tool_profile,
  z.strictObject({ text: z.string(), unit: z.literal("utf16-code-units") }),
]);

/** Counts are observations of the completed producer, independent of runtime semantics. */
export const wasmSummarySchema = z.strictObject({
  bytes: wasmArtifactSchema.shape.artifact.shape.bytes,
  validation: wasmArtifactSchema.shape.validation,
  available_counts: z.strictObject({
    sections: z.number().int().nonnegative(),
    imports: z.number().int().nonnegative(),
    exports: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    glue: z.number().int().nonnegative(),
  }),
  wat: wasmArtifactSchema.shape.wat
    .omit({ text: true })
    .extend({ code_units: z.number().int().nonnegative() }),
  tool_profile: wasmArtifactSchema.shape.tool_profile,
  runtime_execution: wasmArtifactSchema.shape.runtime_execution,
  network_fetch: wasmArtifactSchema.shape.network_fetch,
  limitation_count: z.number().int().nonnegative(),
});

/** Read the exact retained WABT forms with source identity and explicit uncertainty. */
export const projectWasmArtifactView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "wasm")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message: "WASM Evidence supports summary and wasm views.",
        },
      ]),
    );
  const parsed = wasmArtifactSchema.safeParse(parent.normalizedResult);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        "inspect_analysis_view",
        parsed.error.issues.map((issue) => ({
          ...issue,
          path: ["source", "normalized_result", ...issue.path],
        })),
        { source: { normalized_result: parent.normalizedResult } },
        { cause: parsed.error },
      ),
    );
  const report = parsed.data;
  if (
    !wasmArtifactMatchesSubject(
      report.artifact,
      parent.subject == null
        ? null
        : {
            path: parent.subject.local_path,
            sha256: parent.subject.digest.sha256,
            format: parent.subject.format,
          },
    )
  )
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message:
            "WASM parent Evidence subject must identify the report's exact path and SHA-256.",
        },
      ]),
    );
  const limitations = uniqueSorted([
    ...parent.limitations,
    ...report.limitations,
  ]);
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_wasm_artifact" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations,
    unknowns: [
      "Decoded WAT is not original source. Runtime behavior and network acquisition were not performed.",
      ...(report.glue.some((glue) => glue.parse_status !== "complete")
        ? [
            "Selected glue parsing is incomplete; unmatched references do not establish absence.",
          ]
        : []),
    ],
  };
  if (view.kind === "summary")
    return ok({
      kind: "summary",
      view,
      ...shared,
      summary: {
        bytes: report.artifact.bytes,
        validation: report.validation,
        available_counts: {
          sections: report.sections.length,
          imports: report.imports.length,
          exports: report.exports.length,
          candidates: report.candidates.length,
          glue: report.glue.length,
        },
        wat: {
          sha256: report.wat.sha256,
          representation: report.wat.representation,
          code_units: report.wat.text.length,
        },
        tool_profile: report.tool_profile,
        runtime_execution: report.runtime_execution,
        network_fetch: report.network_fetch,
        limitation_count: limitations.length,
      },
      coverage: completeWithinViewCoverage(
        report.sections.length + report.imports.length + report.exports.length,
        report.sections.length + report.imports.length + report.exports.length,
      ),
    });
  if (view.facet === "tool_profile") {
    if (view.offset !== 0)
      return err(
        analysisViewInputError([
          {
            path: ["view", "offset"],
            reason: "invalid_value",
            message: "Singleton tool_profile requires offset 0.",
          },
        ]),
      );
    return ok({
      kind: "wasm",
      view,
      item: report.tool_profile,
      coverage: completeWithinViewCoverage(1, 1),
      ...shared,
    });
  }
  if (
    view.facet === "wat" ||
    view.facet === "headers" ||
    view.facet === "details"
  ) {
    const text = view.facet === "wat" ? report.wat.text : report[view.facet];
    const page = analysisTextPage(text, view.offset, view.limit, view.facet);
    return page.ok
      ? ok({ kind: "wasm", view, ...page.value, ...shared })
      : page;
  }
  const rows = report[view.facet];
  const item = rows.slice(view.offset, view.offset + view.limit);
  return ok({
    kind: "wasm",
    view,
    item,
    coverage: pageViewCoverage(view.offset, item.length, rows.length),
    ...shared,
  });
};
