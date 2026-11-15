import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_RPM_PACKAGE_FILE_BYTES = 536870912;
/** Hard ceiling on signature or main-header index entries. */
export const MAX_INSPECT_RPM_PACKAGE_HEADER_INDEX_ENTRIES = 65536;
/** Hard ceiling on header file-inventory rows. */
export const MAX_INSPECT_RPM_PACKAGE_FILES = 1048576;
/** Hard ceiling on one scriptlet's stored text when the caller requests it. */
export const MAX_INSPECT_RPM_PACKAGE_SCRIPT_BYTES = 16 * 1024 * 1024;

export const RPM_PACKAGE_LIMIT_MAXIMA = {
  max_file_bytes: MAX_INSPECT_RPM_PACKAGE_FILE_BYTES,
  max_header_index_entries: MAX_INSPECT_RPM_PACKAGE_HEADER_INDEX_ENTRIES,
  max_files: MAX_INSPECT_RPM_PACKAGE_FILES,
  max_script_bytes: MAX_INSPECT_RPM_PACKAGE_SCRIPT_BYTES,
} as const;

/** Complete bounded inspection of one RPM lead, signature header, and main header. */
export const inspectRpmPackageInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to an RPM package",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(16)
    .max(MAX_INSPECT_RPM_PACKAGE_FILE_BYTES)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_header_index_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_RPM_PACKAGE_HEADER_INDEX_ENTRIES)
    .default(4096)
    .describe(
      "Maximum index entries in the signature or main header; exceeding the budget fails without treating the count as zero",
    ),
  max_files: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_RPM_PACKAGE_FILES)
    .default(16384)
    .describe(
      "Maximum header file-inventory rows; exceeding the budget fails without a partial file list",
    ),
  include_script_text: z
    .boolean()
    .default(false)
    .describe(
      "Include scriptlet source text when true; omitted by default and never executed",
    ),
  max_script_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_RPM_PACKAGE_SCRIPT_BYTES)
    .default(1048576)
    .describe(
      "Maximum bytes of one scriptlet's stored text when include_script_text is true (default 1 MiB)",
    ),
});

const nullableText = z.string().min(1).nullable();
const range = z.strictObject({ offset, bytes: offset });

export const RPM_PACKAGE_TYPES = ["binary", "source"] as const;
export type RpmPackageType = (typeof RPM_PACKAGE_TYPES)[number];

export const RPM_DEPENDENCY_COMPARISONS = ["<", "<=", "=", ">=", ">"] as const;
export type RpmDependencyComparison =
  (typeof RPM_DEPENDENCY_COMPARISONS)[number];

export const RPM_DEPENDENCY_SETS = [
  "provides",
  "requires",
  "conflicts",
  "obsoletes",
  "recommends",
  "suggests",
  "supplements",
  "enhances",
] as const;
export type RpmDependencySet = (typeof RPM_DEPENDENCY_SETS)[number];

export const RPM_SCRIPTLET_KINDS = [
  "prein",
  "postin",
  "preun",
  "postun",
  "pretrans",
  "posttrans",
  "trigger",
] as const;
export type RpmScriptletKind = (typeof RPM_SCRIPTLET_KINDS)[number];

export const RPM_FILE_DIGEST_ALGORITHMS = [
  "md5",
  "sha1",
  "ripemd160",
  "md2",
  "tiger192",
  "haval-5-160",
  "sha256",
  "sha384",
  "sha512",
  "sha224",
] as const;
export type RpmFileDigestAlgorithm =
  (typeof RPM_FILE_DIGEST_ALGORITHMS)[number];

const dependencySchema = z.strictObject({
  name: z.string().min(1),
  version: nullableText,
  flags: uint.nullable(),
  comparison: z.enum(RPM_DEPENDENCY_COMPARISONS).nullable(),
  rpmlib: z.boolean(),
  scriptlet_only: z.boolean().nullable(),
});

const signatureBlobSchema = z.strictObject({
  present: z.literal(true),
  tag: z.enum(["pgp", "gpg", "rsa", "dsa"]),
  bytes: uint,
  algorithm: nullableText,
  key_id: z
    .string()
    .regex(/^[0-9a-f]+$/u)
    .nullable(),
});

const scriptletSchema = z.strictObject({
  kind: z.enum(RPM_SCRIPTLET_KINDS),
  interpreter: nullableText,
  bytes: uint,
  text: z.string().nullable(),
  trigger_names: z.array(z.string()).nullable(),
});

const fileSchema = z.strictObject({
  path: z.string().min(1),
  size: offset.nullable(),
  mode: uint.nullable(),
  digest: z
    .string()
    .regex(/^[0-9a-f]+$/u)
    .nullable(),
  digest_algorithm: z.enum(RPM_FILE_DIGEST_ALGORITHMS).nullable(),
  digest_algorithm_id: uint.nullable(),
  flags: uint.nullable(),
  config: z.boolean().nullable(),
  doc: z.boolean().nullable(),
  user: nullableText,
  group: nullableText,
});

/** Observed RPM lead, signature header, main-header metadata, and payload location. */
export const rpmPackageSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: offset,
  }),
  lead: z.strictObject({
    magic: z.literal("edabeedb"),
    version: z.strictObject({ major: uint, minor: uint }),
    type: z.enum(RPM_PACKAGE_TYPES),
    arch_number: uint,
    os_number: uint,
    name: nullableText,
    signature_type: uint,
    location: range,
  }),
  signature: z
    .strictObject({
      location: range,
      pad_bytes: uint,
      index_entries: uint,
      store_bytes: uint,
      size: offset.nullable(),
      md5: z
        .string()
        .regex(/^[0-9a-f]{32}$/u)
        .nullable(),
      sha1_header: nullableText,
      sha256_header: nullableText,
      payload_digest: nullableText,
      payload_digest_algorithm: uint.nullable(),
      blobs: z.array(signatureBlobSchema),
    })
    .nullable(),
  header: z.strictObject({
    location: range,
    index_entries: uint,
    store_bytes: uint,
    immutable_region: z
      .strictObject({
        present: z.literal(true),
        store_offset: offset,
        bytes: uint,
      })
      .nullable(),
  }),
  package: z.strictObject({
    name: nullableText,
    version: nullableText,
    release: nullableText,
    epoch: uint.nullable(),
    arch: nullableText,
    os: nullableText,
    summary: nullableText,
    license: nullableText,
    vendor: nullableText,
    packager: nullableText,
    url: nullableText,
    build_time: uint.nullable(),
    build_host: nullableText,
    source_rpm: nullableText,
    payload_format: nullableText,
    payload_compressor: nullableText,
    payload_flags: nullableText,
  }),
  provides: z.array(dependencySchema).nullable(),
  requires: z.array(dependencySchema).nullable(),
  conflicts: z.array(dependencySchema).nullable(),
  obsoletes: z.array(dependencySchema).nullable(),
  recommends: z.array(dependencySchema).nullable(),
  suggests: z.array(dependencySchema).nullable(),
  supplements: z.array(dependencySchema).nullable(),
  enhances: z.array(dependencySchema).nullable(),
  scriptlets: z.array(scriptletSchema).nullable(),
  files: z.array(fileSchema).nullable(),
  payload: z.strictObject({
    offset,
    size: offset,
    format: nullableText,
    compressor: nullableText,
    flags: nullableText,
    listing_source: z.literal("header"),
  }),
  coverage: z.strictObject({
    status: z.literal("complete"),
    header_tags: uint,
    files: uint.nullable(),
    dependencies: uint.nullable(),
  }),
  limitations: z.array(z.string().min(1)).min(1),
});

export type RpmPackage = z.infer<typeof rpmPackageSchema>;
export type InspectRpmPackageInput = z.infer<
  typeof inspectRpmPackageInputSchema
>;
export type RpmDependency = z.infer<typeof dependencySchema>;
export type RpmSignatureBlob = z.infer<typeof signatureBlobSchema>;
export type RpmScriptlet = z.infer<typeof scriptletSchema>;
export type RpmPackageFile = z.infer<typeof fileSchema>;
