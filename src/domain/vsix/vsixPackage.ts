import { z } from "zod";

import { BinaryReader } from "../binaryContainer.js";
import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import { coverageStatusSchema } from "../coverage.js";

/** Format identity for typed VS Code extension package parse failures. */
export const VSIX_PACKAGE_FORMAT = "vsix-package";

const uint = z.number().int().min(0).max(0xffffffff);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_VSIX_PACKAGE_FILE_BYTES = 536870912;
/** Hard ceiling on ZIP members inventoried in one package. */
export const MAX_INSPECT_VSIX_PACKAGE_ENTRIES = 65536;
/** Hard ceiling on decoded vsixmanifest / package.json bytes. */
export const MAX_INSPECT_VSIX_PACKAGE_MANIFEST_BYTES = 16 * 1024 * 1024;
/** Fixed ceiling on XML nodes a selected extension.vsixmanifest may expand into. */
export const MAX_INSPECT_VSIX_PACKAGE_MANIFEST_XML_NODES = 1_048_576;
/** Hard ceiling on decoded bytes hashed for one interesting member. */
export const MAX_INSPECT_VSIX_PACKAGE_MEMBER_BYTES = 16 * 1024 * 1024;
/** Commands listed in the contributes summary; remaining stay in the total. */
export const VSIX_COMMANDS_CAP = 32;

export const VSIX_PACKAGE_LIMIT_MAXIMA = {
  max_file_bytes: MAX_INSPECT_VSIX_PACKAGE_FILE_BYTES,
  max_entries: MAX_INSPECT_VSIX_PACKAGE_ENTRIES,
  max_manifest_bytes: MAX_INSPECT_VSIX_PACKAGE_MANIFEST_BYTES,
  max_member_bytes: MAX_INSPECT_VSIX_PACKAGE_MEMBER_BYTES,
} as const;

/** Path-derived or magic-derived ZIP member kinds for a .vsix package. */
export const VSIX_MEMBER_KINDS = [
  "vsixmanifest",
  "package_json",
  "content_types",
  "opc",
  "signature",
  "javascript",
  "native_addon",
  "wasm",
  "executable",
  "shell_script",
  "nested_archive",
  "unknown",
] as const;
export type VsixMemberKind = (typeof VSIX_MEMBER_KINDS)[number];

/** Members hashed and listed individually because they can carry native code. */
export const VSIX_INTERESTING_MEMBER_KINDS = [
  "native_addon",
  "wasm",
  "executable",
  "shell_script",
  "nested_archive",
] as const;
export type VsixInterestingMemberKind =
  (typeof VSIX_INTERESTING_MEMBER_KINDS)[number];

export const isVsixInterestingMemberKind = (
  kind: VsixMemberKind,
): kind is VsixInterestingMemberKind =>
  (VSIX_INTERESTING_MEMBER_KINDS as readonly string[]).includes(kind);

/** Logical ZIP path with unified separators and without a leading `./`. */
export const vsixPackageLogicalPath = (name: string): string =>
  name.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "");

/** True when a ZIP name leaves the package root or is an absolute path. */
export const vsixPackagePathTraverses = (name: string): boolean => {
  const logical = vsixPackageLogicalPath(name);
  if (logical.startsWith("/") || /^[a-zA-Z]:(?:\/|$)/u.test(logical))
    return true;
  return logical.split("/").includes("..");
};

const fileName = (logical: string): string => {
  const slash = logical.lastIndexOf("/");
  return slash === -1 ? logical : logical.slice(slash + 1);
};

/** Folder and suffix conventions for one ZIP member name. */
export const vsixPackagePathKind = (name: string): VsixMemberKind => {
  const logical = vsixPackageLogicalPath(name);
  const lower = logical.toLowerCase();
  if (lower === "[content_types].xml") return "content_types";
  if (lower === "extension.vsixmanifest") return "vsixmanifest";
  if (lower === "extension/package.json") return "package_json";
  if (
    lower === "extension.signature.p7s" ||
    lower === ".signature.manifest" ||
    lower.endsWith("/extension.signature.p7s") ||
    lower.endsWith("/.signature.manifest")
  )
    return "signature";
  if (
    lower === "_rels/.rels" ||
    lower.startsWith("_rels/") ||
    lower.endsWith(".rels")
  )
    return "opc";
  const base = fileName(lower);
  if (base.endsWith(".node")) return "native_addon";
  if (base.endsWith(".wasm")) return "wasm";
  if (
    base.endsWith(".sh") ||
    base.endsWith(".bash") ||
    base.endsWith(".ps1") ||
    base.endsWith(".cmd") ||
    base.endsWith(".bat")
  )
    return "shell_script";
  if (base.endsWith(".exe") || base.endsWith(".com")) return "executable";
  if (
    base.endsWith(".zip") ||
    base.endsWith(".vsix") ||
    base.endsWith(".nupkg") ||
    base.endsWith(".jar") ||
    base.endsWith(".war") ||
    base.endsWith(".ear") ||
    base.endsWith(".tar") ||
    base.endsWith(".gz") ||
    base.endsWith(".tgz") ||
    base.endsWith(".7z") ||
    base.endsWith(".rar")
  )
    return "nested_archive";
  if (base.endsWith(".js") || base.endsWith(".cjs") || base.endsWith(".mjs"))
    return "javascript";
  return "unknown";
};

/** Observed container kind from leading magic bytes; undefined when unknown. */
export const vsixMemberMagicKind = (
  bytes: Uint8Array,
): VsixMemberKind | undefined => {
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21)
    return "shell_script";
  if (bytes.length < 4) return undefined;
  const prefix = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 16)));
  const reader = new BinaryReader(prefix, true, "vsix-member");
  const b0 = reader.u8(0);
  const b1 = reader.u8(1);
  const b2 = reader.u8(2);
  const b3 = reader.u8(3);
  if (b0 === 0x00 && b1 === 0x61 && b2 === 0x73 && b3 === 0x6d) return "wasm";
  if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46)
    return "executable";
  if (b0 === 0x4d && b1 === 0x5a) return "executable";
  const be = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  if (
    be === 0xfeedface ||
    be === 0xfeedfacf ||
    be === 0xcefaedfe ||
    be === 0xcffaedfe ||
    be === 0xcafebabe ||
    be === 0xbebafeca
  )
    return "executable";
  if (b0 === 0x50 && b1 === 0x4b && (b2 === 0x03 || b2 === 0x05 || b2 === 0x07))
    return "nested_archive";
  if (b0 === 0x1f && b1 === 0x8b) return "nested_archive";
  if (b0 === 0x37 && b1 === 0x7a && b2 === 0xbc && b3 === 0xaf)
    return "nested_archive";
  return undefined;
};

/** Eager VS Code activation events that run without a later user trigger. */
export const vsixActivationIsEager = (event: string): boolean =>
  event === "*" || event === "onStartupFinished";

/** Complete bounded inspection of one VS Code .vsix ZIP. */
export const inspectVsixPackageInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a VS Code .vsix package",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(16)
    .max(MAX_INSPECT_VSIX_PACKAGE_FILE_BYTES)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_VSIX_PACKAGE_ENTRIES)
    .default(4096)
    .describe(
      "Maximum ZIP entries to inventory; exceeding the budget fails without partial success",
    ),
  max_manifest_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_VSIX_PACKAGE_MANIFEST_BYTES)
    .default(1048576)
    .describe(
      "Maximum expanded bytes to decode for extension.vsixmanifest and extension/package.json; exceeding the budget fails without partial success",
    ),
  max_member_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_VSIX_PACKAGE_MEMBER_BYTES)
    .default(1048576)
    .describe(
      "Maximum expanded bytes hashed for one native addon, wasm, executable, shell script, or nested archive; exceeding the budget lists the member without a digest",
    ),
});

const nullableText = z.string().min(1).nullable();

const identityFieldSchema = z.strictObject({
  field: z.string().min(1),
  vsixmanifest: nullableText,
  package_json: nullableText,
});

const entryPointSchema = z.strictObject({
  path: z.string().min(1),
  present: z.boolean(),
});

const activationEventSchema = z.strictObject({
  event: z.string().min(1),
  eager: z.boolean(),
});

const contributeKeySchema = z.strictObject({
  name: z.string().min(1),
  count: uint,
});

const contributeCommandSchema = z.strictObject({
  command: nullableText,
  title: nullableText,
});

const declaredIdsSchema = z.strictObject({
  vsixmanifest: z.array(z.string().min(1)),
  package_json: z.array(z.string().min(1)),
  disagreement: z.boolean(),
});

const workspaceCapabilitySchema = z
  .strictObject({
    supported: nullableText,
    description: nullableText,
  })
  .nullable();

const assetSchema = z.strictObject({
  type: nullableText,
  path: nullableText,
  present: z.boolean().nullable(),
});

const contentSchema = z.strictObject({
  name: z.string().min(1),
  path: z.string().min(1),
  uncompressed_size: z.number().int().nonnegative().nullable(),
  compressed_size: z.number().int().nonnegative().nullable(),
  encrypted: z.boolean(),
  kind: z.enum(VSIX_MEMBER_KINDS),
  traverses: z.boolean(),
});

const interestingMemberSchema = z.strictObject({
  path: z.string().min(1),
  kind: z.enum(VSIX_INTERESTING_MEMBER_KINDS),
  bytes: z.number().int().nonnegative().nullable(),
  sha256: digestSchema.nullable(),
  classification: z.enum(["observed", "inferred"]),
});

const memberKindCountsSchema = z.strictObject(
  Object.fromEntries(VSIX_MEMBER_KINDS.map((kind) => [kind, uint])) as Record<
    (typeof VSIX_MEMBER_KINDS)[number],
    typeof uint
  >,
);

/** Observed .vsix identity, manifests, and ZIP inventory; unknowns stay null. */
export const vsixPackageSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  vsix_identity: z
    .strictObject({
      id: nullableText,
      version: nullableText,
      publisher: nullableText,
      target_platform: nullableText,
      display_name: nullableText,
      description: nullableText,
    })
    .nullable(),
  package_identity: z
    .strictObject({
      name: nullableText,
      publisher: nullableText,
      version: nullableText,
    })
    .nullable(),
  identity_disagreements: z.array(identityFieldSchema),
  engine: z.strictObject({
    vsixmanifest: nullableText,
    package_json: nullableText,
    disagreement: z.boolean(),
  }),
  target_platform: nullableText,
  entry_points: z.strictObject({
    main: entryPointSchema.nullable(),
    browser: entryPointSchema.nullable(),
  }),
  activation_events: z.array(activationEventSchema),
  contributes: z.strictObject({
    keys: z.array(contributeKeySchema),
    commands: z.array(contributeCommandSchema),
    commands_total: uint,
    commands_omitted: uint,
  }),
  extension_dependencies: declaredIdsSchema,
  extension_pack: declaredIdsSchema,
  extension_kind: z.array(z.string().min(1)),
  capabilities: z.strictObject({
    untrusted_workspaces: workspaceCapabilitySchema,
    virtual_workspaces: workspaceCapabilitySchema,
  }),
  enabled_api_proposals: z.array(z.string().min(1)),
  assets: z.array(assetSchema),
  signatures: z.strictObject({
    p7s: z.boolean(),
    manifest: z.boolean(),
  }),
  contents: z.array(contentSchema),
  member_kind_counts: memberKindCountsSchema,
  interesting_members: z.array(interestingMemberSchema),
  duplicate_paths: z.array(z.string().min(1)),
  vsixmanifest: z
    .strictObject({
      path: z.string().min(1),
      bytes: uint.nullable(),
    })
    .nullable(),
  package_json: z
    .strictObject({
      path: z.string().min(1),
      bytes: uint.nullable(),
    })
    .nullable(),
  coverage: z.strictObject({
    status: coverageStatusSchema,
    entries: uint,
    examined_manifest_bytes: uint,
  }),
  limitations: z.array(z.string().min(1)).min(1),
});

export type VsixPackage = z.infer<typeof vsixPackageSchema>;
export type InspectVsixPackageInput = z.infer<
  typeof inspectVsixPackageInputSchema
>;
