import { z } from "zod";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/** Resource allowances, not Maven or XML format limits. */
export const MAVEN_POM_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAVEN_POM_OPERATION = "inspect_maven_pom" as const;
export const MAVEN_POM_PROVIDER = {
  id: "rea-maven-pom",
  name: "REA offline Maven POM inventory",
  version: "1",
} as const;

export const mavenPomArtifactSchema = z.strictObject({
  path: localPathStringSchema,
  sha256: digestSchema,
  bytes: z.int().nonnegative(),
});
export type MavenPomArtifact = z.output<typeof mavenPomArtifactSchema>;

/** A coordinate as the POM spelled it; interpolation is never attempted. */
export const mavenCoordinateSchema = z.strictObject({
  group_id: z.string().nullable(),
  artifact_id: z.string().nullable(),
  version: z.string().nullable(),
  packaging: z.string().nullable(),
});
export type MavenCoordinate = z.output<typeof mavenCoordinateSchema>;

/**
 * `managed_by` says which declaration supplied the version when the dependency
 * itself declared none: this POM's dependency-management section, or the parent
 * chain. `unresolved` covers an omitted version that no supplied metadata manages,
 * and `property` covers a version left as a `${...}` reference.
 */
export const mavenVersionOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("declared") }),
  z.strictObject({ kind: z.literal("managed"), managed_by: z.string() }),
  z.strictObject({ kind: z.literal("property") }),
  z.strictObject({ kind: z.literal("unresolved") }),
]);
export type MavenVersionOrigin = z.output<typeof mavenVersionOriginSchema>;

export const mavenDependencySchema = z.strictObject({
  dependency_id: prefixedDigestSchema("maven_dependency"),
  dependency_key: prefixedDigestSchema("maven_dependency_key"),
  group_id: z.string(),
  artifact_id: z.string(),
  version: z.string().nullable(),
  version_origin: mavenVersionOriginSchema,
  /** `dependencies` or `dependencyManagement`; managed entries are declarations, not resolutions. */
  declared_by: z.enum(["dependencies", "dependency_management"]),
  scope: z.string().nullable(),
  optional: z.boolean().nullable(),
  type: z.string().nullable(),
  classifier: z.string().nullable(),
  system_path: z.string().nullable(),
  exclusions: z.array(
    z.strictObject({
      group_id: z.string().nullable(),
      artifact_id: z.string().nullable(),
    }),
  ),
  /** The `<profile>` id this declaration sits inside, or null for the top-level section. */
  profile: z.string().nullable(),
  source_pointer: z.string(),
  line: z.int().positive().nullable(),
});
export type MavenDependency = z.output<typeof mavenDependencySchema>;

export const mavenPomDiagnosticSchema = z.strictObject({
  diagnostic_id: prefixedDigestSchema("maven_diagnostic"),
  code: z.enum([
    "doctype-unsupported",
    "malformed-xml",
    "missing-project-root",
    "missing-required-field",
    "duplicate-declaration",
    "unresolved-property",
    "unsupported-construct",
    "invalid-exclusion",
  ]),
  message: z.string(),
  source_pointer: z.string(),
  line: z.int().positive().nullable(),
});
export type MavenPomDiagnostic = z.output<typeof mavenPomDiagnosticSchema>;

/** A declaration whose value is still a `${...}` reference, kept rather than guessed. */
export const mavenPropertyReferenceSchema = z.strictObject({
  name: z.string(),
  declared: z.string().nullable(),
  resolved: z.string().nullable(),
  source_pointer: z.string(),
});

export const mavenRepositorySchema = z.strictObject({
  id: z.string().nullable(),
  url: z.string().nullable(),
  layout: z.string().nullable(),
});

export const mavenPomSchema = z.strictObject({
  pom_id: prefixedDigestSchema("maven_pom"),
  format: z.literal("maven-pom"),
  artifact: mavenPomArtifactSchema,
  /** `modelVersion` as declared; `4.0.0` is the only Maven model this parser reads. */
  model_version: z.string().nullable(),
  project: mavenCoordinateSchema,
  parent: mavenCoordinateSchema
    .extend({ relative_path: z.string().nullable() })
    .nullable(),
  properties: z.array(
    z.strictObject({
      name: z.string(),
      value: z.string(),
      source_pointer: z.string(),
    }),
  ),
  dependencies: z.array(mavenDependencySchema),
  dependency_management: z.array(mavenDependencySchema),
  repositories: z.array(mavenRepositorySchema),
  profiles: z.array(
    z.strictObject({
      id: z.string().nullable(),
      active_by_default: z.boolean().nullable(),
      source_pointer: z.string(),
    }),
  ),
  property_references: z.array(mavenPropertyReferenceSchema),
  diagnostics: z.array(mavenPomDiagnosticSchema),
  summary: z.strictObject({
    dependencies: z.int().nonnegative(),
    dependency_management: z.int().nonnegative(),
    managed_dependencies: z.int().nonnegative(),
    optional_dependencies: z.int().nonnegative(),
    excluded_dependencies: z.int().nonnegative(),
    profile_dependencies: z.int().nonnegative(),
    repositories: z.int().nonnegative(),
    properties: z.int().nonnegative(),
    unresolved_versions: z.int().nonnegative(),
    diagnostics: z.int().nonnegative(),
  }),
  source_coverage: z.strictObject({
    scope: z.literal("single-pom-declarations"),
    status: z.enum(["complete-within-scope", "partial"]),
    parent_pom: z.literal("not-read"),
    bom_imports: z.literal("not-resolved"),
    transitive_dependencies: z.literal("not-resolved"),
    repositories: z.literal("not-contacted"),
    build_execution: z.literal("not-attempted"),
    profile_activation: z.literal("declarations-only"),
    duplicate_declarations: z.literal("reported"),
  }),
  limitations: z.array(z.string()),
});
export type MavenPom = z.output<typeof mavenPomSchema>;

export const MAVEN_POM_LIMITATIONS = [
  "Only the selected pom.xml is read; parent POMs, imported BOMs and transitive dependencies are not fetched or resolved.",
  "Declared repository URLs are retained as data and never contacted.",
  "Profiles contribute their dependency declarations; activation conditions are reported but not evaluated.",
  "Property references in coordinates and versions are preserved, not interpolated from external sources.",
  "Dependency versions managed by an unread parent or imported BOM remain unresolved.",
] as const;
