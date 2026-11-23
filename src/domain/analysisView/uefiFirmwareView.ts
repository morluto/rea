import { z } from "zod";
import { boundedList } from "../boundedList.js";
import { evidenceSubjectTarget } from "../evidence.js";
import { err, ok } from "../result.js";
import {
  ffsTypeNameSchema,
  guidSchema,
  uefiResultSchemas,
  uefiSectionTypeNameSchema,
  type UefiFfsFileRecord,
  type UefiInspectResult,
  type UefiSectionRecord,
} from "../uefi/uefiFirmwareAnalysis.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import { selectViewRows } from "./selectViewRows.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import {
  createAnalysisViewResultReader,
  parentArtifactPath,
  validateAnalysisViewSubject,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";

const inspection = uefiResultSchemas.inspect_uefi_firmware;
const volumeRecord = inspection.shape.firmware_volumes.element;
const fileRecord = volumeRecord.shape.ffs_files.element;
const sectionRecord = fileRecord.shape.sections.element;
const count = z.int().nonnegative();
const sourceIndex = {
  source_index: count.describe(
    "Index in the parent's flattened collection order",
  ),
};
const page = {
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().max(256).default(32),
};
const exactNames = <Schema extends z.ZodType>(schema: Schema, what: string) =>
  z
    .array(schema)
    .min(1)
    .optional()
    .describe(`Exact ${what}; any listed value matches`);

const pagedCollection = <Name extends string>(collection: Name) =>
  z.strictObject({
    kind: z.literal("uefi-firmware"),
    collection: z.literal(collection),
    ...page,
  });

/** Retained firmware facts selected by collection, exact filters and stable pages. */
export const uefiFirmwareViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    pagedCollection("volumes"),
    z.strictObject({
      kind: z.literal("uefi-firmware"),
      collection: z.literal("files"),
      guids: exactNames(guidSchema, "lowercase FFS file GUIDs"),
      ui_names: exactNames(z.string().min(1), "user-interface names"),
      type_names: exactNames(ffsTypeNameSchema, "FFS file type names"),
      volume_path: z
        .string()
        .min(1)
        .optional()
        .describe("Exact logical_path of the owning firmware volume"),
      offset: page.offset,
      limit: z
        .int()
        .positive()
        .max(256)
        .default(16)
        .describe("File rows carry their section lists"),
    }),
    z.strictObject({
      kind: z.literal("uefi-firmware"),
      collection: z.literal("sections"),
      file_path: z
        .string()
        .min(1)
        .optional()
        .describe("Exact logical_path of the owning FFS file"),
      type_names: exactNames(uefiSectionTypeNameSchema, "section type names"),
      ...page,
    }),
    pagedCollection("unknown-regions"),
    pagedCollection("integrity"),
    pagedCollection("psp-tables"),
    pagedCollection("psp-candidates"),
  ],
);
type UefiFirmwareView = z.output<typeof uefiFirmwareViewRequestSchema>;

/** Section lists longer than this stay in the sections collection. */
export const UEFI_FILE_ROW_SECTION_LIMIT = 32;
/** Enough of each section to size, verify and extract it without a sections page. */
const fileSectionSchema = sectionRecord.pick({
  type_name: true,
  offset: true,
  header_length: true,
  length: true,
  sha256: true,
  source_stream: true,
  truncated: true,
  malformed: true,
});
const fileRow = fileRecord.omit({ sections: true }).extend({
  volume_logical_path: z.string(),
  section_count: count,
  sections: z
    .array(fileSectionSchema)
    .max(UEFI_FILE_ROW_SECTION_LIMIT)
    .describe(
      `The file's first ${String(UEFI_FILE_ROW_SECTION_LIMIT)} sections in order; when section_count is larger, page the rest from the sections collection with file_path, which also carries complete records`,
    ),
  ...sourceIndex,
});
const sectionRow = sectionRecord.extend({
  file_logical_path: z.string(),
  ...sourceIndex,
});
export const uefiFirmwareViewItemsSchema = z.union([
  z.array(
    volumeRecord
      .omit({ ffs_files: true })
      .extend({ file_count: count, ...sourceIndex }),
  ),
  z.array(fileRow),
  z.array(sectionRow),
  z.array(inspection.shape.unknown_regions.element.extend(sourceIndex)),
  z.array(inspection.shape.integrity.element.extend(sourceIndex)),
  z.array(inspection.shape.psp_tables.element.extend(sourceIndex)),
  z.array(inspection.shape.psp_candidates.element.extend(sourceIndex)),
]);

const tally = <Name extends z.ZodType>(name: Name) =>
  z.array(z.strictObject({ name, count }));
/** Fixed-size counts shared by summaries and pages; rows stay in pages. */
export const uefiFirmwarePageContextSchema = inspection
  .pick({ parser: true, input_size: true, flash_image: true, coverage: true })
  .extend({
    volume_count: count,
    top_level_volume_count: count.describe("Volumes at depth 0"),
    file_count: count,
    named_file_count: count.describe("FFS files with a ui_string"),
    section_count: count,
    unknown_region_count: count,
    integrity_count: count,
    psp_table_count: count,
    psp_candidate_count: count,
  });
export const uefiFirmwareSummarySchema = uefiFirmwarePageContextSchema.extend({
  file_types: tally(ffsTypeNameSchema),
  section_types: tally(uefiSectionTypeNameSchema),
  volume_depths: z.array(z.strictObject({ depth: count, count })),
});
type PageContext = z.output<typeof uefiFirmwarePageContextSchema>;
type Summary = z.output<typeof uefiFirmwareSummarySchema>;

const readReport = createAnalysisViewResultReader(inspection);

const tallied = <Name>(names: Iterable<Name>) => {
  const counts = new Map<Name, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, n]) => ({ name, count: n }));
};

interface FileEntry {
  readonly volume: string;
  readonly file: UefiFfsFileRecord;
}
interface SectionEntry {
  readonly file: string;
  readonly section: UefiSectionRecord;
}
/** Flattened rows and counts derived once per retained report. */
interface FirmwareIndex {
  readonly files: readonly FileEntry[];
  readonly sections: readonly SectionEntry[];
  readonly context: PageContext;
  summary?: Summary;
}

// The reader returns one frozen snapshot per retained parent, so its identity keys reuse.
const indexes = new WeakMap<UefiInspectResult, FirmwareIndex>();
const firmwareIndex = (r: UefiInspectResult): FirmwareIndex => {
  const known = indexes.get(r);
  if (known !== undefined) return known;
  const files: FileEntry[] = [];
  const sections: SectionEntry[] = [];
  let named = 0;
  for (const volume of r.firmware_volumes)
    for (const file of volume.ffs_files) {
      files.push({ volume: volume.logical_path, file });
      if (file.ui_string !== null) named += 1;
      for (const section of file.sections)
        sections.push({ file: file.logical_path, section });
    }
  const index: FirmwareIndex = {
    files,
    sections,
    context: {
      parser: r.parser,
      input_size: r.input_size,
      flash_image: r.flash_image,
      coverage: r.coverage,
      volume_count: r.firmware_volumes.length,
      top_level_volume_count: r.firmware_volumes.filter((v) => v.depth === 0)
        .length,
      file_count: files.length,
      named_file_count: named,
      section_count: sections.length,
      unknown_region_count: r.unknown_regions.length,
      integrity_count: r.integrity.length,
      psp_table_count: r.psp_tables.length,
      psp_candidate_count: r.psp_candidates.length,
    },
  };
  indexes.set(r, index);
  return index;
};

const firmwareSummary = (r: UefiInspectResult, index: FirmwareIndex): Summary =>
  (index.summary ??= {
    ...index.context,
    file_types: tallied(index.files.map(({ file }) => file.type_name)),
    section_types: tallied(
      index.sections.map(({ section }) => section.type_name),
    ),
    volume_depths: tallied(r.firmware_volumes.map((v) => v.depth))
      .sort((a, b) => a.name - b.name)
      .map(({ name, count: n }) => ({ depth: name, count: n })),
  });

type FilesView = Extract<UefiFirmwareView, { collection: "files" }>;
type SectionsView = Extract<UefiFirmwareView, { collection: "sections" }>;

/** Undefined when no filter is set, so unfiltered pages slice directly. */
const fileFilter = (view: FilesView) =>
  view.guids === undefined &&
  view.ui_names === undefined &&
  view.type_names === undefined &&
  view.volume_path === undefined
    ? undefined
    : ({ volume, file }: FileEntry): boolean =>
        (view.guids === undefined || view.guids.includes(file.guid)) &&
        (view.ui_names === undefined ||
          (file.ui_string !== null &&
            view.ui_names.includes(file.ui_string))) &&
        (view.type_names === undefined ||
          view.type_names.includes(file.type_name)) &&
        (view.volume_path === undefined || view.volume_path === volume);

const sectionFilter = (view: SectionsView) =>
  view.file_path === undefined && view.type_names === undefined
    ? undefined
    : ({ file, section }: SectionEntry): boolean =>
        (view.file_path === undefined || view.file_path === file) &&
        (view.type_names === undefined ||
          view.type_names.includes(section.type_name));

const fileRowOf = ({ volume, file }: FileEntry, index: number) => {
  const { sections, ...rest } = file;
  const listed = boundedList(sections, UEFI_FILE_ROW_SECTION_LIMIT);
  return {
    ...rest,
    volume_logical_path: volume,
    section_count: listed.items.length + listed.omitted,
    sections: listed.items.map((section) => ({
      type_name: section.type_name,
      offset: section.offset,
      header_length: section.header_length,
      length: section.length,
      sha256: section.sha256,
      source_stream: section.source_stream,
      truncated: section.truncated,
      malformed: section.malformed,
    })),
    source_index: index,
  };
};
const indexedRow = <Row extends object>(row: Row, source_index: number) => ({
  ...row,
  source_index,
});

const selectedRows = (
  view: UefiFirmwareView,
  r: UefiInspectResult,
  index: FirmwareIndex,
) => {
  switch (view.collection) {
    case "volumes":
      return selectViewRows(r.firmware_volumes, view, undefined, (v, i) => {
        const { ffs_files, ...rest } = v;
        return { ...rest, file_count: ffs_files.length, source_index: i };
      });
    case "files":
      return selectViewRows(index.files, view, fileFilter(view), fileRowOf);
    case "sections":
      return selectViewRows(
        index.sections,
        view,
        sectionFilter(view),
        ({ file, section }, i) => ({
          ...section,
          file_logical_path: file,
          source_index: i,
        }),
      );
    case "unknown-regions":
      return selectViewRows(r.unknown_regions, view, undefined, indexedRow);
    case "integrity":
      return selectViewRows(r.integrity, view, undefined, indexedRow);
    case "psp-tables":
      return selectViewRows(r.psp_tables, view, undefined, indexedRow);
    case "psp-candidates":
      return selectViewRows(r.psp_candidates, view, undefined, indexedRow);
  }
};

/** Page retained UEFI cartography without rerunning the parser or reopening the image. */
export const projectUefiFirmwareView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (view.kind !== "summary" && view.kind !== "uefi-firmware")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "UEFI firmware Evidence supports summary and uefi-firmware views.",
        },
      ]),
    );
  assertOwnedView<SummaryAnalysisView | UefiFirmwareView>(
    view,
    "summary",
    "uefi-firmware",
  );
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const r = parsed.value;
  const bound = validateAnalysisViewSubject(
    parent.subject,
    r.flash_image.sha256,
  );
  if (!bound.ok) return bound;
  const index = firmwareIndex(r);
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_uefi_firmware" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path:
        evidenceSubjectTarget(parent.subject)?.path ??
        parentArtifactPath(parent),
      sha256: r.flash_image.sha256,
    },
    limitations: boundedViewMessages(
      [...parent.limitations, ...r.limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: [
      "Page exhaustion covers retained rows only; volumes, files and sections beyond the parser's depth, volume or file limits remain unmapped.",
    ],
  };
  if (view.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      summary: firmwareSummary(r, index),
      coverage: completeWithinViewCoverage(r.firmware_volumes.length),
    });
  const { rows, total } = selectedRows(view, r, index);
  return ok({
    ...shared,
    kind: "uefi-firmware" as const,
    view,
    uefi_firmware: index.context,
    items: rows,
    coverage: pageViewCoverage(view.offset, rows.length, total),
  });
};
