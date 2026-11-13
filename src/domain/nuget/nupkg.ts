import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_NUGET_NUPKG_FILE_BYTES = 536870912;
/** Hard ceiling on ZIP members inventoried in one package. */
export const MAX_INSPECT_NUGET_NUPKG_ENTRIES = 65536;
/** Hard ceiling on decoded .nuspec bytes. */
export const MAX_INSPECT_NUGET_NUPKG_NUSPEC_BYTES = 16 * 1024 * 1024;

export const NUGET_NUPKG_LIMIT_MAXIMA = {
  max_file_bytes: MAX_INSPECT_NUGET_NUPKG_FILE_BYTES,
  max_entries: MAX_INSPECT_NUGET_NUPKG_ENTRIES,
  max_nuspec_bytes: MAX_INSPECT_NUGET_NUPKG_NUSPEC_BYTES,
} as const;

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

const FOLDER_ROLES: Readonly<Record<string, NugetNupkgEntryRole>> = {
  lib: "lib",
  ref: "ref",
  runtimes: "runtimes",
  native: "native",
  analyzers: "analyzers",
  buildtransitive: "buildTransitive",
  buildmultitargeting: "buildMultiTargeting",
  build: "build",
  contentfiles: "contentFiles",
  content: "content",
  tools: "tools",
};

/** Logical ZIP path with unified separators and without a leading `./`. */
export const nugetNupkgLogicalPath = (name: string): string =>
  name.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");

/** Folder convention for one ZIP member name; unknown when no convention matches. */
export const nugetNupkgEntryRole = (name: string): NugetNupkgEntryRole => {
  const logical = nugetNupkgLogicalPath(name);
  const lower = logical.toLowerCase();
  if (
    lower === "[content_types].xml" ||
    lower.startsWith("_rels/") ||
    lower.endsWith(".rels")
  )
    return "opc";
  if (lower.endsWith(".nuspec")) return "nuspec";
  const slash = lower.indexOf("/");
  const head = slash === -1 ? lower : lower.slice(0, slash);
  return FOLDER_ROLES[head] ?? "unknown";
};

/** Complete bounded inspection of one NuGet .nupkg ZIP. */
export const inspectNugetNupkgInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a NuGet .nupkg package",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(16)
    .max(MAX_INSPECT_NUGET_NUPKG_FILE_BYTES)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_NUGET_NUPKG_ENTRIES)
    .default(4096)
    .describe(
      "Maximum ZIP entries to inventory; exceeding the budget fails without partial success",
    ),
  max_nuspec_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_NUGET_NUPKG_NUSPEC_BYTES)
    .default(1048576)
    .describe(
      "Maximum .nuspec bytes to decode; exceeding the budget fails without partial success",
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
      commit: nullableText,
      branch: nullableText,
    })
    .nullable(),
  dependency_groups: z.array(dependencyGroupSchema),
  contents: z.array(contentSchema),
  nuspec: z
    .strictObject({
      path: z.string().min(1),
      bytes: uint,
      source: z.enum(["opc-relationship", "root-nuspec"]),
    })
    .nullable(),
  coverage: z.strictObject({
    status: z.literal("complete"),
    entries: uint,
    examined_nuspec_bytes: uint,
  }),
  limitations: z.array(z.string().min(1)).min(1),
});

export type NugetNupkg = z.infer<typeof nugetNupkgSchema>;
export type InspectNugetNupkgInput = z.infer<
  typeof inspectNugetNupkgInputSchema
>;
