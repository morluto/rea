import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { evmInterfaceSchema } from "../evm/evmInterface.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
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
import { analysisTextPage } from "./analysisViewText.js";

/** Retained inferred candidates or exact text; offsets for text count UTF-16 code units. */
export const evmViewRequestSchema = z.strictObject({
  kind: z.literal("evm"),
  facet: z.enum(["functions", "bytecode_hex", "stdout", "stderr"]),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
});

export const evmViewItemSchema = z.union([
  evmInterfaceSchema.shape.functions,
  z.strictObject({ text: z.string(), unit: z.literal("utf16-code-units") }),
]);

/** Complete inferred interface facts without the unrequested hex or duplicated stdout. */
export const evmSummarySchema = z.strictObject({
  artifact: evmInterfaceSchema.shape.artifact,
  bytecode: evmInterfaceSchema.shape.bytecode.omit({ hex: true }),
  evidence_kind: evmInterfaceSchema.shape.evidence_kind,
  functions: evmInterfaceSchema.shape.functions,
  discovery_completeness: evmInterfaceSchema.shape.discovery_completeness,
  runtime_execution: evmInterfaceSchema.shape.runtime_execution,
  diagnostics: evmInterfaceSchema.shape.diagnostics
    .omit({ stdout: true })
    .extend({
      stdout_code_units: z.number().int().nonnegative(),
    }),
  limitations: evmInterfaceSchema.shape.limitations,
});

/** Select already authenticated producer facts; no interpreter or provider is invoked. */
export const projectEvmInterfaceView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "evm")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message: "EVM Evidence supports summary and evm views.",
        },
      ]),
    );
  const parsed = evmInterfaceSchema.safeParse(parent.normalizedResult);
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
    parent.subject == null ||
    parent.subject.format !== "file" ||
    parent.subject.local_path !== report.artifact.path ||
    parent.subject.digest.sha256 !== report.artifact.sha256
  )
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message:
            "EVM parent subject must identify the report's exact carrier path and SHA-256.",
        },
      ]),
    );
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_evm_interface" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations: uniqueSorted([...parent.limitations, ...report.limitations]),
    unknowns: [
      "Candidates remain inferred; discovery completeness, bytecode kind, hardfork and deployment authenticity are unknown. Runtime execution was not performed.",
    ],
  };
  if (view.kind === "summary") {
    const { hex: _hex, ...bytecode } = report.bytecode;
    const { stdout, ...diagnostics } = report.diagnostics;
    return ok({
      kind: "summary",
      view,
      ...shared,
      summary: {
        artifact: report.artifact,
        bytecode,
        evidence_kind: report.evidence_kind,
        functions: report.functions,
        discovery_completeness: report.discovery_completeness,
        runtime_execution: report.runtime_execution,
        diagnostics: { ...diagnostics, stdout_code_units: stdout.length },
        limitations: report.limitations,
      },
      coverage: completeWithinViewCoverage(
        report.functions.length,
        report.functions.length,
      ),
    });
  }
  if (view.facet === "functions") {
    const item = report.functions.slice(view.offset, view.offset + view.limit);
    return ok({
      kind: "evm",
      view,
      item,
      ...shared,
      coverage: pageViewCoverage(
        view.offset,
        item.length,
        report.functions.length,
      ),
    });
  }
  const text =
    view.facet === "bytecode_hex"
      ? report.bytecode.hex
      : report.diagnostics[view.facet];
  const page = analysisTextPage(text, view.offset, view.limit, view.facet);
  return page.ok ? ok({ kind: "evm", view, ...page.value, ...shared }) : page;
};
