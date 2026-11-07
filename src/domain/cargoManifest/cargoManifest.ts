import { z } from "zod";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/** Resource allowances, not Cargo or TOML format limits. */
export const CARGO_MANIFEST_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const CARGO_MANIFEST_FACT_BYTES = 32 * 1024 * 1024;
export const CARGO_MANIFEST_OPERATION = "inspect_cargo_manifest" as const;
export const CARGO_MANIFEST_PROVIDER = {
  id: "rea-cargo-manifest",
  name: "REA offline Cargo manifest inventory",
  version: "1",
} as const;

export const cargoManifestArtifactSchema = z.strictObject({
  path: localPathStringSchema,
  sha256: digestSchema,
  bytes: z.int().nonnegative(),
});
export type CargoManifestArtifact = z.output<
  typeof cargoManifestArtifactSchema
>;

/** A declaration carries the manifest text that produced it, never a resolution. */
export const cargoDependencySchema = z.strictObject({
  dependency_id: prefixedDigestSchema("cargo_dependency"),
  dependency_key: prefixedDigestSchema("cargo_dependency_key"),
  name: z.string(),
  alias: z.string().nullable(),
  requirement: z.string().nullable(),
  source: z.enum(["registry", "git", "path", "workspace", "unknown"]),
  source_detail: z.string().nullable(),
  /**
   * The alternate registry named beside a `path`, `git` or version source.
   * Absent when the declaration names none.
   */
  registry: z.string().nullable(),
  declared_by: z.enum(["package", "workspace"]),
  optional: z.boolean(),
  /**
   * `null` when the declaration leaves the setting to a workspace declaration
   * this reader does not open, so "unstated" never reads as "enabled".
   */
  default_features: z.boolean().nullable(),
  features: z.array(z.string()),
  target: z.string().nullable(),
  source_pointer: z.string(),
});
export type CargoDependency = z.output<typeof cargoDependencySchema>;

export const cargoDiagnosticSchema = z.strictObject({
  diagnostic_id: prefixedDigestSchema("cargo_diagnostic"),
  source_pointer: z.string(),
  code: z.enum([
    "invalid-toml",
    "unsupported-manifest-form",
    "invalid-manifest-form",
    "invalid-package-table",
    "invalid-dependency-table",
    "invalid-dependency-declaration",
    "duplicate-package-name",
    "invalid-feature-table",
  ]),
  message: z.string(),
});

export const cargoManifestSchema = z.strictObject({
  manifest_id: prefixedDigestSchema("cargo_manifest"),
  format: z.literal("cargo-toml"),
  artifact: cargoManifestArtifactSchema,
  workspace: z.strictObject({
    members: z.array(z.string()),
    excludes: z.array(z.string()),
    resolver: z.string().nullable(),
  }),
  packages: z.array(
    z.strictObject({
      package_id: prefixedDigestSchema("cargo_package"),
      name: z.string(),
      version: z.union([z.string(), z.literal("inherited")]).nullable(),
      edition: z.union([z.string(), z.literal("inherited")]).nullable(),
      rust_version: z.union([z.string(), z.literal("inherited")]).nullable(),
      source_pointer: z.string(),
      is_workspace_root: z.boolean(),
    }),
  ),
  dependencies: z.array(cargoDependencySchema),
  features: z.array(
    z.strictObject({
      name: z.string(),
      enables: z.array(z.string()),
      source_pointer: z.string(),
    }),
  ),
  diagnostics: z.array(cargoDiagnosticSchema),
  summary: z.strictObject({
    packages: z.int().nonnegative(),
    dependencies: z.int().nonnegative(),
    workspace_dependencies: z.int().nonnegative(),
    inherited_dependencies: z.int().nonnegative(),
    git_dependencies: z.int().nonnegative(),
    path_dependencies: z.int().nonnegative(),
    target_dependencies: z.int().nonnegative(),
    diagnostics: z.int().nonnegative(),
  }),
  source_coverage: z.strictObject({
    scope: z.literal("single-manifest-declarations"),
    status: z.enum(["complete-within-scope", "partial"]),
    lockfile: z.literal("not-read"),
    resolution: z.literal("not-attempted"),
    workspace_member_manifests: z.literal("not-read"),
    build_scripts: z.literal("not-executed"),
    duplicate_toml_tables: z.literal("rejected"),
  }),
  limitations: z.array(z.string()),
});
export type CargoManifest = z.output<typeof cargoManifestSchema>;
