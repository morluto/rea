import { z } from "zod";
import {
  elfDependenciesReportSchema,
  elfDependenciesSchema,
  type ElfDependencies,
} from "../native/elfDependencies.js";
import { err, ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { selectViewRows } from "./selectViewRows.js";

const neededRow = elfDependenciesReportSchema.shape.needed.element;
const importRow = elfDependenciesReportSchema.shape.imports.element;
const issueRow = elfDependenciesReportSchema.shape.issues.element;
const sourceIndex = { source_index: z.int().nonnegative() };
const page = {
  kind: z.literal("elf-dependencies"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
};

const versionRowSchema = z.strictObject({
  file: z.string().min(1).nullable(),
  name: z.string().min(1).nullable(),
  hash: z.number().int().min(0).max(0xffffffff),
  flags: z.strictObject({ weak: z.boolean() }),
  index: z.number().int().min(0).max(0x7fff),
});

/** Exact names preserve duplicate DT_NEEDED rows; indices are scoped to the complete parent. */
export const elfDependenciesViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    z.strictObject({
      ...page,
      collection: z.literal("needed"),
      names: z
        .array(z.string())
        .optional()
        .describe(
          "Exact DT_NEEDED names. Omitted includes all names; [] matches none.",
        ),
      indices: z.array(z.int().nonnegative()).optional(),
      fields: z.array(neededRow.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("versions"),
      names: z
        .array(z.string())
        .optional()
        .describe(
          "Exact version names. Omitted includes all names; [] matches none.",
        ),
      indices: z.array(z.int().nonnegative()).optional(),
      fields: z.array(versionRowSchema.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("imports"),
      names: z
        .array(z.string())
        .optional()
        .describe(
          "Exact undefined-symbol names. Omitted includes all names; [] matches none.",
        ),
      indices: z.array(z.int().nonnegative()).optional(),
      fields: z.array(importRow.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("issues"),
      indices: z.array(z.int().nonnegative()).optional(),
    }),
  ],
);

export const elfDependenciesViewItemsSchema = z.union([
  z.array(neededRow.partial().extend(sourceIndex)),
  z.array(versionRowSchema.partial().extend(sourceIndex)),
  z.array(importRow.partial().extend(sourceIndex)),
  z.array(issueRow.extend(sourceIndex)),
]);

const counts = {
  needed_count: z.int().nonnegative(),
  version_count: z.int().nonnegative(),
  import_count: z.int().nonnegative(),
  issue_count: z.int().nonnegative(),
  limitation_count: z.int().nonnegative(),
};

/** Source coverage remains distinct from page coverage, including an empty partial page. */
export const elfDependenciesSummarySchema = elfDependenciesReportSchema
  .omit({
    needed: true,
    imports: true,
    issues: true,
    limitations: true,
    version_requirements: true,
  })
  .extend(counts);

const readReport = createAnalysisViewResultReader(elfDependenciesSchema);

const flattenVersions = (report: ElfDependencies) =>
  report.version_requirements.files.flatMap((file) =>
    file.versions.map((version) => ({
      file: file.file,
      name: version.name,
      hash: version.hash,
      flags: version.flags,
      index: version.index,
    })),
  );

/** Read selected dynamic-dependency facts without reopening the artifact. */
export const projectElfDependenciesView = (
  parent: AnalysisViewParent,
  view: AdmittedView,
) => {
  const invalid = (message: string) =>
    err(
      analysisViewInputError([
        { path: ["view"], reason: "invalid_value", message },
      ]),
    );
  if (view.kind !== "summary" && view.kind !== "elf-dependencies")
    return invalid(
      "ELF dependency Evidence supports summary and elf-dependencies views.",
    );
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof elfDependenciesViewRequestSchema>
  >(view, "summary", "elf-dependencies");
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const versions = flattenVersions(report);
  const summary = {
    artifact: report.artifact,
    format: report.format,
    byte_order: report.byte_order,
    machine: report.machine,
    architecture: report.architecture,
    type: report.type,
    type_name: report.type_name,
    interpreter: report.interpreter,
    dynamic: report.dynamic,
    version_definitions: report.version_definitions,
    derived_version_maxima: report.derived_version_maxima,
    coverage: report.coverage,
    needed_count: report.needed.length,
    version_count: versions.length,
    import_count: report.imports.length,
    issue_count: report.issues.length,
    limitation_count: report.limitations.length,
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_elf_dependencies" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations: boundedViewMessages(
      [...parent.limitations, ...report.limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns:
      report.coverage.status === "complete"
        ? []
        : [
            report.coverage.reason ??
              "Dynamic-dependency coverage is incomplete; no-match pages do not prove absence.",
          ],
  };
  if (view.kind === "summary")
    return ok({
      ...shared,
      kind: "summary",
      view,
      summary,
      coverage: completeWithinViewCoverage(
        report.needed.length,
        report.needed.length,
      ),
    });
  const indices =
    view.indices === undefined ? undefined : new Set(view.indices);
  if (view.collection === "issues") {
    const selected =
      indices === undefined
        ? {
            rows: report.issues
              .slice(view.offset, view.offset + view.limit)
              .map((row, index) => ({
                ...row,
                source_index: view.offset + index,
              })),
            total: report.issues.length,
          }
        : selectViewRows(
            report.issues,
            view,
            (_, index) => indices.has(index),
            (row, source_index) => ({ ...row, source_index }),
          );
    return ok({
      ...shared,
      kind: "elf-dependencies",
      view,
      dependencies: summary,
      items: selected.rows,
      coverage: pageViewCoverage(
        view.offset,
        selected.rows.length,
        selected.total,
      ),
    });
  }
  const names = view.names === undefined ? undefined : new Set(view.names);
  if (view.collection === "needed") {
    const allowed = neededRow.keyof().options;
    const fields =
      view.fields === undefined ? allowed : [...new Set(view.fields)];
    if (fields.some((field) => !allowed.includes(field)))
      return invalid(
        `Selected needed fields do not belong to DT_NEEDED rows; available fields: ${allowed.join(", ")}.`,
      );
    const columns = new Set<string>(fields);
    const projectRow = (
      row: ElfDependencies["needed"][number],
      source_index: number,
    ) => ({
      ...Object.fromEntries(
        Object.entries(row).filter(([key]) => columns.has(key)),
      ),
      source_index,
    });
    const selected =
      names === undefined && indices === undefined
        ? {
            rows: report.needed
              .slice(view.offset, view.offset + view.limit)
              .map((row, index) => projectRow(row, view.offset + index)),
            total: report.needed.length,
          }
        : selectViewRows(
            report.needed,
            view,
            (row, index) =>
              (indices === undefined || indices.has(index)) &&
              (names === undefined ||
                (row.name !== null && names.has(row.name))),
            projectRow,
          );
    return ok({
      ...shared,
      kind: "elf-dependencies",
      view,
      dependencies: summary,
      items: selected.rows,
      coverage: pageViewCoverage(
        view.offset,
        selected.rows.length,
        selected.total,
      ),
    });
  }
  if (view.collection === "versions") {
    const allowed = versionRowSchema.keyof().options;
    const fields =
      view.fields === undefined ? allowed : [...new Set(view.fields)];
    if (fields.some((field) => !allowed.includes(field)))
      return invalid(
        `Selected version fields do not belong to GNU version-requirement rows; available fields: ${allowed.join(", ")}.`,
      );
    const columns = new Set<string>(fields);
    const projectRow = (
      row: (typeof versions)[number],
      source_index: number,
    ) => ({
      ...Object.fromEntries(
        Object.entries(row).filter(([key]) => columns.has(key)),
      ),
      source_index,
    });
    const selected =
      names === undefined && indices === undefined
        ? {
            rows: versions
              .slice(view.offset, view.offset + view.limit)
              .map((row, index) => projectRow(row, view.offset + index)),
            total: versions.length,
          }
        : selectViewRows(
            versions,
            view,
            (row, index) =>
              (indices === undefined || indices.has(index)) &&
              (names === undefined ||
                (row.name !== null && names.has(row.name))),
            projectRow,
          );
    return ok({
      ...shared,
      kind: "elf-dependencies",
      view,
      dependencies: summary,
      items: selected.rows,
      coverage: pageViewCoverage(
        view.offset,
        selected.rows.length,
        selected.total,
      ),
    });
  }
  const allowed = importRow.keyof().options;
  const fields =
    view.fields === undefined ? allowed : [...new Set(view.fields)];
  if (fields.some((field) => !allowed.includes(field)))
    return invalid(
      `Selected import fields do not belong to undefined-symbol rows; available fields: ${allowed.join(", ")}.`,
    );
  const columns = new Set<string>(fields);
  const projectRow = (
    row: ElfDependencies["imports"][number],
    source_index: number,
  ) => ({
    ...Object.fromEntries(
      Object.entries(row).filter(([key]) => columns.has(key)),
    ),
    source_index,
  });
  const selected =
    names === undefined && indices === undefined
      ? {
          rows: report.imports
            .slice(view.offset, view.offset + view.limit)
            .map((row, index) => projectRow(row, view.offset + index)),
          total: report.imports.length,
        }
      : selectViewRows(
          report.imports,
          view,
          (row, index) =>
            (indices === undefined || indices.has(index)) &&
            (names === undefined || (row.name !== null && names.has(row.name))),
          projectRow,
        );
  return ok({
    ...shared,
    kind: "elf-dependencies",
    view,
    dependencies: summary,
    items: selected.rows,
    coverage: pageViewCoverage(
      view.offset,
      selected.rows.length,
      selected.total,
    ),
  });
};
