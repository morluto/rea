import { z } from "zod";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/** Resource allowances, not NuGet format limits. */
export const NUGET_PACKAGE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const NUGET_PACKAGE_MAX_ENTRIES = 20_000;
export const NUGET_PACKAGE_MAX_NUSPEC_BYTES = 4 * 1024 * 1024;
/**
 * Diagnostics are per-entry growth that `max_entries` does not bound: one
 * archive may carry thousands of rejected paths. Past this count the remaining
 * failures are summarised rather than each allocated a diagnostic.
 */
export const NUGET_PACKAGE_MAX_DIAGNOSTICS = 10_000;
export const NUGET_PACKAGE_OPERATION = "inspect_nuget_package" as const;
export const NUGET_PACKAGE_PROVIDER = {
  id: "rea-nuget-package",
  name: "REA offline NuGet package inventory",
  version: "1",
} as const;

export const nugetPackageArtifactSchema = z.strictObject({
  path: localPathStringSchema,
  sha256: digestSchema,
  bytes: z.int().nonnegative(),
});
export type NugetPackageArtifact = z.output<typeof nugetPackageArtifactSchema>;

/**
 * Identity and descriptive facts from the package's `.nuspec`. NuGet allows
 * either a flat layout or `.nuspec` files under `lib/<tfm>/`; every distinct
 * document is inventoried so a disagreement is visible rather than resolved.
 */
export const nugetNuspecSchema = z.strictObject({
  nuspec_id: prefixedDigestSchema("nuspec"),
  /** Member path inside the archive, e.g. `Example.nuspec`. */
  path: z.string(),
  bytes: z.int().nonnegative(),
  id: z.string().nullable(),
  version: z.string().nullable(),
  authors: z.string().nullable(),
  description: z.string().nullable(),
  license: z
    .strictObject({
      /** `expression` when the nuspec declares `<license type="expression">`. */
      kind: z.enum(["expression", "file"]),
      value: z.string(),
    })
    .nullable(),
  license_url: z.string().nullable(),
  project_url: z.string().nullable(),
  repository: z
    .strictObject({
      url: z.string().nullable(),
      kind: z.string().nullable(),
      branch: z.string().nullable(),
      commit: z.string().nullable(),
    })
    .nullable(),
  /** Declared dependency groups exactly as the nuspec orders them. */
  dependency_groups: z.array(
    z.strictObject({
      /** Null for the untargeted group NuGet writing tools may emit. */
      target_framework: z.string().nullable(),
      dependencies: z.array(
        z.strictObject({
          name: z.string(),
          version_range: z.string().nullable(),
          /** `exclude` attribute, verbatim; absent is not the same as empty. */
          exclude: z.string().nullable(),
          include: z.string().nullable(),
        }),
      ),
    }),
  ),
});
export type NugetNuspec = z.output<typeof nugetNuspecSchema>;

/** Asset kinds NuGet's consumer rules distinguish, keyed by their path prefix. */
export const NUGET_ASSET_KINDS = [
  "assemblies",
  "native",
  "analyzers",
  "build",
  "build-transitive",
  "build-multitargeting",
  "content",
  "content-files",
  "tools",
  "runtime",
  "resources",
  "ref",
  "docs",
  "other",
] as const;
export type NugetAssetKind = (typeof NUGET_ASSET_KINDS)[number];

export const nugetAssetSchema = z.strictObject({
  asset_id: prefixedDigestSchema("nuget_asset"),
  /** Member path inside the archive, as stored. */
  path: z.string(),
  /** Declared uncompressed bytes; null when the local header omits them. */
  bytes: z.int().nonnegative().nullable(),
  kind: z.enum(NUGET_ASSET_KINDS),
  /** Target-framework folder for lib, ref or runtimes RID lib paths; else null. */
  target_framework: z.string().nullable(),
  /** Runtime-identifier folder when the member is under runtimes/; else null. */
  runtime_identifier: z.string().nullable(),
  directory: z.boolean(),
});
export type NugetAsset = z.output<typeof nugetAssetSchema>;

export const nugetDiagnosticSchema = z.strictObject({
  diagnostic_id: prefixedDigestSchema("nuget_diagnostic"),
  /** Archive member this diagnostic is about; null for package-wide facts. */
  path: z.string().nullable(),
  code: z.enum([
    "not-a-zip-archive",
    "no-nuspec",
    "duplicate-nuspec",
    "invalid-nuspec",
    "unsupported-nuspec-doctype",
    "entry-limit-reached",
    "diagnostic-limit-reached",
    "encrypted-entry",
    "directory-entry",
    "unsafe-entry-path",
  ]),
  message: z.string(),
});
export type NugetDiagnostic = z.output<typeof nugetDiagnosticSchema>;

export const nugetPackageSchema = z.strictObject({
  package_id: prefixedDigestSchema("nuget_package"),
  format: z.literal("nupkg"),
  artifact: nugetPackageArtifactSchema,
  nuspecs: z.array(nugetNuspecSchema),
  assets: z.array(nugetAssetSchema),
  diagnostics: z.array(nugetDiagnosticSchema),
  summary: z.strictObject({
    nuspecs: z.int().nonnegative(),
    assets: z.int().nonnegative(),
    assemblies: z.int().nonnegative(),
    diagnostics: z.int().nonnegative(),
  }),
  /** What this inventory did and did not examine, stated rather than implied. */
  source_coverage: z.strictObject({
    scope: z.literal("package-contents"),
    status: z.enum(["complete-within-scope", "partial"]),
    target_framework_selection: z.literal("not-applied"),
    dependency_resolution: z.literal("not-performed"),
    signatures: z.literal("not-verified"),
    package_contents: z.literal("not-executed"),
    network: z.literal("not-contacted"),
  }),
  limitations: z.array(z.string()),
});
export type NugetPackage = z.output<typeof nugetPackageSchema>;
