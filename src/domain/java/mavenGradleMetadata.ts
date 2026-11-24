import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_MAVEN_GRADLE_METADATA_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Fixed allowance for variant-name characters repeated across Gradle dependency
 * and constraint rows (name length times rows, summed over variants).
 */
export const MAVEN_GRADLE_METADATA_REPEATED_VARIANT_NAME_CHARS =
  4 * 1024 * 1024;

/**
 * Fixed allowance for dependency plus constraint rows in one report. A row
 * spelled in two or three input bytes (`{}` or `<dependency/>`) becomes a full
 * row and up to three unresolved records, a few hundred bytes of report; the
 * largest published BOMs declare a few thousand rows.
 */
export const MAVEN_GRADLE_METADATA_DEPENDENCY_ROWS = 65_536;

/**
 * Fixed allowance for Gradle variants in one module file. An empty variant
 * (`{}`) becomes a full variant record; published modules, including Kotlin
 * Multiplatform roots with one variant per target and usage, declare at most a
 * few hundred.
 */
export const MAVEN_GRADLE_METADATA_VARIANTS = 4_096;

/**
 * Fixed allowance for dependency exclusions summed over every row in one
 * report. An empty exclusion (`{}` or `<exclusion/>`) becomes a full exclusion
 * record; real rows exclude a handful of modules each.
 */
export const MAVEN_GRADLE_METADATA_EXCLUSIONS = 65_536;

/** Fixed allowance for expanded property-reference and coordinate-gap records. */
export const MAVEN_GRADLE_METADATA_UNRESOLVED_RECORDS = 65_536;

/**
 * Fixed allowance for XML nodes (elements, attributes, text, CDATA, comments
 * and processing instructions) in one Maven POM, counted as a stream before
 * the document tree is built. Each node costs hundreds of bytes of tree, so a
 * 16 MiB POM of tiny elements could otherwise allocate gigabytes; the
 * allowance still admits a POM at the dependency-row allowance with a dozen
 * nodes per row.
 */
export const MAVEN_GRADLE_METADATA_XML_NODES = 1_048_576;

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
    .min(1)
    .max(MAX_INSPECT_MAVEN_GRADLE_METADATA_FILE_BYTES)
    .default(1024 * 1024)
    .describe(
      "Maximum stable artifact bytes to read; exceeding the budget fails without partial success",
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
