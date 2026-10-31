import { z } from "zod";
import { nativeValueTraceSchema } from "../native/nativeValueTrace.js";
import { err, ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
} from "./analysisViewCoverage.js";

/** Counts and pagination state for a bounded native value trace page. */
export const nativeValueTraceSummarySchema = z.strictObject({
  seed: z.string(),
  target_sha256: z.string(),
  node_count: z.int().nonnegative(),
  total_nodes: z.int().nonnegative(),
  edge_count: z.int().nonnegative(),
  total_edges: z.int().nonnegative(),
  procedure_count: z.int().nonnegative(),
  unknown_count: z.int().nonnegative(),
  decompilations: z.int().nonnegative(),
  next_offset: z.int().nonnegative().nullable(),
  truncated: z.boolean(),
  limitation_count: z.int().nonnegative(),
});

const readTrace = createAnalysisViewResultReader(nativeValueTraceSchema);

/** Keep the bounded graph page and its completeness state in source Evidence. */
export const projectNativeValueTraceView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (view.kind !== "summary")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Native value trace Evidence supports the summary view; retrieve parent Evidence for graph nodes and edges.",
        },
      ]),
    );
  assertOwnedView<SummaryAnalysisView>(view, "summary");
  const parsed = readTrace(parent);
  if (!parsed.ok) return parsed;
  const trace = parsed.value;
  return ok({
    kind: "summary" as const,
    view,
    parent_evidence_id: parent.evidenceId,
    parent_operation: "trace_native_values" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact ?? null,
    summary: {
      seed: trace.seed,
      target_sha256: trace.target_sha256,
      node_count: trace.nodes.length,
      total_nodes: trace.total_nodes,
      edge_count: trace.edges.length,
      total_edges: trace.total_edges,
      procedure_count: trace.procedures.length,
      unknown_count: trace.unknowns.length,
      decompilations: trace.decompilations,
      next_offset: trace.next_offset,
      truncated: trace.truncated,
      limitation_count: trace.limitations.length,
    },
    coverage: completeWithinViewCoverage(1, 1),
    limitations: boundedViewMessages(
      [...parent.limitations, ...trace.limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: boundedViewMessages(
      trace.unknowns.map(
        ({ procedure, address, reason }) =>
          `${procedure}${address === null ? "" : ` at ${address}`}: ${reason}`,
      ),
      parent.evidenceId,
      "unknowns",
    ),
  });
};
