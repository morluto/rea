import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import {
  bytePatternFields,
  decodeBytePattern,
  validateBytePattern,
} from "./bytePattern.js";

/**
 * Raw file bytes are addressed by absolute offset into the file as stored on
 * disk. They are not program memory addresses: a loader-adjusted address in an
 * analyzed program (read_bytes, search_bytes) generally differs from the file
 * offset of the same byte.
 */

/** Largest slice one inspect_raw_bytes call can return. */
export const MAX_RAW_BYTES_LENGTH = 4096;
/** Hex-dump lines kept before and after a match when context is requested. */
export const MAX_RAW_BYTE_CONTEXT_LINES = 8;
/** Longest pattern, in bytes, that search_raw_bytes admits. */
export const MAX_RAW_BYTE_PATTERN_BYTES = 256;
/** Maximum character length of input pattern and mask strings. */
export const MAX_RAW_BYTE_PATTERN_TEXT_LENGTH = 2048;
/** Largest page of matches one search_raw_bytes call returns. */
export const MAX_RAW_BYTE_MATCHES = 1000;
/** Bytes per hex-dump line. */
export const HEX_DUMP_LINE_BYTES = 16;

const offsetSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const inspectRawBytesInputSchema = z.strictObject({
  path: localPathStringSchema,
  offset: offsetSchema
    .default(0)
    .describe(
      "Absolute byte offset into the file on disk, not a memory address",
    ),
  length: z
    .number()
    .int()
    .min(1)
    .max(MAX_RAW_BYTES_LENGTH)
    .describe(`Bytes to read, 1 to ${String(MAX_RAW_BYTES_LENGTH)}`),
});

export const searchRawBytesInputSchema = z
  .strictObject({
    path: localPathStringSchema,
    pattern: bytePatternFields.pattern
      .max(MAX_RAW_BYTE_PATTERN_TEXT_LENGTH)
      .describe(bytePatternFields.pattern.description ?? ""),
    mask: bytePatternFields.mask
      .unwrap()
      .max(MAX_RAW_BYTE_PATTERN_TEXT_LENGTH)
      .optional()
      .describe(bytePatternFields.mask.description ?? ""),
    start_offset: offsetSchema
      .default(0)
      .describe("Absolute file offset where the scan starts (default 0)"),
    max_matches: z
      .number()
      .int()
      .min(1)
      .max(MAX_RAW_BYTE_MATCHES)
      .default(100)
      .describe(`Matches per page, 1 to ${String(MAX_RAW_BYTE_MATCHES)}`),
    context_lines: z
      .number()
      .int()
      .min(0)
      .max(MAX_RAW_BYTE_CONTEXT_LINES)
      .default(0)
      .describe(
        `Hex-dump lines shown before and after each match, 0 to ${String(MAX_RAW_BYTE_CONTEXT_LINES)}`,
      ),
  })
  .superRefine((value, context) => {
    validateBytePattern(value, context);
    if (decodeBytePattern(value).value.length > MAX_RAW_BYTE_PATTERN_BYTES)
      context.addIssue({
        code: "custom",
        path: ["pattern"],
        message: `Pattern is limited to ${String(MAX_RAW_BYTE_PATTERN_BYTES)} bytes`,
      });
  });

const artifactSchema = z.strictObject({
  path: z.string(),
  bytes: offsetSchema,
});

export const inspectRawBytesSchema = z.strictObject({
  artifact: artifactSchema,
  window: z.strictObject({ offset: offsetSchema, length: offsetSchema }),
  data_hex: z.string().regex(/^(?:[0-9a-f]{2})*$/u),
  hex_dump: z.string(),
  limitations: z.array(z.string()),
});
export type InspectRawBytes = z.infer<typeof inspectRawBytesSchema>;

export const searchRawBytesSchema = z.strictObject({
  artifact: artifactSchema,
  pattern_bytes: z.int().min(1).max(MAX_RAW_BYTE_PATTERN_BYTES),
  start_offset: offsetSchema,
  matches: z
    .array(z.strictObject({ offset: offsetSchema, context: z.string() }))
    .max(MAX_RAW_BYTE_MATCHES),
  complete: z.boolean(),
  next_offset: offsetSchema.nullable(),
  limitations: z.array(z.string()),
});
export type SearchRawBytes = z.infer<typeof searchRawBytesSchema>;

const hex = (byte: number): string => byte.toString(16).padStart(2, "0");

/**
 * Render bytes in xxd layout: eight-digit absolute offset, sixteen bytes in
 * four-hex-digit groups, then printable ASCII with `.` for everything else.
 * A short last line is padded so the ASCII column stays aligned.
 */
export const formatHexDump = (
  bytes: Uint8Array,
  baseOffset: number,
): string => {
  const hexWidth = (HEX_DUMP_LINE_BYTES / 2) * 5 - 1;
  const lines: string[] = [];
  for (let start = 0; start < bytes.length; start += HEX_DUMP_LINE_BYTES) {
    const line = bytes.subarray(start, start + HEX_DUMP_LINE_BYTES);
    const groups: string[] = [];
    let ascii = "";
    for (let index = 0; index < line.length; index += 2)
      groups.push(
        `${hex(line[index]!)}${index + 1 < line.length ? hex(line[index + 1]!) : ""}`,
      );
    for (const byte of line)
      ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
    lines.push(
      `${(baseOffset + start).toString(16).padStart(8, "0")}: ${groups.join(" ").padEnd(hexWidth)}  ${ascii}`,
    );
  }
  return lines.join("\n");
};
