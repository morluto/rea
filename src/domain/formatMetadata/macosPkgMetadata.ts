import { z } from "zod";
import { offset, uint32 } from "./primitives.js";

const macosPkgChecksumSchema = z.strictObject({
  algorithm: z.string(),
  value: z.string(),
});

const macosPkgRefusalSchema = z.strictObject({
  code: z.enum([
    "truncated-header",
    "header-version",
    "toc-past-eof",
    "toc-inflate",
    "toc-xml",
    "heap-out-of-bounds",
    "unsupported-encoding",
    "unsupported-compression",
    "gzip-inflate",
    "cpio-malformed",
    "oversize",
    "extracted-size-mismatch",
  ]),
  message: z.string(),
  path: z.string().nullable(),
});

const macosPkgCpioMemberSchema = z.strictObject({
  name: z.string(),
  kind: z.enum(["file", "directory", "symlink", "other"]),
  mode: uint32,
  uid: uint32,
  gid: uint32,
  size: offset,
  symlink_target: z.string().nullable(),
});

/**
 * XAR header, installer documents, and bounded Scripts/Payload inventory for a
 * macOS flat installer package. Signature certificates are named, not verified.
 */
export const macosPkgMetadataSchema = z.strictObject({
  kind: z.literal("macos-pkg"),
  xar: z.strictObject({
    magic: z.string(),
    header_size: uint32.nullable(),
    version: uint32.nullable(),
    toc_compressed_length: offset.nullable(),
    toc_uncompressed_length: offset.nullable(),
    checksum_algorithm: z.string().nullable(),
    checksum_algorithm_id: uint32.nullable(),
    heap_offset: offset.nullable(),
    heap_length: offset.nullable(),
  }),
  signature: z.strictObject({
    present: z.boolean(),
    toc_signature: z.boolean(),
    toc_x_signature: z.boolean(),
    algorithm: z.string().nullable(),
    certificate_count: uint32,
    certificates: z.array(
      z.strictObject({
        subject_cn: z.string().nullable(),
        issuer_cn: z.string().nullable(),
      }),
    ),
    verification: z.literal("not_verified"),
  }),
  archive_kind: z.enum(["product", "component", "unknown"]),
  distribution: z
    .strictObject({
      title: z.string().nullable(),
      pkg_refs: z.array(
        z.strictObject({
          id: z.string().nullable(),
          version: z.string().nullable(),
          install_kbytes: uint32.nullable(),
        }),
      ),
      choices: z.array(z.string()),
      allowed_os_versions: z.array(
        z.strictObject({
          min: z.string().nullable(),
          max: z.string().nullable(),
        }),
      ),
      installation_check_script_bytes: uint32.nullable(),
      volume_check_script_bytes: uint32.nullable(),
    })
    .nullable(),
  packages: z.array(
    z.strictObject({
      path: z.string(),
      identifier: z.string().nullable(),
      version: z.string().nullable(),
      install_location: z.string().nullable(),
      auth: z.string().nullable(),
      postinstall_action: z.string().nullable(),
      bundles: z.array(
        z.strictObject({
          id: z.string().nullable(),
          path: z.string().nullable(),
          cf_bundle_identifier: z.string().nullable(),
          cf_bundle_version: z.string().nullable(),
        }),
      ),
      preinstall: z.string().nullable(),
      postinstall: z.string().nullable(),
    }),
  ),
  scripts: z.strictObject({
    present: z.boolean(),
    compression: z.enum([
      "gzip-cpio-odc",
      "cpio-odc",
      "pbzx",
      "unsupported",
      "unread",
      "absent",
    ]),
    preinstall: z.boolean(),
    postinstall: z.boolean(),
    members: z.array(macosPkgCpioMemberSchema),
  }),
  payload: z.strictObject({
    present: z.boolean(),
    compression: z.enum([
      "gzip-cpio-odc",
      "cpio-odc",
      "pbzx",
      "unsupported",
      "unread",
      "absent",
    ]),
    members: z.array(macosPkgCpioMemberSchema),
  }),
  bom: z.strictObject({
    present: z.boolean(),
    path: z.string().nullable(),
    size: offset.nullable(),
  }),
  refusals: z.array(macosPkgRefusalSchema),
});
export type MacosPkgMetadata = z.infer<typeof macosPkgMetadataSchema>;
export type MacosPkgRefusal = z.infer<typeof macosPkgRefusalSchema>;

export const macosPkgEntryMetadataSchema = z.strictObject({
  kind: z.literal("macos-pkg-entry"),
  role: z.enum(["xar-file", "scripts-member", "payload-member"]),
  encoding: z.string().nullable(),
  data_offset: offset.nullable(),
  archived_length: offset.nullable(),
  extracted_size: offset.nullable(),
  archived_checksum: macosPkgChecksumSchema.nullable(),
  extracted_checksum: macosPkgChecksumSchema.nullable(),
  mode: uint32.nullable(),
  uid: uint32.nullable(),
  gid: uint32.nullable(),
  symlink_target: z.string().nullable(),
});
export type MacosPkgEntryMetadata = z.infer<typeof macosPkgEntryMetadataSchema>;
