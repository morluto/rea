import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_KERNEL_BUILD_CONFIG_FILE_BYTES = 536870912;
/** Hard ceiling on CONFIG_* options examined from one embedded config. */
export const MAX_INSPECT_KERNEL_BUILD_CONFIG_ENTRIES = 65536;
/** Hard ceiling on the inflated IKCFG gzip member. */
export const MAX_INSPECT_KERNEL_BUILD_CONFIG_CONFIG_BYTES = 33554432;
/** Hard ceiling on an inflated bzImage payload searched for the banner and config. */
export const MAX_INSPECT_KERNEL_BUILD_CONFIG_PAYLOAD_BYTES = 536870912;
/** Hard ceiling on one page of CONFIG_* entries. */
export const MAX_INSPECT_KERNEL_BUILD_CONFIG_PAGE = 4096;

export const KERNEL_BUILD_CONFIG_CODECS = [
  "gzip",
  "xz",
  "lz4",
  "lzma",
  "zstd",
  "bzip2",
  "lzo",
] as const;

export const KERNEL_BUILD_CONFIG_VALUE_KINDS = [
  "y",
  "m",
  "string",
  "number",
  "not_set",
] as const;

/** Reasons a framed `IKCFG_ST` ... `IKCFG_ED` blob is reported as malformed. */
export const KERNEL_BUILD_CONFIG_MALFORMED_REASONS = [
  "config_gzip_invalid",
  "config_text_invalid",
] as const;

export const KERNEL_BUILD_CONFIG_REASONS = [
  ...KERNEL_BUILD_CONFIG_MALFORMED_REASONS,
  "config_gzip_truncated",
  "config_search_exhausted",
  "payload_truncated",
  "payload_gzip_invalid",
  "payload_codec_unsupported",
  "unrecognized_payload_codec",
  "setup_header_payload_unavailable",
] as const;

const range = z.strictObject({
  /** `file` is a range in the selected image. `inflated_payload` is a range in the inflated bzImage payload. */
  space: z.enum(["file", "inflated_payload"]),
  offset: uint,
  bytes: uint,
});

/** Matches a Kconfig `int` or `hex` value as written to `.config`. */
export const KERNEL_BUILD_CONFIG_NUMBER =
  /^(?:-?(?:0|[1-9][0-9]*)|0[xX][0-9A-Fa-f]+)$/u;
/** Longest decoded string value accepted from one `.config` line. */
export const MAX_KERNEL_BUILD_CONFIG_STRING = 4096;
/** Length of the `IKCFG_ST` and `IKCFG_ED` markers. */
export const KERNEL_BUILD_CONFIG_MARKER_BYTES = 8;

const entrySchema = z.strictObject({
  name: z.string().regex(/^CONFIG_[A-Za-z0-9_]+$/u),
  kind: z.enum(KERNEL_BUILD_CONFIG_VALUE_KINDS),
  /** Null only for `not_set`. Strings are the decoded quoted text. */
  value: z.string().nullable(),
  trust: z.literal("target-derived-untrusted"),
});

const bannerSchema = z.strictObject({
  status: z.enum(["present", "absent", "unknown"]),
  text: z.string().nullable(),
  version: z.string().nullable(),
  builder: z.string().nullable(),
  compiler: z.string().nullable(),
  location: range.nullable(),
  trust: z.literal("target-derived-untrusted"),
});

const payloadSchema = z.strictObject({
  container: z.enum(["file", "bzimage"]),
  codec: z.enum(KERNEL_BUILD_CONFIG_CODECS).nullable(),
  status: z.enum([
    "uncompressed",
    "inflated",
    "unsupported",
    "truncated",
    "malformed",
    "unavailable",
  ]),
  /** File offset of a bzImage payload, or 0 for a whole-file codec. Null when the file itself was searched. */
  offset: uint.nullable(),
  bytes: uint.nullable(),
  inflated_bytes: uint.nullable(),
});

/** One bounded read of a kernel image's version banner and embedded `.config`. */
export const inspectKernelBuildConfigInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a vmlinux ELF, raw arm64 Image, x86 bzImage/zImage, or configs.ko module",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_KERNEL_BUILD_CONFIG_FILE_BYTES)
    .default(67108864)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_KERNEL_BUILD_CONFIG_ENTRIES)
    .default(16384)
    .describe(
      "Maximum CONFIG_* options to examine; exceeding the budget fails without partial success",
    ),
  max_config_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_KERNEL_BUILD_CONFIG_CONFIG_BYTES)
    .default(4194304)
    .describe(
      "Maximum inflated bytes of one IKCFG gzip member (default 4 MiB)",
    ),
  max_payload_bytes: z
    .number()
    .int()
    .min(64)
    .max(MAX_INSPECT_KERNEL_BUILD_CONFIG_PAYLOAD_BYTES)
    .default(134217728)
    .describe(
      "Maximum inflated bytes of a bzImage gzip payload (default 128 MiB)",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_INSPECT_KERNEL_BUILD_CONFIG_ENTRIES)
    .default(0)
    .describe("Number of matching CONFIG_* options to skip"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_KERNEL_BUILD_CONFIG_PAGE)
    .default(256)
    .describe("Maximum CONFIG_* options to return in this page"),
  name: z
    .string()
    .regex(/^CONFIG_[A-Za-z0-9_]+$/u)
    .optional()
    .describe(
      "Exact CONFIG_* name to return. Omitted returns every option in the page",
    ),
});

/**
 * Version banner and embedded build config. A config is present only when
 * `IKCFG_ST` is immediately followed by a gzip member whose inflated text is
 * a config and whose next bytes are `IKCFG_ED`. A framed blob whose member does
 * not decode, fails its trailer check, or whose text fails the grammar is
 * `malformed`.
 * Malformed, truncated, or unsupported input is never an absent config.
 */
export const kernelBuildConfigSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  format: z.enum(["elf", "file"]),
  payload: payloadSchema,
  next_probe: z
    .strictObject({
      operation: z
        .literal("external_decompression")
        .describe(
          "External decompression with a codec utility, not a REA tool",
        ),
      rationale: z.string().min(1),
    })
    .nullable(),
  banner: bannerSchema,
  config: z.strictObject({
    status: z.enum([
      "present",
      "absent",
      "malformed",
      "incomplete",
      "unsupported",
    ]),
    reason: z.enum(KERNEL_BUILD_CONFIG_REASONS).nullable(),
    marker: range.nullable(),
    end_marker: range.nullable(),
    gzip: range.nullable(),
    sha256: digestSchema.nullable(),
    /** CONFIG_* options in the accepted config, before the name filter and page. */
    option_count: uint,
    /** Options selected by the name filter, before the page. */
    matched_count: uint,
    offset: uint,
    limit: uint,
    name: z
      .string()
      .regex(/^CONFIG_[A-Za-z0-9_]+$/u)
      .nullable(),
    entries: z.array(entrySchema),
  }),
  coverage: z.strictObject({
    status: z.enum(["complete", "incomplete", "unsupported"]),
    examined_bytes: uint,
    examined_entries: uint,
  }),
  limitations: z.array(z.string()),
});

export type KernelBuildConfig = z.infer<typeof kernelBuildConfigSchema>;
export type InspectKernelBuildConfigInput = z.infer<
  typeof inspectKernelBuildConfigInputSchema
>;
export type KernelBuildConfigEntry =
  KernelBuildConfig["config"]["entries"][number];
