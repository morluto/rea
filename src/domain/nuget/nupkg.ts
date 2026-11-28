import type { AnalysisParameterLimit } from "../analysisSettings.js";
import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import { coverageStatusSchema } from "../coverage.js";

/** Format identity for typed NuGet package parse failures. */
export const NUGET_NUPKG_FORMAT = "nuget-nupkg";

const uint = z.number().int().min(0).max(0xffffffff);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_NUGET_NUPKG_FILE_BYTES = 536870912;
/** Hard ceiling on ZIP members inventoried in one package. */
export const MAX_INSPECT_NUGET_NUPKG_ENTRIES = 65536;
/** Hard ceiling on decoded .nuspec bytes. */
export const MAX_INSPECT_NUGET_NUPKG_NUSPEC_BYTES = 16 * 1024 * 1024;

/** Each per-call budget's schema bounds and omitted value. */
export const NUGET_NUPKG_BUDGETS = {
  max_file_bytes: {
    minimum: 16,
    maximum: MAX_INSPECT_NUGET_NUPKG_FILE_BYTES,
    // Above nuget.org's 250 MB package ceiling. The ZIP is read by range and
    // hashed in one streaming pass; only the .nuspec and directory are retained.
    default_value: 256 * 1024 * 1024,
  },
  max_entries: {
    minimum: 1,
    maximum: MAX_INSPECT_NUGET_NUPKG_ENTRIES,
    default_value: 4096,
  },
  max_nuspec_bytes: {
    minimum: 1,
    maximum: MAX_INSPECT_NUGET_NUPKG_NUSPEC_BYTES,
    default_value: 1024 * 1024,
  },
} as const;
export type NugetNupkgBudget = keyof typeof NUGET_NUPKG_BUDGETS;

/** The per-call control that stopped a package read, from the schema's bounds. */
export const nugetNupkgBudgetLimit = (
  parameter: NugetNupkgBudget,
  effectiveValue: number,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter,
  effective_value: effectiveValue,
  unit: parameter === "max_entries" ? "count" : "bytes",
  ...NUGET_NUPKG_BUDGETS[parameter],
  applies_at: "next_call",
});

/** Path-derived NuGet folder roles; restore-time asset selection is not observed. */
export const NUGET_NUPKG_ENTRY_ROLES = [
  "lib",
  "ref",
  "runtimes",
  "native",
  "analyzers",
  "build",
  "buildTransitive",
  "buildMultiTargeting",
  "content",
  "contentFiles",
  "tools",
  "nuspec",
  "opc",
  "unknown",
] as const;
export type NugetNupkgEntryRole = (typeof NUGET_NUPKG_ENTRY_ROLES)[number];

// A Map so arbitrary payload folder names never resolve inherited properties.
const FOLDER_ROLES: ReadonlyMap<string, NugetNupkgEntryRole> = new Map([
  ["lib", "lib"],
  ["ref", "ref"],
  ["runtimes", "runtimes"],
  ["native", "native"],
  ["analyzers", "analyzers"],
  ["buildtransitive", "buildTransitive"],
  ["buildmultitargeting", "buildMultiTargeting"],
  ["build", "build"],
  ["contentfiles", "contentFiles"],
  ["content", "content"],
  ["tools", "tools"],
]);

/** Logical ZIP path with unified separators and without a leading `./`. */
export const nugetNupkgLogicalPath = (name: string): string =>
  name.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");

/** Folder convention for one ZIP member name; unknown when no convention matches. */
export const nugetNupkgEntryRole = (name: string): NugetNupkgEntryRole => {
  const logical = nugetNupkgLogicalPath(name);
  const lower = logical.toLowerCase();
  // NuGet excludes `_rels/`, `package/` and `[Content_Types].xml` from package
  // files; `nuget pack` writes the OPC core properties part under
  // `package/services/metadata/core-properties/`.
  if (
    lower === "[content_types].xml" ||
    lower.startsWith("_rels/") ||
    lower.startsWith("package/") ||
    lower.endsWith(".rels")
  )
    return "opc";
  if (lower.endsWith(".nuspec")) return "nuspec";
  const slash = lower.indexOf("/");
  const head = slash === -1 ? lower : lower.slice(0, slash);
  return FOLDER_ROLES.get(head) ?? "unknown";
};

/** Complete bounded inspection of one NuGet .nupkg ZIP. */
export const inspectNugetNupkgInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a NuGet .nupkg package",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(NUGET_NUPKG_BUDGETS.max_file_bytes.minimum)
    .max(NUGET_NUPKG_BUDGETS.max_file_bytes.maximum)
    .default(NUGET_NUPKG_BUDGETS.max_file_bytes.default_value)
    .describe(
      `Maximum stable artifact bytes to read (default ${String(NUGET_NUPKG_BUDGETS.max_file_bytes.default_value)})`,
    ),
  max_entries: z
    .number()
    .int()
    .min(NUGET_NUPKG_BUDGETS.max_entries.minimum)
    .max(NUGET_NUPKG_BUDGETS.max_entries.maximum)
    .default(NUGET_NUPKG_BUDGETS.max_entries.default_value)
    .describe(
      "Maximum ZIP entries to inventory; exceeding the budget fails without partial success",
    ),
  max_nuspec_bytes: z
    .number()
    .int()
    .min(NUGET_NUPKG_BUDGETS.max_nuspec_bytes.minimum)
    .max(NUGET_NUPKG_BUDGETS.max_nuspec_bytes.maximum)
    .default(NUGET_NUPKG_BUDGETS.max_nuspec_bytes.default_value)
    .describe(
      "Maximum expanded bytes to decode for the .nuspec and the OPC _rels/.rels member; exceeding the budget fails without partial success",
    ),
});

const nullableText = z.string().min(1).nullable();

const dependencySchema = z.strictObject({
  id: nullableText,
  version: nullableText,
  include: nullableText,
  exclude: nullableText,
  development_dependency: z.boolean().nullable(),
});

const dependencyGroupSchema = z.strictObject({
  target_framework: nullableText,
  dependencies: z.array(dependencySchema),
});

const contentSchema = z.strictObject({
  /** ZIP member name as stored in the archive. */
  name: z.string().min(1),
  /** Name with separators normalized and leading `./` removed; drives role and lookup. */
  path: z.string().min(1),
  uncompressed_size: z.number().int().nonnegative().nullable(),
  compressed_size: z.number().int().nonnegative().nullable(),
  role: z.enum(NUGET_NUPKG_ENTRY_ROLES),
  encrypted: z.boolean(),
});

/** Observed .nupkg identity, dependency groups, and ZIP inventory; unknowns stay null. */
export const nugetNupkgSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  identity: z
    .strictObject({
      id: nullableText,
      version: nullableText,
      authors: nullableText,
      description: nullableText,
    })
    .nullable(),
  license: z
    .strictObject({
      type: z.enum(["expression", "file"]).nullable(),
      value: nullableText,
    })
    .nullable(),
  repository: z
    .strictObject({
      type: nullableText,
      url: nullableText,
      url_credentials_redacted: z.boolean(),
      commit: nullableText,
      branch: nullableText,
    })
    .nullable(),
  dependency_groups: z.array(dependencyGroupSchema),
  contents: z.array(contentSchema),
  nuspec: z
    .strictObject({
      path: z.string().min(1),
      bytes: uint
        .nullable()
        .describe(
          "Decoded manifest bytes; null when the member was not extracted",
        ),
      source: z.enum(["opc-relationship", "root-nuspec"]),
    })
    .nullable(),
  coverage: z.strictObject({
    // Unknown when the central directory leaves member-region bytes
    // unaccounted for: local entries it omits may exist there.
    status: coverageStatusSchema,
    entries: uint,
    examined_nuspec_bytes: uint,
  }),
  limitations: z.array(z.string().min(1)).min(1),
});

export type NugetNupkg = z.infer<typeof nugetNupkgSchema>;
export type InspectNugetNupkgInput = z.infer<
  typeof inspectNugetNupkgInputSchema
>;
