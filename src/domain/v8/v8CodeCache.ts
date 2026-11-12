import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * Hard ceiling on the caller-selected input read budget. The payload scan is a
 * single synchronous pass, so this bounds how long one request can hold the
 * process; it matches the pinned CPython pyc reader's 64 MiB ceiling.
 */
export const MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES = 67108864;
/** Hard ceiling on the V8 code cache container header this reader accepts. */
export const V8_CODE_CACHE_HEADER_BYTES = 32;
/**
 * V8 stamps every serialized code cache with `0xC0DE0000 ^ ExternalReferenceTable::kSize`.
 * Only the high half is stable across builds, so the low half is a build fingerprint and
 * is never used as an admission condition.
 */
export const V8_CODE_CACHE_MAGIC_HIGH = 0xc0de;
/** Hard ceiling on reported embedded byte-pattern observations. */
export const MAX_INSPECT_V8_CODE_CACHE_STRINGS = 65536;
/** Shortest printable run reported as a byte-pattern observation. */
export const MIN_INSPECT_V8_CODE_CACHE_STRING_BYTES = 4;

/** Upper bound the input schema admits for `min_string_bytes`. */
export const MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES = 256;
/** Longest single reported run; longer runs are truncated and said to be truncated. */
export const MAX_INSPECT_V8_CODE_CACHE_STRING_BYTES = 4096;
/** `vm.compileFunction` sets this bit in the source-length word. */
export const V8_CODE_CACHE_COMPILE_FUNCTION_BIT = 0x20000000;

/**
 * Bit 30 of the source-length word marks `vm.SourceTextModule` output.
 *
 * Measured on Node 24.22.1: a module cache reads `0x40000013` for a 19-unit source and a
 * script cache reads `0x00000013` for the same length. The source-length mask is
 * `0x1fffffff`, so this bit and the function bit are both outside it.
 */
export const V8_CODE_CACHE_MODULE_BIT = 0x40000000;
/**
 * Bit 31 of the source-length word marks a module cache written by V8 before 13.4.
 *
 * Those builds compute the word as `source_length | kModuleFlagMask` with
 * `kModuleFlagMask = 1 << 31` (`SerializedCodeData::SourceHash`); 13.4 moved the flag to
 * bit 30. Measured on Electron 30.1.2 (V8 12.4.254.20): a 23-unit module source reads
 * `0x80000017`. Node 22 runs V8 12.4, so its module caches carry this bit.
 */
export const V8_CODE_CACHE_LEGACY_MODULE_BIT = 0x80000000;
/** Source length occupies the low bits of that word. */
export const V8_CODE_CACHE_SOURCE_LENGTH_MASK = 0x1fffffff;

/** Bounded inspection of one V8 code cache container. Never executes the payload. */
export const inspectV8CodeCacheInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to the selected V8 code cache (.jsc) file",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(36)
    .max(MAX_INSPECT_V8_CODE_CACHE_FILE_BYTES)
    .default(32 * 1024 * 1024)
    .describe(
      "Maximum stable artifact bytes to read; exceeding the budget fails without partial success",
    ),
  max_strings: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_V8_CODE_CACHE_STRINGS)
    .default(4096)
    .describe(
      "Maximum embedded byte-pattern observations to report; exceeding the budget fails without partial success",
    ),
  min_string_bytes: z
    .number()
    .int()
    .min(MIN_INSPECT_V8_CODE_CACHE_STRING_BYTES)
    .max(MAX_INSPECT_V8_CODE_CACHE_MIN_STRING_BYTES)
    .default(MIN_INSPECT_V8_CODE_CACHE_STRING_BYTES)
    .describe("Shortest printable run reported as one observation"),
});

export type InspectV8CodeCacheInput = z.infer<
  typeof inspectV8CodeCacheInputSchema
>;

/** Every header role is reported as observed, with how confident that role is. */
export const V8_CODE_CACHE_FIELD_STATUSES = [
  "confirmed",
  "inferred",
  "unconfirmed",
] as const;

/**
 * One 32-bit header word. `role` names what the reader believes the word is; `status`
 * says whether that role is demonstrated, inferred from behaviour, or merely observed.
 * The container is version-dependent, so this table is data, not a fixed ABI.
 */
const headerFieldSchema = z.strictObject({
  /** Byte offset of this word inside the container header. */
  offset: uint,
  /** The observed little-endian value. */
  value: uint,
  role: z.string().min(1),
  status: z.enum(V8_CODE_CACHE_FIELD_STATUSES),
});

const headerSchema = z.strictObject({
  /** The full observed magic word. Its low half is a V8 build fingerprint. */
  magic: uint,
  /** High half of the magic, the only part stable across V8 builds. */
  magic_build_stable: uint,
  /** Every header word, in container order. */
  fields: z.array(headerFieldSchema).length(8),
  /** Bytes this reader treats as header before the payload begins. */
  header_bytes: uint,
  /** Source length in UTF-16 code units, as recorded by the producer, if determinable. */
  source_length: uint.nullable(),
  /**
   * Producer family observed from the source-length word.
   *
   * V8 sets bit 29 for `vm.compileFunction` and bit 30 for `vm.SourceTextModule`, the two
   * upper bits the source-length mask leaves out. Measured on Node 24.22.1: a module cache
   * reads `0x40000013` for a 19-unit source, so a producer check that only looks at the
   * function bit reports a module cache as a plain script.
   *
   * `unknown` is the unflagged case, and it is not `vm.Script` for certain: whether V8
   * marks a function cache at all is a build detail. Measured on Node 24.22.1 a
   * `vm.compileFunction` cache reads `0x20000004` for a 4-unit source while Node 22.23.4
   * writes `0x00000004` for the same call. An unflagged word is therefore either
   * `vm.Script` or a `vm.compileFunction` cache from a build that does not mark it, and
   * the file carries nothing that separates the two.
   */
  producer: z.enum(["script", "compile_function", "module", "unknown"]),
});

/** One printable run found in the payload. An observation, not a decoded heap object. */
const embeddedStringSchema = z.strictObject({
  /** Absolute byte offset in the selected file. */
  offset,
  bytes: uint,
  /** How many bytes were retained; shorter than `bytes` when the run was truncated. */
  retained_bytes: uint,
  truncated: z.boolean(),
  text: z.string(),
});

export const v8CodeCacheSchema = z
  .strictObject({
    artifact: z.strictObject({
      path: absoluteLocalPathStringSchema,
      sha256: digestSchema,
      bytes: offset,
    }),
    header: headerSchema,
    payload: z.strictObject({
      offset,
      bytes: offset,
      sha256: digestSchema,
      /** Header bytes after the container header that are not part of the declared payload. */
      trailing_bytes: offset,
    }),
    /**
     * Byte-pattern observations inside the payload. Presence of a literal here is not
     * proof V8 retained it as a heap string, and absence is not proof it did not.
     */
    embedded_strings: z.array(embeddedStringSchema),
    coverage: z.strictObject({
      status: z.literal("complete"),
      /** Payload bytes examined for printable runs. */
      scanned_bytes: offset,
      strings: uint,
    }),
    limitations: z.array(z.string().min(1)).min(1),
  })
  .superRefine((report, context) => {
    if (report.header.header_bytes !== V8_CODE_CACHE_HEADER_BYTES)
      context.addIssue({
        code: "custom",
        path: ["header", "header_bytes"],
        message: "This reader only accepts its pinned container header size.",
      });
    if (report.header.magic_build_stable !== V8_CODE_CACHE_MAGIC_HIGH)
      context.addIssue({
        code: "custom",
        path: ["header", "magic_build_stable"],
        message:
          "The admitted magic must carry the stable V8 code cache high half.",
      });
    if (report.payload.offset + report.payload.bytes !== report.artifact.bytes)
      context.addIssue({
        code: "custom",
        path: ["payload", "bytes"],
        message:
          "The declared payload length must reach the end of the selected file.",
      });
    if (report.coverage.strings !== report.embedded_strings.length)
      context.addIssue({
        code: "custom",
        path: ["coverage", "strings"],
        message:
          "Observation coverage disagrees with the listed embedded strings.",
      });
    if (report.coverage.scanned_bytes !== report.payload.bytes)
      context.addIssue({
        code: "custom",
        path: ["coverage", "scanned_bytes"],
        message: "Complete coverage must examine every declared payload byte.",
      });
    report.embedded_strings.forEach((observation, index) => {
      if (observation.retained_bytes > observation.bytes)
        context.addIssue({
          code: "custom",
          path: ["embedded_strings", index, "retained_bytes"],
          message: "A retained prefix cannot exceed the observed run length.",
        });
      if (
        observation.truncated !==
        observation.retained_bytes < observation.bytes
      )
        context.addIssue({
          code: "custom",
          path: ["embedded_strings", index, "truncated"],
          message: "Truncation must agree with the retained byte count.",
        });
      if (
        observation.offset < report.payload.offset ||
        observation.offset + observation.bytes > report.artifact.bytes
      )
        context.addIssue({
          code: "custom",
          path: ["embedded_strings", index, "offset"],
          message: "An observation must lie inside the declared payload.",
        });
    });
  });

export type V8CodeCache = z.infer<typeof v8CodeCacheSchema>;
