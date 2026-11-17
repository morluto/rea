import { z } from "zod";
import {
  DWARF_LINE_ISSUE_CODES,
  dwarfLineAddressMatchSchema,
  dwarfLineProgramSchema,
  dwarfLineRowSchema,
  dwarfLinesReportSchema,
  dwarfLinesSchema,
  formatDwarfLineAddress,
  inputAddressHexSchema,
  type DwarfLinesReport,
} from "../native/dwarfLines.js";
import { err, ok } from "../result.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
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

const sourceIndex = { source_index: z.int().nonnegative() };
const programIndexField = { program_index: z.int().nonnegative() };
const page = {
  kind: z.literal("dwarf-lines"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
};

const programSummarySchema = dwarfLineProgramSchema
  .omit({
    directories: true,
    files: true,
    sequences: true,
    issues: true,
  })
  .extend({
    directory_count: z.int().nonnegative(),
    file_count: z.int().nonnegative(),
    sequence_count: z.int().nonnegative(),
    issue_count: z.int().nonnegative(),
  });

const indexedDirectoryRowSchema =
  dwarfLineProgramSchema.shape.directories.element.extend({
    ...programIndexField,
    ...sourceIndex,
  });

const indexedFileRowSchema = dwarfLineProgramSchema.shape.files.element.extend({
  ...programIndexField,
  ...sourceIndex,
});

const indexedIssueRowSchema =
  dwarfLineProgramSchema.shape.issues.element.extend({
    ...programIndexField,
    ...sourceIndex,
  });

const indexedProgramSummarySchema = programSummarySchema
  .partial()
  .extend(sourceIndex);
const indexedLineRowSchema = dwarfLineRowSchema.partial().extend(sourceIndex);
const indexedAddressMatchSchema =
  dwarfLineAddressMatchSchema.extend(sourceIndex);

const rowFieldNames = dwarfLineRowSchema.keyof();
const programFieldNames = programSummarySchema.keyof();

/** Collection-paged view requests over retained `.debug_line` inspection Evidence. */
export const dwarfLinesViewRequestSchema = z.discriminatedUnion("collection", [
  z.strictObject({
    ...page,
    collection: z.literal("programs"),
    version: z.int().min(0).max(0xffff).optional(),
    indices: z.array(z.int().nonnegative()).optional(),
    fields: z.array(programFieldNames).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("directories"),
    program_index: z.int().nonnegative().optional(),
    indices: z.array(z.int().nonnegative()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("files"),
    program_index: z.int().nonnegative().optional(),
    name: z.string().optional(),
    md5_hex: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
    indices: z.array(z.int().nonnegative()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("rows"),
    program_index: z.int().nonnegative().optional(),
    sequence_index: z.int().nonnegative().optional(),
    file: z.string().optional(),
    line: z.int().optional(),
    indices: z.array(z.int().nonnegative()).optional(),
    fields: z.array(rowFieldNames).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("address_matches"),
    status: dwarfLineAddressMatchSchema.shape.status.optional(),
    query_address: inputAddressHexSchema.optional(),
    indices: z.array(z.int().nonnegative()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("issues"),
    program_index: z.int().nonnegative().optional(),
    code: z.enum(DWARF_LINE_ISSUE_CODES).optional(),
    indices: z.array(z.int().nonnegative()).optional(),
  }),
]);

export const dwarfLinesViewItemsSchema = z.union([
  z.array(indexedProgramSummarySchema),
  z.array(indexedDirectoryRowSchema),
  z.array(indexedFileRowSchema),
  z.array(indexedLineRowSchema),
  z.array(indexedAddressMatchSchema),
  z.array(indexedIssueRowSchema),
]);

export const dwarfLinesSummarySchema = dwarfLinesReportSchema
  .omit({
    programs: true,
    rows: true,
    address_matches: true,
    limitations: true,
  })
  .extend({
    program_count: z.int().nonnegative(),
    retained_program_count: z.int().nonnegative(),
    directory_count: z.int().nonnegative(),
    file_count: z.int().nonnegative(),
    sequence_count: z.int().nonnegative(),
    row_count: z.int().nonnegative(),
    retained_row_count: z.int().nonnegative(),
    address_match_count: z.int().nonnegative(),
    issue_count: z.int().nonnegative(),
    limitation_count: z.int().nonnegative(),
  });

const readReport = createAnalysisViewResultReader(dwarfLinesSchema);

const pickFields = <Row extends object>(
  row: Row,
  fields: readonly (keyof Row)[] | undefined,
  source_index: number,
): Partial<Row> & { source_index: number } => {
  if (fields === undefined) return { ...row, source_index };
  const projected: Record<string, unknown> = { source_index };
  for (const field of new Set(fields)) {
    projected[String(field)] = row[field];
  }
  return projected as Partial<Row> & { source_index: number };
};

const summarizeProgram = (program: DwarfLinesReport["programs"][number]) => {
  const { directories, files, sequences, issues, ...rest } = program;
  return {
    ...rest,
    directory_count: directories.length,
    file_count: files.length,
    sequence_count: sequences.length,
    issue_count: issues.length,
  };
};

/** Project summary or filtered, column-selected collection pages over retained DWARF line Evidence. */
export const projectDwarfLinesView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  if (view.kind !== "summary" && view.kind !== "dwarf-lines") {
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "DWARF line Evidence supports summary and dwarf-lines views.",
        },
      ]),
    );
  }
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof dwarfLinesViewRequestSchema>
  >(view, "summary", "dwarf-lines");

  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const { programs, rows, address_matches, limitations, ...identity } = report;

  let directoryCount = 0;
  let fileCount = 0;
  let sequenceCount = 0;
  let issueCount = 0;
  for (const p of programs) {
    directoryCount += p.directories.length;
    fileCount += p.files.length;
    sequenceCount += p.sequences.length;
    issueCount += p.issues.length;
  }

  const summary = {
    ...identity,
    program_count: report.total_programs,
    retained_program_count: programs.length,
    directory_count: directoryCount,
    file_count: fileCount,
    sequence_count: sequenceCount,
    row_count: report.total_rows,
    retained_row_count: rows.length,
    address_match_count: address_matches.length,
    issue_count: issueCount,
    limitation_count: limitations.length,
  };

  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_dwarf_lines" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations: boundedViewMessages(
      [...parent.limitations, ...limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns:
      report.coverage.status === "complete"
        ? []
        : [
            report.coverage.reason ??
              "Line-program coverage is incomplete; no-match pages do not prove absence.",
          ],
  };

  if (view.kind === "summary") {
    return ok({
      ...shared,
      kind: "summary" as const,
      view,
      summary,
      coverage: completeWithinViewCoverage(programs.length),
    });
  }

  const indices =
    view.indices === undefined ? undefined : new Set(view.indices);

  if (view.collection === "programs") {
    const selected = selectViewRows(
      programs,
      view,
      (row, idx) =>
        (indices === undefined || indices.has(idx)) &&
        (view.version === undefined || row.version === view.version),
      (row, source_index) =>
        pickFields(summarizeProgram(row), view.fields, source_index),
    );
    return ok({
      ...shared,
      kind: "dwarf-lines" as const,
      view,
      lines: summary,
      items: selected.rows,
      coverage: pageViewCoverage(
        view.offset,
        selected.rows.length,
        selected.total,
      ),
    });
  }

  if (view.collection === "directories") {
    const flat = programs.flatMap((program) =>
      program.directories.map((dir) => ({
        program_index: program.index,
        ...dir,
      })),
    );
    const selected = selectViewRows(
      flat,
      view,
      (row, idx) =>
        (indices === undefined || indices.has(idx)) &&
        (view.program_index === undefined ||
          row.program_index === view.program_index),
      (row, source_index) => ({ ...row, source_index }),
    );
    return ok({
      ...shared,
      kind: "dwarf-lines" as const,
      view,
      lines: summary,
      items: selected.rows,
      coverage: pageViewCoverage(
        view.offset,
        selected.rows.length,
        selected.total,
      ),
    });
  }

  if (view.collection === "files") {
    const flat = programs.flatMap((program) =>
      program.files.map((file) => ({
        program_index: program.index,
        ...file,
      })),
    );
    const selected = selectViewRows(
      flat,
      view,
      (row, idx) =>
        (indices === undefined || indices.has(idx)) &&
        (view.program_index === undefined ||
          row.program_index === view.program_index) &&
        (view.name === undefined || row.name.value === view.name) &&
        (view.md5_hex === undefined || row.md5_hex === view.md5_hex),
      (row, source_index) => ({ ...row, source_index }),
    );
    return ok({
      ...shared,
      kind: "dwarf-lines" as const,
      view,
      lines: summary,
      items: selected.rows,
      coverage: pageViewCoverage(
        view.offset,
        selected.rows.length,
        selected.total,
      ),
    });
  }

  if (view.collection === "rows") {
    const selected = selectViewRows(
      rows,
      view,
      (row, idx) =>
        (indices === undefined || indices.has(idx)) &&
        (view.program_index === undefined ||
          row.program_index === view.program_index) &&
        (view.sequence_index === undefined ||
          row.sequence_index === view.sequence_index) &&
        (view.file === undefined || row.file === view.file) &&
        (view.line === undefined || row.line === view.line),
      (row, source_index) => pickFields(row, view.fields, source_index),
    );
    return ok({
      ...shared,
      kind: "dwarf-lines" as const,
      view,
      lines: summary,
      items: selected.rows,
      coverage: pageViewCoverage(
        view.offset,
        selected.rows.length,
        selected.total,
      ),
    });
  }

  if (view.collection === "address_matches") {
    let normalizedQuery: string | undefined;
    if (view.query_address !== undefined) {
      if (!inputAddressHexSchema.safeParse(view.query_address).success) {
        return err(
          analysisViewInputError([
            {
              path: ["view", "query_address"],
              reason: "invalid_format",
              message: `Invalid DWARF query_address filter ${view.query_address}`,
            },
          ]),
        );
      }
      normalizedQuery = formatDwarfLineAddress(BigInt(view.query_address));
    }
    const selected = selectViewRows(
      address_matches,
      view,
      (row, idx) =>
        (indices === undefined || indices.has(idx)) &&
        (view.status === undefined || row.status === view.status) &&
        (normalizedQuery === undefined ||
          row.query_address === normalizedQuery),
      (row, source_index) => ({ ...row, source_index }),
    );
    return ok({
      ...shared,
      kind: "dwarf-lines" as const,
      view,
      lines: summary,
      items: selected.rows,
      coverage: pageViewCoverage(
        view.offset,
        selected.rows.length,
        selected.total,
      ),
    });
  }

  const flatIssues = programs.flatMap((program) =>
    program.issues.map((issue) => ({
      program_index: program.index,
      ...issue,
    })),
  );
  const selected = selectViewRows(
    flatIssues,
    view,
    (row, idx) =>
      (indices === undefined || indices.has(idx)) &&
      (view.program_index === undefined ||
        row.program_index === view.program_index) &&
      (view.code === undefined || row.code === view.code),
    (row, source_index) => ({ ...row, source_index }),
  );
  return ok({
    ...shared,
    kind: "dwarf-lines" as const,
    view,
    lines: summary,
    items: selected.rows,
    coverage: pageViewCoverage(
      view.offset,
      selected.rows.length,
      selected.total,
    ),
  });
};
