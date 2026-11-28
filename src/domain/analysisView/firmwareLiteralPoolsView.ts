import { z } from "zod";
import {
  firmwareLiteralPoolsReportSchema,
  literalPoolRegionKindSchema,
  type LiteralPoolMmioSummary,
  type LiteralPoolReference,
} from "../firmware/firmwareLiteralPools.js";
import { ok } from "../result.js";
import {
  boundedViewLimitations,
  completeWithinViewCoverage,
  selectedViewPage,
} from "./analysisViewCoverage.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { selectViewRows } from "./selectViewRows.js";

export const SUMMARY_TOP_MMIO_GROUP_LIMIT = 16;

export const firmwareLiteralPoolsViewRequestSchema = z.strictObject({
  kind: z.literal("firmware-literal-pools"),
  collection: z.enum(["mmio_summary", "references"]),
  region_kind: literalPoolRegionKindSchema
    .optional()
    .describe("Optional exact region_kind filter."),
  svd_peripheral: z
    .string()
    .min(1)
    .optional()
    .describe("Optional exact CMSIS-SVD peripheral name filter."),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().max(256).default(64),
});

const sourceIndex = { source_index: z.int().nonnegative() };

export const firmwareLiteralPoolsViewItemsSchema = z.union([
  z.array(
    firmwareLiteralPoolsReportSchema.shape.mmio_summary.element.extend(
      sourceIndex,
    ),
  ),
  z.array(
    firmwareLiteralPoolsReportSchema.shape.references.element.extend(
      sourceIndex,
    ),
  ),
]);

const {
  artifact,
  isa,
  base_address,
  scan_range,
  coverage,
  counts,
  svd_profile,
} = firmwareLiteralPoolsReportSchema.shape;

export const firmwareLiteralPoolsPageContextSchema = z.strictObject({
  artifact,
  isa,
  base_address,
  scan_range,
  coverage,
  counts,
  svd_profile,
  mmio_group_count: z.int().nonnegative(),
  limitation_count: z.int().nonnegative(),
});

export const firmwareLiteralPoolsSummarySchema =
  firmwareLiteralPoolsPageContextSchema.extend({
    top_mmio_groups:
      firmwareLiteralPoolsReportSchema.shape.mmio_summary.describe(
        `Up to ${String(SUMMARY_TOP_MMIO_GROUP_LIMIT)} highest-reference MMIO groups; page all groups or references with view {kind:"firmware-literal-pools",collection:"mmio_summary"|"references",offset,limit}.`,
      ),
  });

const readReport = createAnalysisViewResultReader(
  firmwareLiteralPoolsReportSchema,
);

const matchesFilter = (
  row: LiteralPoolMmioSummary | LiteralPoolReference,
  view: z.output<typeof firmwareLiteralPoolsViewRequestSchema>,
): boolean =>
  (view.region_kind === undefined || row.region_kind === view.region_kind) &&
  (view.svd_peripheral === undefined ||
    row.svd_peripheral === view.svd_peripheral);

/** Project summary or paged MMIO groups and resolved references from retained literal-pool Evidence. */
export const projectFirmwareLiteralPoolsView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (view.kind !== "summary" && view.kind !== "firmware-literal-pools") {
    return invalidAnalysisView(
      'Firmware literal-pools Evidence supports summary and view {kind:"firmware-literal-pools",collection:"mmio_summary"|"references",offset,limit}.',
    );
  }
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof firmwareLiteralPoolsViewRequestSchema>
  >(view, "summary", "firmware-literal-pools");
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const r = parsed.value;
  const context = {
    artifact: r.artifact,
    isa: r.isa,
    base_address: r.base_address,
    scan_range: r.scan_range,
    coverage: r.coverage,
    counts: r.counts,
    svd_profile: r.svd_profile,
    mmio_group_count: r.mmio_summary.length,
    limitation_count: r.limitations.length,
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_firmware_literal_pools" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: r.artifact.path, sha256: r.artifact.sha256 },
    limitations: boundedViewLimitations(parent, r.limitations),
    unknowns: [] as string[],
  };
  if (view.kind === "summary") {
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      summary: {
        ...context,
        top_mmio_groups: selectViewRows(
          r.mmio_summary,
          { offset: 0, limit: SUMMARY_TOP_MMIO_GROUP_LIMIT },
          undefined,
          (row) => row,
        ).rows,
      },
      coverage: completeWithinViewCoverage(r.references.length),
    });
  }
  const hasFilter =
    view.region_kind !== undefined || view.svd_peripheral !== undefined;
  const selected =
    view.collection === "mmio_summary"
      ? selectViewRows(
          r.mmio_summary,
          view,
          hasFilter ? (row) => matchesFilter(row, view) : undefined,
          (row, source_index) => ({ ...row, source_index }),
        )
      : selectViewRows(
          r.references,
          view,
          hasFilter ? (row) => matchesFilter(row, view) : undefined,
          (row, source_index) => ({ ...row, source_index }),
        );
  return ok({
    ...shared,
    kind: "firmware-literal-pools" as const,
    view,
    literal_pools: context,
    ...selectedViewPage(view.offset, selected),
  });
};
