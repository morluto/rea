import { MFT_INLINE_HEADER_LIMIT } from "./ntfsMft.js";
import { ntfsMftMetadataSchema } from "../formatMetadata/androidAndSystemMetadata.js";
import { USN_INLINE_EXTENT_LIMIT } from "./ntfsUsnJournal.js";
import { z } from "zod";
import type { AnalysisParameterLimit } from "../analysisSettings.js";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

export const NTFS_JOURNAL_OPERATION = "inspect_ntfs_journal" as const;
export const NTFS_JOURNAL_PROVIDER = {
  id: "rea-ntfs-journal",
  name: "REA offline NTFS change journal",
  version: "1",
} as const;

/**
 * `max_file_bytes`: the per-call working-set allowance for each in-memory
 * acquisition (MFT and journal), independent of page size. Acquisitions are
 * held in memory, so host heap is an independent constraint.
 */
export const NTFS_JOURNAL_FILE_BYTES = {
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  default_value: 64 * 1024 * 1024,
} as const;

/** The per-call control that stopped an acquisition read. */
export const ntfsJournalFileBytesLimit = (
  effectiveValue: number,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter: "max_file_bytes",
  effective_value: effectiveValue,
  unit: "bytes",
  ...NTFS_JOURNAL_FILE_BYTES,
  applies_at: "next_call",
});
const offset = z.int().nonnegative();
export const ntfsJournalRowLimitSchema = z
  .int()
  .min(1)
  .max(200)
  .default(50)
  .describe(
    "Maximum journal event or coverage rows in this page (1–200; default 50).",
  );
export const ntfsJournalInputSchema = z.strictObject({
  mft_path: absoluteLocalPathStringSchema,
  journal_path: absoluteLocalPathStringSchema,
  max_file_bytes: z
    .int()
    .min(NTFS_JOURNAL_FILE_BYTES.minimum)
    .max(NTFS_JOURNAL_FILE_BYTES.maximum)
    .optional()
    .describe(
      `Bytes read into memory from each of the MFT and journal acquisitions (default ${String(NTFS_JOURNAL_FILE_BYTES.default_value)}); the whole acquisition is read, independent of page size.`,
    ),
  start_file_offset: offset
    .default(0)
    .describe(
      "Begin decoding exactly at this source offset, normally the prior nextFileOffset for unchanged input digests. Earlier bytes are not examined.",
    ),
  max_rows: ntfsJournalRowLimitSchema,
  mft_record_limit: z
    .int()
    .min(0)
    .max(MFT_INLINE_HEADER_LIMIT)
    .default(0)
    .describe(
      "MFT record details to include (0–32). Default 0 returns inventory counts. Detail pages share a 32-additional-record budget for extension metadata, with up to 32 attribute-list reference results per base record and explicit partial coverage.",
    ),
  mft_record_start: offset
    .default(0)
    .describe(
      "First MFT stream slot in the requested detail page; use next_record_header_index with unchanged acquisition digests.",
    ),
});

const sourceSchema = z.strictObject({
  path: absoluteLocalPathStringSchema,
  bytes: offset,
  sha256: digestSchema,
});
const matchSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("matched"),
    record: z.strictObject({
      index: offset,
      sequenceNumber: offset,
      fileOffset: offset,
    }),
  }),
  z.strictObject({ kind: z.enum(["unresolved", "ambiguous"]) }),
]);
const issueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("padding"),
    fileOffset: offset,
    bytes: offset,
  }),
  z.strictObject({
    kind: z.enum(["malformed", "truncated"]),
    fileOffset: offset,
  }),
  z.strictObject({
    kind: z.literal("unsupported"),
    fileOffset: offset,
    major: offset,
    minor: offset,
  }),
]);
const unsignedDecimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const signedDecimal = z.string().regex(/^(?:0|-?[1-9][0-9]*)$/u);

export const ntfsJournalResultSchema = z.strictObject({
  mft: sourceSchema,
  journal: sourceSchema,
  mftMetadata: ntfsMftMetadataSchema,
  rows: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("event"),
        event: z.strictObject({
          majorVersion: z.union([z.literal(2), z.literal(3), z.literal(4)]),
          referenceBytes: z.union([z.literal(8), z.literal(16)]),
          fileOffset: offset,
          recordBytes: offset,
          fileReference: unsignedDecimal,
          parentReference: unsignedDecimal,
          usn: signedDecimal,
          timestampFileTime: unsignedDecimal.nullable(),
          reasonFlags: offset,
          sourceFlags: offset,
          securityId: offset.nullable(),
          fileAttributes: offset.nullable(),
          name: z.string().nullable(),
          remainingExtents: offset.exactOptional(),
          extentSize: offset.exactOptional(),
          extentCount: offset.exactOptional(),
          omittedExtents: offset.exactOptional(),
          extentSample: z
            .array(
              z.strictObject({
                fileOffset: offset,
                offset: signedDecimal,
                length: signedDecimal,
              }),
            )
            .max(USN_INLINE_EXTENT_LIMIT)
            .exactOptional(),
          mft: z.strictObject({ file: matchSchema, parent: matchSchema }),
        }),
      }),
      z.strictObject({ kind: z.literal("coverage"), issue: issueSchema }),
    ]),
  ),
  historyCompleteness: z
    .literal("unknown")
    .describe(
      "Acquired bytes alone do not establish absent history, journal wrap, or missing captures.",
    ),
  nextFileOffset: offset.nullable(),
  mftLimitations: z.array(z.string()),
});
