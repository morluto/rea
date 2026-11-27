import { z } from "zod";
import {
  labviewArtifactSchema,
  labviewSectionSchema,
} from "../labview/labviewArtifact.js";
import { ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import {
  boundedViewLimitations,
  completeWithinViewCoverage,
  selectedViewPage,
} from "./analysisViewCoverage.js";
import { selectViewRows } from "./selectViewRows.js";

export const labviewArtifactViewRequestSchema = z.strictObject({
  kind: z.literal("labview-artifact"),
  collection: z.enum(["blocks", "sections"]),
  block: z
    .string()
    .length(4)
    .optional()
    .describe(
      "Exact four-character block identifier filter; supported only for the sections collection",
    ),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().max(1024).default(64),
});

const sourceIndex = { source_index: z.int().nonnegative() };
const count = z.int().nonnegative();

export const labviewArtifactViewItemsSchema = z.union([
  z.array(
    z.strictObject({
      identifier: z.string().length(4),
      section_count: count,
      ...sourceIndex,
    }),
  ),
  z.array(
    labviewSectionSchema.extend({
      block: z.string().length(4),
      block_index: count,
      ...sourceIndex,
    }),
  ),
]);

const {
  artifact,
  container,
  labview_version,
  version_coverage,
  block_diagram,
  front_panel,
} = labviewArtifactSchema.shape;

const context = {
  artifact,
  container,
  labview_version,
  version_coverage,
  block_diagram,
  front_panel,
  block_count: count,
  section_count: count,
};

export const labviewArtifactSummarySchema = z.strictObject(context);
export const labviewArtifactPageContextSchema = z.strictObject(context);

const readReport = createAnalysisViewResultReader(labviewArtifactSchema);

type LabviewReport = z.output<typeof labviewArtifactSchema>;

/**
 * Where each section sits, built once per immutable report: section `i`
 * (in block order) is `blocks[blockOf[i]].sections[sectionOf[i]]`, and
 * `byBlock` lists the section positions each block identifier owns.
 */
interface SectionIndex {
  readonly blockOf: Uint32Array;
  readonly sectionOf: Uint32Array;
  readonly byBlock: ReadonlyMap<string, readonly number[]>;
}

const sectionIndexes = new WeakMap<LabviewReport, SectionIndex>();

const sectionIndex = (report: LabviewReport): SectionIndex => {
  const known = sectionIndexes.get(report);
  if (known !== undefined) return known;
  let total = 0;
  for (const block of report.blocks) total += block.sections.length;
  const blockOf = new Uint32Array(total);
  const sectionOf = new Uint32Array(total);
  const byBlock = new Map<string, number[]>();
  let at = 0;
  report.blocks.forEach((block, blockIndex) => {
    let positions = byBlock.get(block.identifier);
    if (positions === undefined) {
      positions = [];
      byBlock.set(block.identifier, positions);
    }
    for (let index = 0; index < block.sections.length; index += 1) {
      blockOf[at] = blockIndex;
      sectionOf[at] = index;
      positions.push(at);
      at += 1;
    }
  });
  const built = { blockOf, sectionOf, byBlock };
  // The reader returns one frozen report per sealed parent, so the index is
  // reused across pages of the same Evidence.
  if (Object.isFrozen(report)) sectionIndexes.set(report, built);
  return built;
};

/**
 * Bounded projections of one retained LabVIEW inspection: a summary of the
 * container and heap facts, and paged block and section inventories. The
 * complete block inventory stays in the parent Evidence.
 */
export const projectLabviewArtifactView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (view.kind !== "summary" && view.kind !== "labview-artifact")
    return invalidAnalysisView(
      "LabVIEW artifact Evidence supports summary and labview-artifact views.",
    );
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof labviewArtifactViewRequestSchema>
  >(view, "summary", "labview-artifact");
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const r = parsed.value;
  const index = sectionIndex(r);
  const facts = {
    artifact: r.artifact,
    container: r.container,
    labview_version: r.labview_version,
    version_coverage: r.version_coverage,
    block_diagram: r.block_diagram,
    front_panel: r.front_panel,
    block_count: r.blocks.length,
    section_count: index.blockOf.length,
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_labview_artifact" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: r.artifact.path, sha256: r.artifact.sha256 },
    limitations: boundedViewLimitations(parent, r.limitations),
    unknowns: [],
  };
  if (view.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      summary: facts,
      coverage: completeWithinViewCoverage(r.blocks.length),
    });

  if (view.block !== undefined && view.collection !== "sections")
    return invalidAnalysisView("block filters only the sections collection.");

  const selected =
    view.collection === "blocks"
      ? selectViewRows(
          r.blocks,
          view,
          undefined,
          ({ identifier, sections: rows }, source_index) => ({
            identifier,
            section_count: rows.length,
            source_index,
          }),
        )
      : selectSections(r, index, view);

  return ok({
    ...shared,
    kind: "labview-artifact" as const,
    view,
    labview: facts,
    ...selectedViewPage(view.offset, selected),
  });
};

/** Build section rows only for the requested page, from the shared index. */
const selectSections = (
  report: LabviewReport,
  index: SectionIndex,
  view: z.output<typeof labviewArtifactViewRequestSchema>,
) => {
  const positions =
    view.block === undefined
      ? undefined
      : (index.byBlock.get(view.block) ?? []);
  const total = positions?.length ?? index.blockOf.length;
  const rows = [];
  const end = Math.min(total, view.offset + view.limit);
  for (let at = view.offset; at < end; at += 1) {
    const source_index = positions === undefined ? at : positions[at]!;
    const block_index = index.blockOf[source_index]!;
    const block = report.blocks[block_index]!;
    rows.push({
      ...block.sections[index.sectionOf[source_index]!]!,
      block: block.identifier,
      block_index,
      source_index,
    });
  }
  return { rows, total };
};
