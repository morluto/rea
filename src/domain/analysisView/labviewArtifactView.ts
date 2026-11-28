import { z } from "zod";
import {
  labviewArtifactSchema,
  labviewProgramTreeMemberSchema,
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
  unavailableViewCoverage,
} from "./analysisViewCoverage.js";
import {
  PLACEHOLDER_COVERAGE,
  selectByteBoundedViewRows,
} from "./byteBoundedViewRows.js";
import { selectViewRows } from "./selectViewRows.js";

export const labviewArtifactViewRequestSchema = z.strictObject({
  kind: z.literal("labview-artifact"),
  collection: z.enum(["blocks", "sections", "program_tree"]),
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
  z.array(
    labviewProgramTreeMemberSchema.extend({
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
  program_tree_listed: z.boolean(),
  program_tree_entry_count: count.nullable(),
  program_tree_total_bytes: count.nullable(),
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
    program_tree_listed: r.program_tree !== null,
    program_tree_entry_count: r.program_tree?.entry_count ?? null,
    program_tree_total_bytes: r.program_tree?.total_bytes ?? null,
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

  // A tree that was never listed has no known total; an empty page would
  // claim it was proven empty.
  if (view.collection === "program_tree" && r.program_tree === null)
    return ok({
      ...shared,
      kind: "labview-artifact" as const,
      view,
      labview: facts,
      items: [],
      coverage: unavailableViewCoverage(),
      unknowns: [
        "The embedded program tree was not listed, so its members are unavailable.",
      ],
    });

  if (view.collection === "program_tree") {
    // Member names can be large; bound the page by serialized bytes as well
    // as by count, and continue at the returned offset.
    const envelope = {
      ...shared,
      kind: "labview-artifact" as const,
      view: {
        kind: view.kind,
        collection: view.collection,
        ...(view.block === undefined ? {} : { block: view.block }),
        offset: view.offset,
        limit: view.limit,
      },
      labview: facts,
      // Measure the fixed response shape too: rows and coverage follow.
      items: [],
      coverage: PLACEHOLDER_COVERAGE,
    };
    type Member = NonNullable<LabviewReport["program_tree"]>["members"][number];
    const bounded = selectByteBoundedViewRows<
      Member,
      Member & { readonly source_index: number }
    >(
      r.program_tree?.members ?? [],
      view,
      {
        matches: undefined,
        project: (member, source_index) => ({ ...member, source_index }),
      },
      {
        parentEvidenceId: parent.evidenceId,
        envelope,
        facet: "program_tree",
      },
    );
    if (!bounded.ok) return bounded;
    return ok({
      ...envelope,
      ...selectedViewPage(view.offset, {
        rows: bounded.value.rows,
        total: bounded.value.total,
      }),
    });
  }

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
