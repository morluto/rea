import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_MAVEN_GRADLE_METADATA_FILE_BYTES = 16 * 1024 * 1024;

export const MAVEN_GRADLE_METADATA_LIMIT_MAXIMA = {
  max_file_bytes: MAX_INSPECT_MAVEN_GRADLE_METADATA_FILE_BYTES,
} as const;

/** Detected metadata document; classification is from content, not the suffix. */
export const MAVEN_GRADLE_METADATA_FORMATS = [
  "maven-pom",
  "gradle-module",
] as const;
export type MavenGradleMetadataFormat =
  (typeof MAVEN_GRADLE_METADATA_FORMATS)[number];

const nullableText = z.string().min(1).nullable();

const PROPERTY_REFERENCE = /\$\{([^}]+)\}/gu;

/** Every distinct interpolatable property a Maven/Gradle spelling still names, in order. */
export const mavenPropertyReferences = (value: string | null): string[] =>
  value === null
    ? []
    : [...new Set(Array.from(value.matchAll(PROPERTY_REFERENCE), (m) => m[0]))];

/** Classify a requested version as spelled, without interpolating or resolving. */
export const mavenRequestedVersionKind = (
  value: string | null,
): "literal" | "range" | "property" | "missing" => {
  if (value === null) return "missing";
  if (mavenPropertyReferences(value).length > 0) return "property";
  if (/[[(]/u.test(value)) return "range";
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
  version_kind: z.enum(["literal", "range", "property", "missing"]),
  gradle_version: gradleVersionSchema.nullable(),
  scope: nullableText,
  type: nullableText,
  optional: z.boolean().nullable(),
  optional_spelling: nullableText,
  classifier: nullableText,
  exclusions: z.array(exclusionSchema),
  origin: z.enum([
    "dependencies",
    "dependencyManagement",
    "variant-dependencies",
    "variant-constraints",
  ]),
  variant: nullableText,
  bom_import: z.boolean(),
  platform: z.boolean(),
});

const unresolvedSchema = z.strictObject({
  kind: z.enum(["property", "parent-coordinate", "missing-coordinate"]),
  reference: z.string().min(1),
  field: z.enum([
    "group_id",
    "artifact_id",
    "version",
    "packaging",
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
    })
    .nullable(),
  dependency_count: uint,
  constraint_count: uint,
});

/** Observed Maven POM or Gradle module metadata; unresolved references stay explicit. */
export const mavenGradleMetadataSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  format: z.enum(MAVEN_GRADLE_METADATA_FORMATS),
  coordinates: coordinateSchema,
  parent: coordinateSchema
    .extend({
      relative_path: nullableText,
      relative_path_declared: z.boolean(),
    })
    .nullable(),
  properties: z.array(
    z.strictObject({
      name: z.string().min(1),
      value: nullableText,
    }),
  ),
  dependencies: z.array(dependencySchema),
  dependency_management: z.array(dependencySchema),
  gradle: z
    .strictObject({
      format_version: nullableText,
      created_by_gradle: nullableText,
      variants: z.array(gradleVariantSchema),
    })
    .nullable(),
  unresolved: z.array(unresolvedSchema),
  coverage: z.strictObject({
    status: z.literal("complete"),
    examined_bytes: uint,
  }),
  limitations: z.array(z.string().min(1)).min(1),
});

export type MavenGradleMetadata = z.infer<typeof mavenGradleMetadataSchema>;
export type InspectMavenGradleMetadataInput = z.infer<
  typeof inspectMavenGradleMetadataInputSchema
>;
export type MavenGradleDependency = MavenGradleMetadata["dependencies"][number];
export type MavenGradleUnresolved = MavenGradleMetadata["unresolved"][number];
