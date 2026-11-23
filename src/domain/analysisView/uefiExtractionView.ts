import { z } from "zod";
import { boundedList } from "../boundedList.js";
import { evidenceSubjectTarget } from "../evidence.js";
import { err, ok } from "../result.js";
import {
  ffsTypeNameSchema,
  guidSchema,
  uefiResultSchemas,
  type UefiExtractResult,
} from "../uefi/uefiFirmwareAnalysis.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import {
  createAnalysisViewResultReader,
  parentArtifactPath,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { selectViewRows } from "./selectViewRows.js";

const extraction = uefiResultSchemas.extract_uefi_firmware;
const fileRecord = extraction.shape.files.element;
const gapRecord = extraction.shape.extraction_gaps.element;
const count = z.int().nonnegative();
const sourceIndex = {
  source_index: count.describe(
    "Index in the parent's files, derivations or gaps",
  ),
};
const offset = z.int().nonnegative().default(0);
const exactNames = <Schema extends z.ZodType>(schema: Schema, what: string) =>
  z
    .array(schema)
    .min(1)
    .max(64)
    .optional()
    .describe(`Exact ${what}; any listed value matches`);

/** Published files shown inline with a summary before paging is needed. */
export const UEFI_EXTRACTION_PREVIEW_FILES = 8;

/** Retained extraction facts selected by collection, exact filters and stable pages. */
export const uefiExtractionViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      kind: z.literal("uefi-extraction"),
      collection: z.literal("files"),
      media_types: exactNames(
        z.string().min(1),
        "media types, for example application/vnd.microsoft.portable-executable",
      ),
      sources: exactNames(fileRecord.shape.source, "payload sources"),
      ffs_guids: exactNames(guidSchema, "lowercase owning FFS file GUIDs"),
      ffs_ui_names: exactNames(
        z.string().min(1),
        "owning FFS user-interface names",
      ),
      ffs_type_names: exactNames(ffsTypeNameSchema, "owning FFS file types"),
      order: z
        .enum(["source", "size-desc"])
        .default("source")
        .describe(
          "source keeps publication order; size-desc lists the largest files first, ties in publication order",
        ),
      offset,
      limit: z.int().positive().max(256).default(16),
    }),
    z.strictObject({
      kind: z.literal("uefi-extraction"),
      collection: z.literal("derivations"),
      offset,
      limit: z.int().positive().max(256).default(32),
    }),
    z.strictObject({
      kind: z.literal("uefi-extraction"),
      collection: z.literal("gaps"),
      gap_kinds: exactNames(gapRecord.shape.kind, "gap kinds"),
      offset,
      limit: z.int().positive().max(256).default(32),
    }),
  ],
);
type UefiExtractionView = z.output<typeof uefiExtractionViewRequestSchema>;
type FilesView = Extract<UefiExtractionView, { collection: "files" }>;
type GapsView = Extract<UefiExtractionView, { collection: "gaps" }>;

const fileRow = fileRecord.extend(sourceIndex);
export const uefiExtractionViewItemsSchema = z.union([
  z.array(fileRow),
  z.array(extraction.shape.derivations.element.extend(sourceIndex)),
  z.array(gapRecord.extend(sourceIndex)),
]);

const tally = <Name extends z.ZodType>(name: Name) =>
  z.array(z.strictObject({ name, count }));
/** Fixed-size extraction facts shared by summaries and pages. */
export const uefiExtractionPageContextSchema = extraction
  .pick({
    parser: true,
    selection: true,
    output_directory: true,
    coverage: true,
    published_bytes: true,
    diagnostics: true,
  })
  .extend({
    file_count: count,
    derivation_count: count,
    gap_count: count,
  });
export const uefiExtractionSummarySchema =
  uefiExtractionPageContextSchema.extend({
    sources: tally(fileRecord.shape.source),
    media_types: tally(z.string().nullable()),
    gap_kinds: tally(gapRecord.shape.kind),
    files_preview: z
      .strictObject({
        items: z.array(fileRow).max(UEFI_EXTRACTION_PREVIEW_FILES),
        omitted: count,
      })
      .describe(
        `The first ${String(UEFI_EXTRACTION_PREVIEW_FILES)} published files in publication order; page the omitted files with collection files`,
      ),
  });
type PageContext = z.output<typeof uefiExtractionPageContextSchema>;
type Summary = z.output<typeof uefiExtractionSummarySchema>;
type ExtractedFile = UefiExtractResult["files"][number];

const readReport = createAnalysisViewResultReader(extraction);

const tallied = <Name>(names: Iterable<Name>) => {
  const counts = new Map<Name, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, n]) => ({ name, count: n }));
};

/** Counts and the size order derived once per retained report. */
interface ExtractionIndex {
  readonly context: PageContext;
  bySize?: readonly number[];
  summary?: Summary;
}
// The reader returns one frozen snapshot per retained parent, so its identity keys reuse.
const indexes = new WeakMap<UefiExtractResult, ExtractionIndex>();
const extractionIndex = (r: UefiExtractResult): ExtractionIndex => {
  const known = indexes.get(r);
  if (known !== undefined) return known;
  const index: ExtractionIndex = {
    context: {
      parser: r.parser,
      selection: r.selection,
      output_directory: r.output_directory,
      coverage: r.coverage,
      published_bytes: r.published_bytes,
      diagnostics: r.diagnostics,
      file_count: r.files.length,
      derivation_count: r.derivations.length,
      gap_count: r.extraction_gaps.length,
    },
  };
  indexes.set(r, index);
  return index;
};

const indexedRow = <Row extends object>(row: Row, source_index: number) => ({
  ...row,
  source_index,
});

const extractionSummary = (
  r: UefiExtractResult,
  index: ExtractionIndex,
): Summary => {
  if (index.summary !== undefined) return index.summary;
  const preview = boundedList(r.files, UEFI_EXTRACTION_PREVIEW_FILES);
  index.summary = {
    ...index.context,
    sources: tallied(r.files.map((file) => file.source)),
    media_types: tallied(r.files.map((file) => file.media_type)),
    gap_kinds: tallied(r.extraction_gaps.map((gap) => gap.kind)),
    files_preview: {
      items: preview.items.map(indexedRow),
      omitted: preview.omitted,
    },
  };
  return index.summary;
};

/** Undefined when no filter is set, so unfiltered pages slice directly. */
const fileFilter = (view: FilesView) =>
  view.media_types === undefined &&
  view.sources === undefined &&
  view.ffs_guids === undefined &&
  view.ffs_ui_names === undefined &&
  view.ffs_type_names === undefined
    ? undefined
    : (file: ExtractedFile): boolean => {
        const owner = file.ffs_file;
        return (
          (view.media_types === undefined ||
            (file.media_type !== null &&
              view.media_types.includes(file.media_type))) &&
          (view.sources === undefined || view.sources.includes(file.source)) &&
          (view.ffs_guids === undefined ||
            (owner !== null && view.ffs_guids.includes(owner.guid))) &&
          (view.ffs_ui_names === undefined ||
            (owner?.ui_string != null &&
              view.ffs_ui_names.includes(owner.ui_string))) &&
          (view.ffs_type_names === undefined ||
            (owner !== null && view.ffs_type_names.includes(owner.type_name)))
        );
      };

/** File indices from largest to smallest; equal sizes keep publication order. */
const sizeOrder = (r: UefiExtractResult, index: ExtractionIndex) =>
  (index.bySize ??= r.files
    .map((_, i) => i)
    .sort((a, b) => r.files[b]!.size - r.files[a]!.size || a - b));

/** Walk the size order, count every match and project only the selected page. */
const pageBySize = (
  r: UefiExtractResult,
  index: ExtractionIndex,
  view: FilesView,
  matches: ((file: ExtractedFile) => boolean) | undefined,
) => {
  const order = sizeOrder(r, index);
  const rows: z.output<typeof fileRow>[] = [];
  if (matches === undefined) {
    // Unfiltered: the cached order already holds every position.
    const end = Math.min(order.length, view.offset + view.limit);
    for (let position = view.offset; position < end; position += 1) {
      const i = order[position]!;
      rows.push(indexedRow(r.files[i]!, i));
    }
    return { rows, total: order.length };
  }
  let total = 0;
  for (const i of order) {
    const file = r.files[i]!;
    if (matches !== undefined && !matches(file)) continue;
    if (total >= view.offset && rows.length < view.limit)
      rows.push(indexedRow(file, i));
    total += 1;
  }
  return { rows, total };
};

const gapFilter = (view: GapsView) => {
  const kinds = view.gap_kinds;
  return kinds === undefined
    ? undefined
    : (gap: UefiExtractResult["extraction_gaps"][number]) =>
        kinds.includes(gap.kind);
};

const selectedRows = (
  view: UefiExtractionView,
  r: UefiExtractResult,
  index: ExtractionIndex,
) => {
  switch (view.collection) {
    case "files":
      return view.order === "size-desc"
        ? pageBySize(r, index, view, fileFilter(view))
        : selectViewRows(r.files, view, fileFilter(view), indexedRow);
    case "derivations":
      return selectViewRows(r.derivations, view, undefined, indexedRow);
    case "gaps":
      return selectViewRows(
        r.extraction_gaps,
        view,
        gapFilter(view),
        indexedRow,
      );
  }
};

/** Page a retained extraction manifest without repeating the extraction. */
export const projectUefiExtractionView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (view.kind !== "summary" && view.kind !== "uefi-extraction")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "UEFI extraction Evidence supports summary and uefi-extraction views.",
        },
      ]),
    );
  assertOwnedView<SummaryAnalysisView | UefiExtractionView>(
    view,
    "summary",
    "uefi-extraction",
  );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const r = parsed.value;
  const index = extractionIndex(r);
  const subject = evidenceSubjectTarget(parent.subject);
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "extract_uefi_firmware" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: subject?.path ?? parentArtifactPath(parent),
      sha256: subject?.sha256 ?? null,
    },
    limitations: boundedViewMessages(
      [...parent.limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: [
      "Page exhaustion covers published files and recorded gaps only; extraction gaps and parser limits name what was not published.",
    ],
  };
  if (view.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      summary: extractionSummary(r, index),
      coverage: completeWithinViewCoverage(r.files.length),
    });
  const { rows, total } = selectedRows(view, r, index);
  return ok({
    ...shared,
    kind: "uefi-extraction" as const,
    view,
    uefi_extraction: index.context,
    items: rows,
    coverage: pageViewCoverage(view.offset, rows.length, total),
  });
};
