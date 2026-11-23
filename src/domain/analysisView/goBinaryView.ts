import { z } from "zod";
import {
  goBinarySchema,
  goBuildInfoSchema,
  goModuleMetadataSchema,
  goModuleSchema,
  goStringLiteralSchema,
  goStringLiteralsSchema,
  type GoBinary,
} from "../go/goBinary.js";
import { err, ok } from "../result.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import { requireMetadataReportSubject } from "./metadataReportSubject.js";
import {
  ownedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
  unavailableViewCoverage,
} from "./analysisViewCoverage.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";
import { selectIndexedViewRows, selectViewRows } from "./selectViewRows.js";

const indexSchema = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
const settingSchema = goModuleMetadataSchema.shape.settings.element;
const page = {
  kind: z.literal("go"),
  indices: z.array(indexSchema).optional(),
  offset: indexSchema.default(0),
  limit: z.number().int().positive().default(64),
};

/** Exact filters intersect; empty arrays select none. Offsets count matching rows. */
export const goBinaryViewRequestSchema = z.discriminatedUnion("collection", [
  z.strictObject({
    ...page,
    collection: z.literal("dependencies"),
    paths: z.array(z.string()).optional(),
    fields: z.array(goModuleSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("settings"),
    keys: z.array(z.string()).optional(),
    fields: z.array(settingSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...page,
    collection: z.literal("string_literals"),
    values: z.array(z.string()).optional(),
    contains: z.string().min(1).optional(),
    fields: z.array(goStringLiteralSchema.keyof()).optional(),
  }),
]);

export const goBinaryViewPageSchema = z.discriminatedUnion("collection", [
  z.strictObject({
    collection: z.literal("dependencies"),
    rows: z.array(goModuleSchema.partial().extend({ index: indexSchema })),
  }),
  z.strictObject({
    collection: z.literal("settings"),
    rows: z.array(settingSchema.partial().extend({ index: indexSchema })),
  }),
  z.strictObject({
    collection: z.literal("string_literals"),
    rows: z.array(
      goStringLiteralSchema.partial().extend({ index: indexSchema }),
    ),
  }),
]);

export const goBinaryViewContextSchema = z.strictObject({
  source_coverage: z.strictObject({
    build_info_available: z.boolean(),
    module_parse_complete: z.boolean().nullable(),
    runtime_dependencies: z.literal("unknown"),
    // domain-vocabulary: whether the optional static (ptr, len) scan was not requested, finished within its budgets, or stopped at a budget.
    string_literals: z.enum(["not-requested", "complete", "truncated"]),
  }),
});

export const goBinarySummarySchema = z.strictObject({
  bytes: count,
  format: goBinarySchema.shape.format,
  architecture: goBinarySchema.shape.architecture,
  bits: goBinarySchema.shape.bits,
  byte_order: goBinarySchema.shape.byte_order,
  selected_slice: goBinarySchema.shape.selected_slice,
  build_info: goBuildInfoSchema
    .omit({
      go_version_bytes_base64: true,
      module_text: true,
      module_bytes_base64: true,
      module: true,
    })
    .extend({
      module: goModuleMetadataSchema
        .omit({
          dependencies: true,
          settings: true,
          unparsed_lines: true,
          unparsed_line_bytes_base64: true,
        })
        .extend({
          available_counts: z.strictObject({
            dependencies: count,
            settings: count,
            unparsed_lines: count,
            unparsed_line_bytes_base64: count,
          }),
        }),
    })
    .nullable(),
  string_literals: goStringLiteralsSchema
    .omit({ items: true })
    .extend({ available_count: count })
    .exactOptional(),
});

const parseReport = createAnalysisViewResultReader(goBinarySchema);

const GO_BINARY_RUNTIME_UNKNOWN =
  "Embedded build records do not establish complete runtime dependencies or target behavior.";

/** Unknowns owned by the Go build-information view. Other projections reuse them. */
export const goBinaryUnknowns = (
  report: GoBinary,
): {
  readonly values: readonly string[];
  readonly required: readonly string[];
} => {
  const info = report.build_info;
  const stringLiterals = report.string_literals;
  return {
    required: [GO_BINARY_RUNTIME_UNKNOWN],
    values: [
      GO_BINARY_RUNTIME_UNKNOWN,
      ...(info === null
        ? [
            "Build information is unavailable; language and dependencies remain unknown.",
          ]
        : [
            ...(info.module.complete
              ? []
              : [
                  "Some module records were not parsed; consult the complete parent Evidence for original lines and bytes.",
                ]),
            ...(info.module.main === null
              ? [
                  "No main module was decoded; embedded dependency coverage remains unknown.",
                ]
              : []),
          ]),
      ...(stringLiterals === undefined
        ? []
        : [
            "Recovered string_literals reflect static (ptr, len) pairs into read-only data; stack/immediate strings and runtime reachability remain unknown.",
            ...(stringLiterals.truncated
              ? [
                  "Static (ptr, len) string_literals were truncated by item, aggregate-byte or scan budgets; additional candidates remain uninspected.",
                ]
              : []),
          ]),
    ],
  };
};

/** Query the existing metadata owner's facts; never reopen or reinterpret a file. */
export const projectGoBinaryView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<
    SummaryAnalysisView | z.output<typeof goBinaryViewRequestSchema>
  >(admitted, "summary", "go");
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Go build Evidence supports summary, go and cyclonedx views.",
        },
      ]),
    );
  const parsed = parseReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const subject = requireMetadataReportSubject(
    parent,
    report,
    "Go parent subject must identify the report's exact artifact.",
  );
  if (!subject.ok) return subject;
  const info = report.build_info;
  const unknowns = goBinaryUnknowns(report);
  const stringLiterals = report.string_literals;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_go_binary" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    source_coverage: {
      build_info_available: info !== null,
      module_parse_complete: info?.module.complete ?? null,
      runtime_dependencies: "unknown" as const,
      string_literals:
        stringLiterals === undefined
          ? ("not-requested" as const)
          : stringLiterals.truncated
            ? ("truncated" as const)
            : ("complete" as const),
    },
    limitations: boundedViewMessages(
      [...parent.limitations, ...report.limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: boundedViewMessages(
      unknowns.values,
      parent.evidenceId,
      "unknowns",
      unknowns.required,
    ),
  };
  if (view.kind === "summary") {
    let stringSummary: z.output<
      typeof goBinarySummarySchema
    >["string_literals"];
    if (stringLiterals !== undefined) {
      const { items, ...facts } = stringLiterals;
      stringSummary = { ...facts, available_count: items.length };
    }
    return ok({
      kind: "summary" as const,
      view,
      ...shared,
      summary: {
        bytes: report.artifact.bytes,
        format: report.format,
        architecture: report.architecture,
        bits: report.bits,
        byte_order: report.byte_order,
        ...(report.selected_slice === undefined
          ? {}
          : { selected_slice: report.selected_slice }),
        build_info:
          info === null
            ? null
            : {
                header_offset: info.header_offset,
                encoding: info.encoding,
                go_version: info.go_version,
                version_location: info.version_location,
                module_location: info.module_location,
                module: {
                  path: info.module.path,
                  main: info.module.main,
                  complete: info.module.complete,
                  available_counts: {
                    dependencies: info.module.dependencies.length,
                    settings: info.module.settings.length,
                    unparsed_lines: info.module.unparsed_lines.length,
                    unparsed_line_bytes_base64:
                      info.module.unparsed_line_bytes_base64.length,
                  },
                },
              },
        ...(stringSummary === undefined
          ? {}
          : {
              string_literals: stringSummary,
            }),
      },
      coverage: completeWithinViewCoverage(1),
    });
  }
  const indices =
    view.indices === undefined ? undefined : new Set(view.indices);
  const fields =
    view.fields === undefined ? undefined : new Set<string>(view.fields);
  if (view.collection === "string_literals") {
    if (stringLiterals === undefined)
      return err(
        analysisViewInputError([
          {
            path: ["view", "collection"],
            reason: "invalid_value",
            message:
              "Parent Go Evidence did not collect string_literals; re-run inspect_go_binary with include_string_literals: true.",
          },
        ]),
      );
    const values = view.values === undefined ? undefined : new Set(view.values);
    const needle = view.contains;
    const matchLiteral = (
      row: (typeof stringLiterals.items)[number],
    ): boolean =>
      (values?.has(row.value) ?? true) &&
      (needle === undefined || row.value.includes(needle));
    const projectLiteral = (
      row: (typeof stringLiterals.items)[number],
      index: number,
    ) => ({
      index,
      ...((fields?.has("value") ?? true) && { value: row.value }),
      ...((fields?.has("location") ?? true) && { location: row.location }),
      ...((fields?.has("first_header_offset") ?? true) && {
        first_header_offset: row.first_header_offset,
      }),
      ...((fields?.has("reference_count") ?? true) && {
        reference_count: row.reference_count,
      }),
    });
    const selected =
      indices === undefined
        ? selectViewRows(
            stringLiterals.items,
            view,
            matchLiteral,
            projectLiteral,
          )
        : selectIndexedViewRows(
            stringLiterals.items,
            indices,
            view,
            matchLiteral,
            projectLiteral,
          );
    return ok({
      kind: "go" as const,
      view,
      ...shared,
      page: { collection: "string_literals" as const, rows: selected.rows },
      coverage: pageViewCoverage(
        view.offset,
        selected.rows.length,
        selected.total,
      ),
    });
  }
  if (info === null)
    return ok({
      kind: "go" as const,
      view,
      ...shared,
      page: { collection: view.collection, rows: [] },
      coverage: unavailableViewCoverage(),
    });
  if (view.collection === "dependencies") {
    const paths = view.paths === undefined ? undefined : new Set(view.paths);
    const matchDep = (
      row: (typeof info.module.dependencies)[number],
    ): boolean => paths?.has(row.path) ?? true;
    const projectDep = (
      row: (typeof info.module.dependencies)[number],
      index: number,
    ) => ({
      index,
      ...((fields?.has("path") ?? true) && { path: row.path }),
      ...((fields?.has("version") ?? true) && { version: row.version }),
      ...((fields?.has("sum") ?? true) && { sum: row.sum }),
      ...((fields?.has("replacement") ?? true) && {
        replacement: row.replacement,
      }),
    });
    const selected =
      indices === undefined
        ? selectViewRows(info.module.dependencies, view, matchDep, projectDep)
        : selectIndexedViewRows(
            info.module.dependencies,
            indices,
            view,
            matchDep,
            projectDep,
          );
    return ok({
      kind: "go" as const,
      view,
      ...shared,
      page: { collection: "dependencies" as const, rows: selected.rows },
      coverage: pageViewCoverage(
        view.offset,
        selected.rows.length,
        selected.total,
      ),
    });
  }
  const keys = view.keys === undefined ? undefined : new Set(view.keys);
  const matchSetting = (row: (typeof info.module.settings)[number]): boolean =>
    keys?.has(row.key) ?? true;
  const projectSetting = (
    row: (typeof info.module.settings)[number],
    index: number,
  ) => ({
    index,
    ...((fields?.has("key") ?? true) && { key: row.key }),
    ...((fields?.has("value") ?? true) && { value: row.value }),
  });
  const selected =
    indices === undefined
      ? selectViewRows(info.module.settings, view, matchSetting, projectSetting)
      : selectIndexedViewRows(
          info.module.settings,
          indices,
          view,
          matchSetting,
          projectSetting,
        );
  return ok({
    kind: "go" as const,
    view,
    ...shared,
    page: { collection: "settings" as const, rows: selected.rows },
    coverage: pageViewCoverage(
      view.offset,
      selected.rows.length,
      selected.total,
    ),
  });
};
