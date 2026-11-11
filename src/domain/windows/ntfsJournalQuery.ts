import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

export const NTFS_JOURNAL_OPERATION = "inspect_ntfs_journal" as const;
export const NTFS_JOURNAL_PROVIDER = {
  id: "rea-ntfs-journal",
  name: "REA offline NTFS change journal",
  version: "1",
} as const;

/** Working-set allowance for each in-memory acquisition, independent of page size. */
export const NTFS_JOURNAL_FILE_BYTES = 64 * 1024 * 1024;
const offset = z.int().nonnegative();
export const ntfsJournalRowLimitSchema = z.int().min(1).max(200).default(50);
export const ntfsJournalInputSchema = z.strictObject({
  mft_path: absoluteLocalPathStringSchema,
  journal_path: absoluteLocalPathStringSchema,
  start_file_offset: offset.default(0),
  max_rows: ntfsJournalRowLimitSchema,
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
  rows: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("event"),
        event: z.strictObject({
          fileOffset: offset,
          recordBytes: offset,
          fileReference: unsignedDecimal,
          parentReference: unsignedDecimal,
          usn: signedDecimal,
          timestampFileTime: unsignedDecimal,
          reasonFlags: offset,
          sourceFlags: offset,
          securityId: offset,
          fileAttributes: offset,
          name: z.string(),
          mft: z.strictObject({ file: matchSchema, parent: matchSchema }),
        }),
      }),
      z.strictObject({ kind: z.literal("coverage"), issue: issueSchema }),
    ]),
  ),
  nextFileOffset: offset.nullable(),
  mftLimitations: z.array(z.string()),
});
