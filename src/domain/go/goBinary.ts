import { z } from "zod";
import { binaryMetadataArchitecture } from "../binaryMetadataArchitecture.js";
import {
  machoSelectionContainsRange,
  selectedSliceAgreesWithReport,
  machoSliceArchitectureSchema,
  machoTargetSelectionSchema,
} from "../apple/machoTargetSelection.js";
import { digestSchema } from "../digests.js";
import {
  absoluteLocalPathStringSchema,
  localPathStringSchema,
} from "../localPath.js";
import { canonicalBase64Schema } from "../stringPatterns.js";

const sourceRangeSchema = z.strictObject({
  offset: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
});

export const DEFAULT_MAX_GO_STRING_LITERALS = 2000;
export const MAX_GO_STRING_LITERALS_LIMIT = 10_000;
export const MAX_GO_STRING_LITERAL_BYTES = 4096;
export const MAX_GO_STRING_AGGREGATE_BYTES = 512 * 1024;
export const MAX_GO_STRING_HEADER_SCAN_BYTES = 64 * 1024 * 1024;

export const goMaxStringLiteralsSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_GO_STRING_LITERALS_LIMIT);

/** One distinct printable UTF-8 literal inferred from static (ptr, len) headers. */
export const goStringLiteralSchema = z.strictObject({
  value: z.string().min(1),
  location: z.strictObject({
    offset: z.int().nonnegative(),
    bytes: z.int().min(1).max(MAX_GO_STRING_LITERAL_BYTES),
  }),
  first_header_offset: z.int().nonnegative(),
  reference_count: z.int().positive(),
});

/** Bounded static (ptr, len) string-header inventory, separate from observed build_info. */
export const goStringLiteralsSchema = z.strictObject({
  evidence_kind: z.literal("inferred"),
  items: z.array(goStringLiteralSchema).max(MAX_GO_STRING_LITERALS_LIMIT),
  discovered_count: z.int().nonnegative(),
  aggregate_bytes: z.int().nonnegative().max(MAX_GO_STRING_AGGREGATE_BYTES),
  max_items: goMaxStringLiteralsSchema,
  truncated: z.boolean(),
});

const moduleIdentitySchema = z.strictObject({
  path: z.string(),
  version: z.string(),
  sum: z.string().nullable(),
});

/** Module identities retain development versions, local replacements and missing sums verbatim. */
export const goModuleSchema = moduleIdentitySchema.extend({
  replacement: moduleIdentitySchema.nullable(),
});

/** Parsed records alongside unrecognized text lines and exact non-UTF-8 line bytes. */
export const goModuleMetadataSchema = z.strictObject({
  path: z.string().nullable(),
  main: goModuleSchema.nullable(),
  dependencies: z.array(goModuleSchema),
  settings: z.array(z.strictObject({ key: z.string(), value: z.string() })),
  unparsed_lines: z.array(z.string()),
  unparsed_line_bytes_base64: z.array(canonicalBase64Schema),
  complete: z.boolean(),
});

/** One exact local artifact, independent of any active disassembler target. */
export const inspectGoBinaryInputSchema = z
  .strictObject({
    path: absoluteLocalPathStringSchema.describe(
      "Absolute filesystem path to the selected executable or library",
    ),
    architecture: machoSliceArchitectureSchema.exactOptional(),
    include_string_literals: z
      .boolean()
      .exactOptional()
      .describe(
        "Also recover bounded inferred Go UTF-8 string literals referenced by static (ptr, len) headers in non-executable mapped data",
      ),
    max_string_literals: goMaxStringLiteralsSchema
      .describe(
        `Maximum distinct recovered string literals (1-${String(MAX_GO_STRING_LITERALS_LIMIT)}; default ${String(DEFAULT_MAX_GO_STRING_LITERALS)}; requires include_string_literals: true)`,
      )
      .exactOptional(),
    detail: z
      .enum(["complete", "summary"])
      .default("complete")
      .describe(
        "complete returns all metadata inline; summary retains complete Evidence and returns build identity and counts for subsequent retained Go views.",
      ),
  })
  .superRefine((input, context) => {
    if (
      input.max_string_literals !== undefined &&
      input.include_string_literals !== true
    )
      context.addIssue({
        code: "custom",
        path: ["max_string_literals"],
        message:
          "max_string_literals requires include_string_literals to be true.",
      });
  });

/** Compiler-written build information and its original file-backed source ranges. */
export const goBuildInfoSchema = z.strictObject({
  header_offset: z.int().nonnegative(),
  encoding: z.enum(["inline", "pointer"]),
  go_version: z.string().nullable(),
  go_version_bytes_base64: canonicalBase64Schema,
  module_text: z.string().nullable(),
  module_bytes_base64: canonicalBase64Schema,
  version_location: sourceRangeSchema,
  module_location: sourceRangeSchema,
  module: goModuleMetadataSchema,
});

/** Complete bounded build-metadata observation; absence does not identify a binary as non-Go. */
export const goBinarySchema = z
  .strictObject({
    artifact: z.strictObject({
      path: localPathStringSchema,
      sha256: digestSchema,
      bytes: z.int().nonnegative(),
    }),
    format: z.enum(["elf", "pe", "macho"]),
    architecture: z.string(),
    bits: z.union([z.literal(32), z.literal(64)]),
    byte_order: z.enum(["little", "big"]),
    /** The universal slice that was read; source ranges stay file offsets inside it. */
    selected_slice: machoTargetSelectionSchema.exactOptional(),
    build_info: goBuildInfoSchema.nullable(),
    string_literals: goStringLiteralsSchema.exactOptional(),
    limitations: z.array(z.string()),
  })
  .superRefine((report, context) => {
    const info = report.build_info;
    const slice = report.selected_slice;
    const stringLiterals = report.string_literals;
    const headerBytes = (report.bits / 8) * 2;
    if (
      slice !== undefined &&
      (!selectedSliceAgreesWithReport(
        slice,
        report.format,
        binaryMetadataArchitecture(report.architecture),
      ) ||
        !machoSelectionContainsRange(
          slice,
          report.artifact.bytes,
          slice.offset,
          0,
        ) ||
        (info !== null &&
          [
            { offset: info.header_offset, bytes: 32 },
            info.version_location,
            info.module_location,
          ].some(
            (range) =>
              !machoSelectionContainsRange(
                slice,
                report.artifact.bytes,
                range.offset,
                range.bytes,
              ),
          )) ||
        (stringLiterals !== undefined &&
          stringLiterals.items.some(
            (item) =>
              !machoSelectionContainsRange(
                slice,
                report.artifact.bytes,
                item.location.offset,
                item.location.bytes,
              ) ||
              !machoSelectionContainsRange(
                slice,
                report.artifact.bytes,
                item.first_header_offset,
                headerBytes,
              ),
          )))
    )
      context.addIssue({
        code: "custom",
        path: ["selected_slice"],
        message:
          "Selected universal slice must be a FAT slice of the artifact whose CPU matches the report's Mach-O architecture and that contains the reported source ranges.",
      });
    if (stringLiterals !== undefined) {
      if (stringLiterals.items.length > stringLiterals.max_items)
        context.addIssue({
          code: "custom",
          path: ["string_literals", "items"],
          message: "Recovered Go string literals exceed max_items.",
        });
      if (stringLiterals.discovered_count < stringLiterals.items.length)
        context.addIssue({
          code: "custom",
          path: ["string_literals", "discovered_count"],
          message:
            "discovered_count must be at least the number of retained string_literals items.",
        });
      if (
        stringLiterals.discovered_count > stringLiterals.items.length &&
        !stringLiterals.truncated
      )
        context.addIssue({
          code: "custom",
          path: ["string_literals", "truncated"],
          message:
            "truncated must be true when discovered_count exceeds retained items.",
        });
      let sumBytes = 0;
      let previous: GoStringLiteral | undefined;
      for (const [index, item] of stringLiterals.items.entries()) {
        sumBytes += item.location.bytes;
        if (Buffer.byteLength(item.value, "utf8") !== item.location.bytes)
          context.addIssue({
            code: "custom",
            path: ["string_literals", "items", index, "value"],
            message:
              "Decoded Go string literal UTF-8 length does not match its source byte length.",
          });
        if (
          item.location.offset > report.artifact.bytes ||
          item.location.bytes > report.artifact.bytes - item.location.offset
        )
          context.addIssue({
            code: "custom",
            path: ["string_literals", "items", index, "location"],
            message:
              "Go string literal source range is outside the selected artifact.",
          });
        if (item.first_header_offset > report.artifact.bytes - headerBytes)
          context.addIssue({
            code: "custom",
            path: ["string_literals", "items", index, "first_header_offset"],
            message:
              "Go string literal header offset is outside the selected artifact.",
          });
        if (
          previous !== undefined &&
          (item.location.offset < previous.location.offset ||
            (item.location.offset === previous.location.offset &&
              item.location.bytes <= previous.location.bytes))
        )
          context.addIssue({
            code: "custom",
            path: ["string_literals", "items", index, "location"],
            message:
              "Go string literals must be strictly ordered by (location.offset, location.bytes).",
          });
        previous = item;
      }
      if (sumBytes !== stringLiterals.aggregate_bytes)
        context.addIssue({
          code: "custom",
          path: ["string_literals", "aggregate_bytes"],
          message:
            "aggregate_bytes does not match the sum of retained Go string literal byte lengths.",
        });
    }
    if (info === null) return;
    if (info.header_offset > report.artifact.bytes - 32)
      context.addIssue({
        code: "custom",
        path: ["build_info", "header_offset"],
        message: "Build-info header is outside the selected artifact.",
      });
    for (const field of ["version_location", "module_location"] as const) {
      const range = info[field];
      if (
        range.offset > report.artifact.bytes ||
        range.bytes > report.artifact.bytes - range.offset
      )
        context.addIssue({
          code: "custom",
          path: ["build_info", field],
          message: "Build-info source range is outside the selected artifact.",
        });
    }
    for (const [field, range, description] of [
      ["go_version_bytes_base64", info.version_location, "compiler"],
      ["module_bytes_base64", info.module_location, "module"],
    ] as const) {
      const encoded = info[field];
      if (Buffer.byteLength(encoded, "base64") !== range.bytes)
        context.addIssue({
          code: "custom",
          path: ["build_info", field],
          message: `Encoded ${description} bytes do not match their reported source length.`,
        });
    }
  });

export type GoStringLiteral = z.infer<typeof goStringLiteralSchema>;
export type GoStringLiterals = z.infer<typeof goStringLiteralsSchema>;
export type GoModule = z.infer<typeof goModuleSchema>;
export type GoModuleMetadata = z.infer<typeof goModuleMetadataSchema>;
export type GoBinary = z.infer<typeof goBinarySchema>;
export type InspectGoBinaryInput = z.infer<typeof inspectGoBinaryInputSchema>;
