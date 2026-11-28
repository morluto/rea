import { z } from "zod";
import { byteEntropySchema, type ByteEntropy } from "../native/byteEntropy.js";
import { ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";
import {
  completeWithinViewCoverage,
  selectedViewPage,
} from "./analysisViewCoverage.js";
import { selectViewRows } from "./selectViewRows.js";

/** Runs the summary lists in offset order before the byte-entropy view pages the rest. */
export const SUMMARY_RUN_LIMIT = 64;

const TOP_RUN_LIMIT = 10;

/**
 * Index pages of the retained block or run series. Blocks are contiguous and
 * block-aligned from the window start, so block index
 * `(file_offset - window.offset) / block_size` addresses any run boundary.
 */
export const byteEntropyViewRequestSchema = z.strictObject({
  kind: z.literal("byte-entropy"),
  collection: z
    .enum(["blocks", "runs"])
    .describe(
      "blocks: every fixed-size block in window order. runs: adjacent high and low runs in offset order.",
    ),
  offset: z
    .int()
    .nonnegative()
    .default(0)
    .describe(
      "Zero-based index into the collection; continue with coverage.next_offset. A block index is (file_offset - window.offset) / block_size.",
    ),
  limit: z.int().positive().default(256),
});

/** Shared facts of the parent series, without its block or run rows. */
const byteEntropyContextSchema = byteEntropySchema
  .omit({ blocks: true, runs: true, limitations: true })
  .extend({
    block_count: z.number().int().nonnegative(),
    run_count: z.number().int().nonnegative(),
  });

export const byteEntropySummarySchema = byteEntropyContextSchema.extend({
  runs: byteEntropySchema.shape.runs.describe(
    `The first ${String(SUMMARY_RUN_LIMIT)} runs in offset order; when run_count is larger, page the rest with view {kind:"byte-entropy",collection:"runs",offset:${String(SUMMARY_RUN_LIMIT)}}.`,
  ),
  top_runs: byteEntropySchema.shape.runs.describe(
    `The ${String(TOP_RUN_LIMIT)} longest runs, longest first, ties by offset.`,
  ),
});

export const byteEntropyPageContextSchema = byteEntropyContextSchema;

export const byteEntropyViewItemsSchema = z.union([
  byteEntropySchema.shape.blocks,
  byteEntropySchema.shape.runs,
]);

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

/**
 * Summarize the run map or page the retained block and run series. The
 * summary answers where high and low regions are; the view reads any block
 * range without rerunning the inspection.
 */
export const projectByteEntropyView = (
  parent: AnalysisViewParent,
  report: ByteEntropy,
  view: AdmittedView,
) => {
  if (view.kind !== "summary" && view.kind !== "byte-entropy")
    return invalidAnalysisView(
      'Byte entropy Evidence supports the summary view and view {kind:"byte-entropy",collection:"blocks"|"runs",offset,limit}.',
    );
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof byteEntropyViewRequestSchema>
  >(view, "summary", "byte-entropy");
  const context = {
    artifact: report.artifact,
    block_size: report.block_size,
    window: report.window,
    file_entropy: report.file_entropy,
    thresholds: report.thresholds,
    block_count: report.blocks.length,
    run_count: report.runs.length,
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_byte_entropy" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations: [
      ...new Set([...parent.limitations, ...report.limitations]),
    ].sort(),
    unknowns: [] as string[],
  };
  if (view.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      summary: {
        ...context,
        // The first page of the runs view; run_count tells whether more follow.
        runs: selectViewRows(
          report.runs,
          { offset: 0, limit: SUMMARY_RUN_LIMIT },
          undefined,
          (row) => row,
        ).rows,
        top_runs: topRuns(report.runs),
      },
      coverage: completeWithinViewCoverage(report.blocks.length),
    });
  const selected =
    view.collection === "blocks"
      ? selectViewRows(report.blocks, view, undefined, (row) => row)
      : selectViewRows(report.runs, view, undefined, (row) => row);
  return ok({
    ...shared,
    kind: "byte-entropy" as const,
    view,
    entropy: context,
    ...selectedViewPage(view.offset, selected),
  });
};
