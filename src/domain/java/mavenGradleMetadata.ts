import { z } from "zod";
import type { AnalysisParameterLimit } from "../analysisSettings.js";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_MAVEN_GRADLE_METADATA_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Per-call report allowances (`report_limits`): each field's omitted value and
 * the maximum the schema accepts. Each bounds a collection that expands a few
 * input bytes into a much larger report:
 *
 * - `dependency_rows`: dependency plus constraint rows. A row spelled in two
 *   or three input bytes (`{}` or `<dependency/>`) becomes a full row and up
 *   to three unresolved records; the largest published BOMs declare a few
 *   thousand rows.
 * - `variants`: Gradle variants in one module file; published modules,
 *   including Kotlin Multiplatform roots, declare at most a few hundred.
 * - `exclusions`: dependency exclusions summed over every row.
 * - `unresolved_records`: expanded property-reference and coordinate-gap
 *   records.
 * - `xml_nodes`: XML nodes in one Maven POM, counted as a stream before the
 *   document tree is built; each costs hundreds of bytes of tree.
 * - `repeated_variant_name_chars`: variant-name characters repeated across
 *   Gradle dependency and constraint rows (name length times rows).
 */
export const MAVEN_GRADLE_REPORT_LIMIT_BOUNDS = {
  dependency_rows: { default_value: 65_536, unit: "count" },
  variants: { default_value: 4_096, unit: "count" },
  exclusions: { default_value: 65_536, unit: "count" },
  unresolved_records: { default_value: 65_536, unit: "count" },
  xml_nodes: { default_value: 1_048_576, unit: "count" },
  repeated_variant_name_chars: {
    default_value: 4 * 1024 * 1024,
    unit: "count",
  },
} as const;
/** Every allowance counts records or UTF-16 units held in 32-bit indices. */
const MAVEN_GRADLE_REPORT_LIMIT_MAXIMUM = 0x7fffffff;
export type MavenGradleReportLimitField =
  keyof typeof MAVEN_GRADLE_REPORT_LIMIT_BOUNDS;
export type MavenGradleReportLimits = Readonly<
  Record<MavenGradleReportLimitField, number>
>;

const reportLimitField = (field: MavenGradleReportLimitField) =>
  z
    .int()
    .min(1)
    .max(MAVEN_GRADLE_REPORT_LIMIT_MAXIMUM)
    .optional()
    .describe(
      `Default ${String(MAVEN_GRADLE_REPORT_LIMIT_BOUNDS[field].default_value)}`,
    );
export const mavenGradleReportLimitsSchema = z.strictObject({
  dependency_rows: reportLimitField("dependency_rows"),
  variants: reportLimitField("variants"),
  exclusions: reportLimitField("exclusions"),
  unresolved_records: reportLimitField("unresolved_records"),
  xml_nodes: reportLimitField("xml_nodes"),
  repeated_variant_name_chars: reportLimitField("repeated_variant_name_chars"),
});

/** Omitted fields resolve to their defaults; explicit values are kept. */
export const mavenGradleReportLimits = (
  selected?: z.infer<typeof mavenGradleReportLimitsSchema>,
): MavenGradleReportLimits => {
  const resolved: Record<string, number> = {};
  for (const field of Object.keys(
    MAVEN_GRADLE_REPORT_LIMIT_BOUNDS,
  ) as MavenGradleReportLimitField[])
    resolved[field] =
      selected?.[field] ??
      MAVEN_GRADLE_REPORT_LIMIT_BOUNDS[field].default_value;
  return resolved as MavenGradleReportLimits;
};

/** The per-call control that stopped a report, from the schema's bounds. */
export const mavenGradleReportLimit = (
  field: MavenGradleReportLimitField,
  effectiveValue: number,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter: `report_limits.${field}`,
  effective_value: effectiveValue,
  unit: MAVEN_GRADLE_REPORT_LIMIT_BOUNDS[field].unit,
  minimum: 1,
  maximum: MAVEN_GRADLE_REPORT_LIMIT_MAXIMUM,
  default_value: MAVEN_GRADLE_REPORT_LIMIT_BOUNDS[field].default_value,
  applies_at: "next_call",
});

/** `max_file_bytes`: the schema's bounds and omitted value. */
export const MAVEN_GRADLE_FILE_BYTES = {
  minimum: 1,
  maximum: MAX_INSPECT_MAVEN_GRADLE_METADATA_FILE_BYTES,
  default_value: 1024 * 1024,
} as const;

/** The per-call control that stopped the input read. */
export const mavenGradleFileBytesLimit = (
  effectiveValue: number,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter: "max_file_bytes",
  effective_value: effectiveValue,
  unit: "bytes",
  ...MAVEN_GRADLE_FILE_BYTES,
  applies_at: "next_call",
});

const nullableText = z.string().min(1).nullable();

/**
 * Property occurrences in source order, without collecting or deduplicating.
 * A `${` with no later `}` ends the scan, so matching stays linear. Consumers
 * retaining references own their admission and deduplication before storage.
 */
export function* mavenPropertyOccurrences(
  value: string | null,
): Generator<string, void> {
  if (value === null) return;
  let start = value.indexOf("${");
  while (start >= 0) {
    const close = value.indexOf("}", start + 2);
    if (close < 0) break;
    if (close > start + 2) yield value.slice(start, close + 1);
    start = value.indexOf("${", close > start + 2 ? close + 1 : start + 2);
  }
}

export const REQUESTED_VERSION_KINDS = [
  "literal",
  "range",
  "dynamic",
  "property",
  "missing",
] as const;
export type RequestedVersionKind = (typeof REQUESTED_VERSION_KINDS)[number];

// Gradle VersionRangeSelector recognizes finite, half-open, and single-value
// range spellings. Brackets within an otherwise literal version do not suffice.
// Java Pattern's default whitespace class is ASCII, including inside bounds.
const GRADLE_RANGE_WHITESPACE = String.raw` \t\n\x0b\f\r`;
const GRADLE_RANGE_SPACE = `[${GRADLE_RANGE_WHITESPACE}]*`;
const GRADLE_RANGE_BOUND = String.raw`[^${GRADLE_RANGE_WHITESPACE},\[\]()]+`;
const GRADLE_RANGE_OPEN = String.raw`[\[\](]`;
const GRADLE_RANGE_CLOSE = String.raw`[\[\])]`;
const GRADLE_RANGE_SEPARATOR = `${GRADLE_RANGE_SPACE},${GRADLE_RANGE_SPACE}`;
const GRADLE_RANGE = new RegExp(
  `^(?:${[
    `${GRADLE_RANGE_OPEN}${GRADLE_RANGE_SPACE}${GRADLE_RANGE_BOUND}${GRADLE_RANGE_SEPARATOR}${GRADLE_RANGE_BOUND}${GRADLE_RANGE_SPACE}${GRADLE_RANGE_CLOSE}`,
    String.raw`\(${GRADLE_RANGE_SEPARATOR}${GRADLE_RANGE_BOUND}${GRADLE_RANGE_SPACE}${GRADLE_RANGE_CLOSE}`,
    String.raw`${GRADLE_RANGE_OPEN}${GRADLE_RANGE_SPACE}${GRADLE_RANGE_BOUND}${GRADLE_RANGE_SEPARATOR}\)`,
    String.raw`\[${GRADLE_RANGE_SPACE}${GRADLE_RANGE_BOUND}\]`,
  ].join("|")})$`,
  "u",
);

/**
 * Classify a requested version as spelled for its document format, without
 * interpolating or resolving. Gradle also writes an exclusive lower bound as `]`,
 * and selects a version dynamically for a `+` prefix (`1.+`, `+`) or a
 * `latest.<status>` selector (`latest.release`).
 */
export const requestedVersionKind = (
  value: string | null,
  format: MavenGradleMetadataFormat,
): RequestedVersionKind => {
  if (value === null) return "missing";
  if (!mavenPropertyOccurrences(value).next().done) return "property";
  if (format === "gradle-module") {
    if (GRADLE_RANGE.test(value)) return "range";
    if (value.endsWith("+") || value.startsWith("latest.")) return "dynamic";
  } else if (value.startsWith("[") || value.startsWith("(")) return "range";
  return "literal";
};

/** Bounded inspection of one Maven POM or Gradle module-metadata document. */
export const inspectMavenGradleMetadataInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a Maven pom.xml or Gradle .module metadata file",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(MAVEN_GRADLE_FILE_BYTES.minimum)
    .max(MAVEN_GRADLE_FILE_BYTES.maximum)
    .default(MAVEN_GRADLE_FILE_BYTES.default_value)
    .describe(
      "Maximum stable artifact bytes to read; exceeding the budget fails without partial success",
    ),
  report_limits: mavenGradleReportLimitsSchema
    .optional()
    .describe(
      "Report expansion allowances for this call (positive counts): dependency_rows (dependency plus constraint rows), variants (Gradle variants), exclusions, unresolved_records (property-reference and coordinate-gap records), xml_nodes (POM XML nodes), repeated_variant_name_chars (variant-name characters repeated across rows). A refusal reports the field in details.limit.",
    ),
});

const coordinateSchema = z.strictObject({
  group_id: nullableText,
  artifact_id: nullableText,
  version: nullableText,
  packaging: nullableText,
});

const exclusionSchema = z.strictObject({
  group_id: nullableText,
  artifact_id: nullableText,
});

const gradleVersionSchema = z.strictObject({
  requires: nullableText,
  prefers: nullableText,
  strictly: nullableText,
  rejects: z.array(z.string().min(1)),
});

const dependencySchema = z.strictObject({
  group_id: nullableText,
  artifact_id: nullableText,
  version: nullableText,
  version_kind: z.enum(REQUESTED_VERSION_KINDS),
  gradle_version: gradleVersionSchema.nullable(),
  scope: nullableText,
  type: nullableText,
  optional: z.boolean().nullable(),
  optional_spelling: nullableText,
  classifier: nullableText,
  exclusions: z.array(exclusionSchema),
  variant: nullableText,
  bom_import: z.boolean(),
  platform: z.boolean(),
});

type DependencyOrigin =
  | "dependencies"
  | "dependencyManagement"
  | "variant-dependencies"
  | "variant-constraints";

const dependencyFrom = <Origin extends DependencyOrigin>(origin: Origin) =>
  dependencySchema.extend({ origin: z.literal(origin) });

const unresolvedSchema = z.strictObject({
  kind: z.enum(["property", "parent-coordinate", "missing-coordinate"]),
  reference: z.string().min(1),
  field: z.enum([
    "group_id",
    "artifact_id",
    "version",
    "packaging",
    "scope",
    "type",
    "classifier",
    "optional",
  ]),
  owner: z.enum([
    "project",
    "parent",
    "dependency",
    "dependency_management",
    "variant",
  ]),
  index: z.number().int().nonnegative().nullable(),
});

const gradleVariantSchema = z.strictObject({
  name: nullableText,
  category: nullableText,
  usage: nullableText,
  available_at: z
    .strictObject({
      group_id: nullableText,
      artifact_id: nullableText,
      version: nullableText,
      url: nullableText,
      url_credentials_redacted: z.boolean(),
    })
    .nullable(),
  dependency_count: uint,
  constraint_count: uint,
});

const metadataFacts = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  coordinates: coordinateSchema,
  properties: z.array(
    z.strictObject({
      name: z.string().min(1),
      value: nullableText,
      value_credentials_redacted: z.boolean(),
    }),
  ),
  unresolved: z.array(unresolvedSchema),
  coverage: z.strictObject({
    status: z.literal("complete"),
    examined_bytes: uint,
  }),
  limitations: z.array(z.string().min(1)).min(1),
});

/** The report format owns both its format-specific payload and row provenance. */
export const mavenGradleMetadataSchema = z.discriminatedUnion("format", [
  metadataFacts.extend({
    format: z.literal("maven-pom"),
    parent: coordinateSchema
      .extend({
        relative_path: nullableText,
        relative_path_declared: z.boolean(),
      })
      .nullable(),
    dependencies: z.array(dependencyFrom("dependencies")),
    dependency_management: z.array(dependencyFrom("dependencyManagement")),
    gradle: z.null(),
  }),
  metadataFacts.extend({
    format: z.literal("gradle-module"),
    parent: z.null(),
    dependencies: z.array(dependencyFrom("variant-dependencies")),
    dependency_management: z.array(dependencyFrom("variant-constraints")),
    gradle: z.strictObject({
      format_version: z.string().min(1),
      created_by_gradle: nullableText,
      variants: z.array(gradleVariantSchema),
    }),
  }),
]);

export type MavenGradleMetadata = z.infer<typeof mavenGradleMetadataSchema>;
export type MavenGradleMetadataFormat = MavenGradleMetadata["format"];
export type InspectMavenGradleMetadataInput = z.infer<
  typeof inspectMavenGradleMetadataInputSchema
>;
export type MavenGradleDependency<
  Origin extends DependencyOrigin = DependencyOrigin,
> = z.infer<typeof dependencySchema> & { origin: Origin };
export type MavenGradleUnresolved = MavenGradleMetadata["unresolved"][number];
