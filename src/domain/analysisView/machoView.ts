import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { isMachOFormat } from "../binaryTargetTypes.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import { inspectMachoSchema } from "../native/nativeInspection.js";
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

const MACHO_COLLECTIONS = [
  "entrypoints",
  "architectures",
  "build_metadata",
  "load_commands",
  "dependencies",
  "imports",
  "exports",
  "segments",
] as const;
type MachoCollection = (typeof MACHO_COLLECTIONS)[number];

/** Original inspect_macho rows; offsets count rows in the retained collection. */
export const machoViewRequestSchema = z.strictObject({
  kind: z.literal("macho"),
  facet: z.enum([...MACHO_COLLECTIONS, "provenance"]),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
});

const { shape } = inspectMachoSchema;
/**
 * Union members are tried in order and plain objects drop unknown keys, so a
 * segment or architecture row would otherwise match the entrypoint row and
 * lose every field but file_offset. Exact key sets keep each page's rows whole.
 */
const exactRows = <Shape extends z.ZodRawShape>(
  rows: z.ZodArray<z.ZodObject<Shape>>,
) => z.array(z.strictObject(rows.element.shape));
export const machoViewItemSchema = z.union([
  exactRows(shape.entrypoints.shape.items),
  exactRows(shape.architectures.shape.items),
  exactRows(shape.build_metadata.shape.items),
  exactRows(shape.load_commands.shape.items),
  exactRows(shape.dependencies.shape.items),
  // Imports and exports share one row shape.
  exactRows(shape.imports.shape.items),
  exactRows(shape.segments.shape.items),
  exactRows(shape.provenance),
]);

/** The producer's own coverage of the paged collection, not of this page. */
export const machoViewContextSchema = z.strictObject({
  source_total: z.number().int().nonnegative().nullable(),
  source_exhaustive: z.boolean(),
});

const collectionCountSchema = z.strictObject({
  returned: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable(),
  exhaustive: z.boolean(),
});

/** Slice identity and per-collection counts without the collections themselves. */
export const machoSummarySchema = z.strictObject({
  format: shape.format,
  selected_architecture: shape.selected_architecture,
  endian: shape.endian,
  word_size: shape.word_size,
  file_type: shape.file_type,
  flags: shape.flags,
  uuid: shape.uuid,
  collections: z.strictObject(
    Object.fromEntries(
      MACHO_COLLECTIONS.map((name) => [name, collectionCountSchema]),
    ) as Record<MachoCollection, typeof collectionCountSchema>,
  ),
  provenance_count: z.number().int().nonnegative(),
  limitation_count: z.number().int().nonnegative(),
});

type MachoReport = z.output<typeof inspectMachoSchema>;

/** Admit a well-formed report whose recorded subject, if any, is a Mach-O. */
const parseMachoReport = (
  parent: AnalysisViewParent,
): Result<MachoReport, AnalysisError> => {
  const parsed = inspectMachoSchema.safeParse(parent.normalizedResult);
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
  if (parent.subject != null && !isMachOFormat(parent.subject.format))
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message:
            "Mach-O parent Evidence subject must identify a thin or universal Mach-O.",
        },
      ]),
    );
  return ok(parsed.data);
};

/** Counts replace rows; every collection caveat stays in the limitations. */
const summarizeMacho = (
  report: MachoReport,
  parentLimitations: readonly string[],
) => {
  const limitations = uniqueSorted([
    ...parentLimitations,
    ...report.limitations,
    ...MACHO_COLLECTIONS.flatMap((name) => report[name].limitations),
  ]);
  const collections = Object.fromEntries(
    MACHO_COLLECTIONS.map((name) => [
      name,
      {
        returned: report[name].items.length,
        total: report[name].total,
        exhaustive: report[name].exhaustive,
      },
    ]),
  ) as Record<MachoCollection, z.output<typeof collectionCountSchema>>;
  return {
    limitations,
    returned: MACHO_COLLECTIONS.reduce(
      (sum, name) => sum + report[name].items.length,
      0,
    ),
    summary: {
      format: report.format,
      selected_architecture: report.selected_architecture,
      endian: report.endian,
      word_size: report.word_size,
      file_type: report.file_type,
      flags: report.flags,
      uuid: report.uuid,
      collections,
      provenance_count: report.provenance.length,
      limitation_count: limitations.length,
    },
  };
};

/** Project retained inspect_macho Evidence without rerunning native tools. */
export const projectMachoView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "macho")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message: "Mach-O inspection supports summary and macho views.",
        },
      ]),
    );
  const parsed = parseMachoReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const incomplete = MACHO_COLLECTIONS.filter(
    (name) => !report[name].exhaustive,
  );
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_macho" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact:
      parent.subject == null
        ? { path: "", sha256: null }
        : {
            path: parent.subject.local_path,
            sha256: parent.subject.digest.sha256,
          },
    unknowns: [
      ...(incomplete.length === 0
        ? []
        : [
            `Native tools did not report exhaustive ${incomplete.join(", ")}; page exhaustion does not establish absence of unreturned rows.`,
          ]),
      ...(parent.subject == null
        ? [
            "The parent has no recorded subject, so the inspected artifact path and SHA-256 are unknown.",
          ]
        : []),
    ],
  };
  if (view.kind === "summary") {
    const { summary, limitations, returned } = summarizeMacho(
      report,
      parent.limitations,
    );
    return ok({
      kind: "summary",
      view,
      ...shared,
      limitations,
      summary,
      coverage: completeWithinViewCoverage(returned, returned),
    });
  }
  const source =
    view.facet === "provenance"
      ? {
          items: report.provenance,
          total: report.provenance.length,
          exhaustive: true,
          limitations: [],
        }
      : report[view.facet];
  const item = source.items.slice(view.offset, view.offset + view.limit);
  return ok({
    kind: "macho",
    view,
    item,
    ...shared,
    limitations: uniqueSorted([
      ...parent.limitations,
      ...report.limitations,
      ...source.limitations,
    ]),
    source_total: source.total,
    source_exhaustive: source.exhaustive,
    coverage: pageViewCoverage(view.offset, item.length, source.items.length),
  });
};
