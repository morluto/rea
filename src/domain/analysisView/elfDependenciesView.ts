import { analysisViewPageFields } from "./analysisViewPageFields.js";
import { z } from "zod";
import {
  elfDependenciesReportSchema,
  elfDependenciesSchema,
  type ElfDependencies,
} from "../native/elfDependencies.js";
import { ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";
import { namePrefixesSchema, startsWithAny } from "./namePrefixFilter.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import {
  boundedViewLimitations,
  completeWithinViewCoverage,
  selectedViewPage,
} from "./analysisViewCoverage.js";
import { filterSet, pickFields, selectViewRows } from "./selectViewRows.js";

const neededRow = elfDependenciesReportSchema.shape.needed.element;
const importRow = elfDependenciesReportSchema.shape.imports.element;
const issueRow = elfDependenciesReportSchema.shape.issues.element;
const definitionTable = elfDependenciesReportSchema.shape.version_definitions;
const definitionRow = definitionTable.shape.names.element;
const maximumRow =
  elfDependenciesReportSchema.shape.derived_version_maxima.element;
const sourceIndex = { source_index: z.int().nonnegative() };
const page = analysisViewPageFields("elf-dependencies");

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
      name_prefixes: namePrefixesSchema("DT_NEEDED names"),
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
      name_prefixes: namePrefixesSchema("version names"),
      indices: z.array(z.int().nonnegative()).optional(),
      fields: z.array(versionRowSchema.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("definitions"),
      names: z
        .array(z.string())
        .optional()
        .describe(
          "Exact GNU version-definition names. Omitted includes all names; [] matches none.",
        ),
      name_prefixes: namePrefixesSchema("GNU version-definition names"),
      indices: z.array(z.int().nonnegative()).optional(),
      fields: z.array(definitionRow.keyof()).optional(),
    }),
    z.strictObject({
      ...page,
      collection: z.literal("maxima"),
      names: z
        .array(z.string())
        .optional()
        .describe(
          "Exact version namespaces, such as GLIBC. Omitted includes all namespaces; [] matches none.",
        ),
      name_prefixes: namePrefixesSchema("version namespaces"),
      indices: z.array(z.int().nonnegative()).optional(),
      fields: z.array(maximumRow.keyof()).optional(),
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
      name_prefixes: namePrefixesSchema("undefined-symbol names"),
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
  z.array(definitionRow.partial().extend(sourceIndex)),
  z.array(maximumRow.partial().extend(sourceIndex)),
  z.array(importRow.partial().extend(sourceIndex)),
  z.array(issueRow.extend(sourceIndex)),
]);

const counts = {
  needed_count: z.int().nonnegative(),
  version_count: z.int().nonnegative(),
  definition_count: z.int().nonnegative(),
  derived_maximum_count: z.int().nonnegative(),
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
    version_definitions: true,
    derived_version_maxima: true,
  })
  .extend({
    ...counts,
    version_definitions: definitionTable.omit({ names: true }),
  });

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
  if (view.kind !== "summary" && view.kind !== "elf-dependencies")
    return invalidAnalysisView(
      "ELF dependency Evidence supports summary and elf-dependencies views.",
    );
  assertOwnedView<
    SummaryAnalysisView | z.output<typeof elfDependenciesViewRequestSchema>
  >(view, "summary", "elf-dependencies");
  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
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
    version_definitions: {
      status: report.version_definitions.status,
      location: report.version_definitions.location,
    },
    coverage: report.coverage,
    needed_count: report.needed.length,
    version_count: report.version_requirements.files.reduce(
      (count, file) => count + file.versions.length,
      0,
    ),
    definition_count: report.version_definitions.names.length,
    derived_maximum_count: report.derived_version_maxima.length,
    import_count: report.imports.length,
    issue_count: report.issues.length,
    limitation_count: report.limitations.length,
  };
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_elf_dependencies" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    limitations: boundedViewLimitations(parent, report.limitations),
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
      kind: "summary" as const,
      view,
      summary,
      coverage: completeWithinViewCoverage(report.needed.length),
    });
  const indices = filterSet(view.indices);
  if (view.collection === "issues") {
    const selected = selectViewRows(
      report.issues,
      view,
      undefined,
      (row, source_index) => ({ ...row, source_index }),
      indices,
    );
    return ok({
      ...shared,
      kind: "elf-dependencies" as const,
      view,
      dependencies: summary,
      ...selectedViewPage(view.offset, selected),
    });
  }
  const names = filterSet(view.names);
  const prefixes = view.name_prefixes;
  const pageRows = <Row extends Record<string, unknown>>(
    rows: readonly Row[],
    allowed: readonly string[],
    fieldsOf: readonly string[] | undefined,
    label: string,
    nameOf: (row: Row) => string | null,
  ) => {
    const fields = fieldsOf === undefined ? allowed : [...new Set(fieldsOf)];
    if (fields.some((field) => !allowed.includes(field)))
      return invalidAnalysisView(
        `Selected ${label} fields do not belong to those rows; available fields: ${allowed.join(", ")}.`,
      );
    const columns = new Set<string>(fields);
    const projectRow = (row: Row, source_index: number) => ({
      ...pickFields(row, columns),
      source_index,
    });
    const matchesName =
      names === undefined && prefixes === undefined
        ? undefined
        : (row: Row) => {
            const name = nameOf(row);
            return (
              name !== null &&
              (names === undefined || names.has(name)) &&
              (prefixes === undefined || startsWithAny(name, prefixes))
            );
          };
    const selected = selectViewRows(
      rows,
      view,
      matchesName,
      projectRow,
      indices,
    );
    return ok({
      ...shared,
      kind: "elf-dependencies" as const,
      view,
      dependencies: summary,
      ...selectedViewPage(view.offset, selected),
    });
  };
  switch (view.collection) {
    case "needed":
      return pageRows(
        report.needed,
        neededRow.keyof().options,
        view.fields,
        "needed",
        (row) => row.name,
      );
    case "versions":
      return pageRows(
        flattenVersions(report),
        versionRowSchema.keyof().options,
        view.fields,
        "version",
        (row) => row.name,
      );
    case "definitions":
      return pageRows(
        report.version_definitions.names,
        definitionRow.keyof().options,
        view.fields,
        "version-definition",
        (row) => row.name,
      );
    case "maxima":
      return pageRows(
        report.derived_version_maxima,
        maximumRow.keyof().options,
        view.fields,
        "derived-maximum",
        (row) => row.namespace,
      );
    case "imports":
      return pageRows(
        report.imports,
        importRow.keyof().options,
        view.fields,
        "import",
        (row) => row.name,
      );
  }
};
