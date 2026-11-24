import { z } from "zod";
import { AnalysisInputError } from "../analysisErrorCore.js";
import { byteEntropySchema, type ByteEntropy } from "../native/byteEntropy.js";
import { err, ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  assertOwnedView,
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { viewResultBaseFields } from "./analysisViewBase.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

export const byteEntropyBlocksViewRequestSchema = z.strictObject({
  kind: z.literal("byte-entropy-blocks"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().max(256).default(64),
});

export const byteEntropyBlocksViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  kind: z.literal("byte-entropy-blocks"),
  parent_operation: z.literal("inspect_byte_entropy"),
  view: byteEntropyBlocksViewRequestSchema,
  items: byteEntropySchema.shape.blocks,
});

export const byteEntropySummarySchema = byteEntropySchema
  .omit({ blocks: true, runs: true, limitations: true })
  .extend({
    block_count: z.number().int().nonnegative(),
    run_count: z.number().int().nonnegative(),
    top_runs: byteEntropySchema.shape.runs,
  });

const TOP_RUN_LIMIT = 10;

type EntropyRun = ByteEntropy["runs"][number];

const compareRuns = (a: EntropyRun, b: EntropyRun): number =>
  b.length - a.length || a.offset - b.offset;

const topRuns = (runs: readonly EntropyRun[]): EntropyRun[] => {
  const retained: EntropyRun[] = [];
  for (const run of runs) {
    const last = retained[TOP_RUN_LIMIT - 1];
    if (last !== undefined && compareRuns(run, last) >= 0) continue;
    let index = retained.length;
    while (index > 0 && compareRuns(run, retained[index - 1]!) < 0) index -= 1;
    retained.splice(index, 0, run);
    if (retained.length > TOP_RUN_LIMIT) retained.pop();
  }
  return retained;
};

/** Summarize runs or select consecutive block rows from the same retained report. */
export const projectByteEntropyView = (
  parent: AnalysisViewParent,
  report: ByteEntropy,
  view: AdmittedView,
) => {
  const source = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_byte_entropy" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    unknowns: [] as string[],
  };
  const limitations = [...parent.limitations, ...report.limitations];
  const page = ownedView<z.output<typeof byteEntropyBlocksViewRequestSchema>>(
    view,
    "byte-entropy-blocks",
  );
  if (page !== undefined) {
    const items = report.blocks.slice(page.offset, page.offset + page.limit);
    return ok({
      ...source,
      kind: "byte-entropy-blocks" as const,
      view: page,
      items,
      coverage: pageViewCoverage(
        page.offset,
        items.length,
        report.blocks.length,
      ),
      limitations: boundedViewMessages(
        limitations,
        parent.evidenceId,
        "limitations",
      ),
    });
  }
  if (view.kind !== "summary")
    return err(
      new AnalysisInputError("inspect_analysis_view", undefined, [
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Byte entropy Evidence supports summary and byte-entropy-blocks views.",
        },
      ]),
    );
  assertOwnedView<SummaryAnalysisView>(view, "summary");
  return ok({
    ...source,
    kind: "summary" as const,
    view,
    summary: {
      artifact: report.artifact,
      block_size: report.block_size,
      window: report.window,
      file_entropy: report.file_entropy,
      thresholds: report.thresholds,
      block_count: report.blocks.length,
      run_count: report.runs.length,
      top_runs: topRuns(report.runs),
    },
    coverage: completeWithinViewCoverage(report.blocks.length),
    limitations: [...new Set(limitations)].sort(),
  });
};
