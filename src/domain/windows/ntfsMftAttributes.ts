import { z } from "zod";
import { err, ok, type Result } from "../result.js";

export type MftFileReference = z.infer<typeof ntfsFileReferenceSchema>;

export const decodeMftFileReference = (
  reference: bigint,
): MftFileReference => ({
  recordNumber: Number(reference & 0xffff_ffff_ffffn),
  sequenceNumber: Number(reference >> 48n),
});

export type MftFileName = z.infer<typeof ntfsFileNameSchema>;

const offset = z.int().nonnegative();
const decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
export const ntfsFileReferenceSchema = z.strictObject({
  recordNumber: offset,
  sequenceNumber: offset,
});
export const ntfsFileNameSchema = z.strictObject({
  fileOffset: offset,
  parent: ntfsFileReferenceSchema,
  namespace: offset,
  name: z.string(),
  createdFileTime: decimal,
  modifiedFileTime: decimal,
  mftChangedFileTime: decimal,
  accessedFileTime: decimal,
  allocatedBytes: decimal,
  dataBytes: decimal,
  fileAttributes: offset,
  reparseOrEa: offset,
});
const standardInformationSchema = z.strictObject({
  createdFileTime: decimal,
  modifiedFileTime: decimal,
  mftChangedFileTime: decimal,
  accessedFileTime: decimal,
  fileAttributes: offset,
  maximumVersions: offset,
  version: offset,
  classId: offset,
  ownerId: offset.nullable(),
  securityId: offset.nullable(),
  quotaCharged: decimal.nullable(),
  usn: z
    .string()
    .regex(/^(?:0|-?[1-9][0-9]*)$/u)
    .nullable(),
});
const listEntrySchema = z.strictObject({
  fileOffset: offset,
  recordBytes: offset,
  type: offset,
  name: z.string(),
  lowestVcn: decimal,
  reference: ntfsFileReferenceSchema,
  attributeId: offset,
});
export type MftAttributeListEntry = z.infer<typeof listEntrySchema>;
export const ntfsAttributeIssueSchema = z.strictObject({
  kind: z.literal("malformed"),
  fileOffset: offset,
  message: z.string(),
});
type AttributeIssue = z.infer<typeof ntfsAttributeIssueSchema>;
export const ntfsAttributeSchema = z.strictObject({
  fileOffset: offset,
  recordBytes: offset,
  type: offset,
  id: offset,
  name: z.string(),
  flags: offset,
  storage: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("resident"),
      valueFileOffset: offset,
      valueBytes: offset,
      standardInformation: standardInformationSchema.nullable(),
      listEntries: z.array(listEntrySchema).nullable(),
      listIssue: ntfsAttributeIssueSchema.nullable(),
    }),
    z.strictObject({
      kind: z.literal("nonresident"),
      lowestVcn: decimal,
      highestVcn: decimal,
      compressionUnit: offset,
      allocatedBytes: decimal,
      dataBytes: decimal,
      initializedBytes: decimal,
      physicalBytes: decimal.nullable(),
      mappingPairsFileOffset: offset,
      mappingPairsHex: z.string(),
      runCount: offset,
      sparseRunCount: offset,
    }),
  ]),
});
export type MftAttribute = z.infer<typeof ntfsAttributeSchema>;

/** Per selected record; each additional decoded record is bounded to 64 KiB. */
export const MFT_INLINE_ATTRIBUTE_REFERENCE_LIMIT = 32;
export const ntfsAttributeListResolutionSchema = z.strictObject({
  coverage: z.enum(["complete", "incomplete"]),
  knownEntryCount: offset,
  omittedKnownEntries: offset,
  unreadListAttributeOffsets: z.array(offset),
  incompleteRecordIndices: z.array(offset),
  references: z
    .array(
      z.strictObject({
        listEntryFileOffset: offset,
        result: z.discriminatedUnion("kind", [
          z.strictObject({
            kind: z.literal("resolved"),
            attributeFileOffset: offset,
          }),
          z.strictObject({
            kind: z.literal("ambiguous"),
            candidateCount: offset.min(2),
          }),
          z.strictObject({
            kind: z.literal("unresolved"),
            reason: z.enum([
              "unverified-base",
              "record-unavailable",
              "unverified-record",
              "sequence-mismatch",
              "base-reference-mismatch",
              "attribute-unavailable",
              "capacity",
            ]),
          }),
        ]),
      }),
    )
    .max(MFT_INLINE_ATTRIBUTE_REFERENCE_LIMIT),
  /** Additional facts only; local physical-record attributes remain unchanged. */
  linkedAttributes: z
    .array(ntfsAttributeSchema)
    .max(MFT_INLINE_ATTRIBUTE_REFERENCE_LIMIT),
  linkedFileNames: z
    .array(ntfsFileNameSchema)
    .max(MFT_INLINE_ATTRIBUTE_REFERENCE_LIMIT),
});
export type MftAttributeListResolution = z.infer<
  typeof ntfsAttributeListResolutionSchema
>;

export interface MftAttributeScan {
  readonly attributeIssue: AttributeIssue | null;
  readonly fileNames: readonly MftFileName[];
  readonly attributes: readonly MftAttribute[];
  /** Physical-record walk; linked names have independent attribute-list coverage. */
  readonly fileNameCoverage: "complete" | "incomplete";
  /** Local attribute walk only; extension references are retained, never followed. */
  readonly attributeCoverage: "complete" | "incomplete";
}

const readTimes = (value: Buffer) => ({
  createdFileTime: value.readBigUInt64LE(0).toString(),
  modifiedFileTime: value.readBigUInt64LE(8).toString(),
  mftChangedFileTime: value.readBigUInt64LE(16).toString(),
  accessedFileTime: value.readBigUInt64LE(24).toString(),
});

const readStandardInformation = (
  value: Buffer,
): z.infer<typeof standardInformationSchema> | undefined => {
  if (value.length < 48 || (value.length > 48 && value.length < 72))
    return undefined;
  return {
    ...readTimes(value),
    fileAttributes: value.readUInt32LE(32),
    maximumVersions: value.readUInt32LE(36),
    version: value.readUInt32LE(40),
    classId: value.readUInt32LE(44),
    ownerId: value.length >= 72 ? value.readUInt32LE(48) : null,
    securityId: value.length >= 72 ? value.readUInt32LE(52) : null,
    quotaCharged:
      value.length >= 72 ? value.readBigUInt64LE(56).toString() : null,
    usn: value.length >= 72 ? value.readBigInt64LE(64).toString() : null,
  };
};

const readList = (
  value: Buffer,
  fileOffset: number,
): Result<
  z.infer<typeof listEntrySchema>[],
  AttributeIssue & {
    readonly partialEntries: z.infer<typeof listEntrySchema>[];
  }
> => {
  const entries: z.infer<typeof listEntrySchema>[] = [];
  const malformed = (cursor: number, message: string) =>
    err({
      kind: "malformed" as const,
      fileOffset: fileOffset + cursor,
      message,
      partialEntries: entries,
    });
  for (let cursor = 0; cursor < value.length;) {
    if (value.length - cursor < 26)
      return malformed(cursor, "Truncated attribute-list entry");
    const length = value.readUInt16LE(cursor + 4);
    const nameBytes = value[cursor + 6]! * 2;
    const nameOffset = value[cursor + 7]!;
    if (
      length < 26 ||
      length % 8 !== 0 ||
      length > value.length - cursor ||
      (nameBytes > 0 &&
        (nameOffset < 26 ||
          nameOffset % 2 !== 0 ||
          nameOffset + nameBytes > length))
    )
      return malformed(cursor, "Invalid attribute-list entry length or name");
    entries.push({
      fileOffset: fileOffset + cursor,
      recordBytes: length,
      type: value.readUInt32LE(cursor),
      name:
        nameBytes === 0
          ? ""
          : value.toString(
              "utf16le",
              cursor + nameOffset,
              cursor + nameOffset + nameBytes,
            ),
      lowestVcn: value.readBigUInt64LE(cursor + 8).toString(),
      reference: decodeMftFileReference(value.readBigUInt64LE(cursor + 16)),
      attributeId: value.readUInt16LE(cursor + 24),
    });
    cursor += length;
  }
  return ok(entries);
};

/** Packed runs advance only within this attribute. Sparse runs do not change LCN. */
const readRuns = (bytes: Buffer, expectedClusters: bigint) => {
  let cursor = 0,
    runCount = 0,
    sparseRunCount = 0;
  let clusters = 0n,
    lcn = 0n;
  while (cursor < bytes.length) {
    const header = bytes[cursor++]!;
    if (header === 0)
      return clusters === expectedClusters
        ? { runCount, sparseRunCount, bytes: cursor }
        : undefined;
    const lengthBytes = header & 15,
      deltaBytes = header >> 4;
    if (
      lengthBytes === 0 ||
      lengthBytes > 8 ||
      deltaBytes > 8 ||
      lengthBytes + deltaBytes > bytes.length - cursor
    )
      return undefined;
    let count = 0n,
      delta = 0n;
    for (let i = 0; i < lengthBytes; i++)
      count |= BigInt(bytes[cursor + i]!) << BigInt(i * 8);
    cursor += lengthBytes;
    for (let i = 0; i < deltaBytes; i++)
      delta |= BigInt(bytes[cursor + i]!) << BigInt(i * 8);
    if (deltaBytes > 0 && (bytes[cursor + deltaBytes - 1]! & 128) !== 0)
      delta -= 1n << BigInt(deltaBytes * 8);
    cursor += deltaBytes;
    if (count === 0n) return undefined;
    if (deltaBytes === 0) sparseRunCount++;
    else lcn += delta;
    clusters += count;
    if (
      lcn < 0n ||
      lcn > 0xffffffffffffffffn ||
      (deltaBytes > 0 && lcn + count > 0x10000000000000000n) ||
      clusters > expectedClusters
    )
      return undefined;
    runCount++;
  }
  return undefined;
};

const readAttribute = (
  attribute: Buffer,
  fileOffset: number,
): Result<MftAttribute, AttributeIssue> => {
  const malformed = (message: string): Result<never, AttributeIssue> =>
    err({ kind: "malformed", fileOffset, message });
  const form = attribute[8];
  const headerBytes = form === 0 ? 24 : 64;
  if (form === undefined || form > 1 || attribute.length < headerBytes)
    return malformed("Invalid attribute form or header extent");
  const nameBytes = attribute[9]! * 2;
  const nameOffset = attribute.readUInt16LE(10);
  if (
    nameBytes > 0 &&
    (nameOffset < headerBytes ||
      nameOffset % 2 !== 0 ||
      nameOffset + nameBytes > attribute.length)
  )
    return malformed("Attribute name is outside its declared extent");
  const nameEnd = nameBytes === 0 ? headerBytes : nameOffset + nameBytes;
  const common = {
    fileOffset,
    recordBytes: attribute.length,
    type: attribute.readUInt32LE(0),
    id: attribute.readUInt16LE(14),
    flags: attribute.readUInt16LE(12),
    name:
      nameBytes === 0 ? "" : attribute.toString("utf16le", nameOffset, nameEnd),
  };
  if (form === 1 && (common.type === 0x10 || common.type === 0x30))
    return malformed("Standard information and FILE_NAME must be resident");
  if (form === 0) {
    const valueBytes = attribute.readUInt32LE(16),
      valueOffset = attribute.readUInt16LE(20);
    if (valueOffset < nameEnd || valueBytes > attribute.length - valueOffset)
      return malformed(
        "Resident value overlaps its header/name or exceeds the attribute",
      );
    const value = attribute.subarray(valueOffset, valueOffset + valueBytes);
    const standardInformation =
      common.type === 0x10 ? readStandardInformation(value) : null;
    const list =
      common.type === 0x20 ? readList(value, fileOffset + valueOffset) : null;
    const listEntries =
      list === null ? null : list.ok ? list.value : list.error.partialEntries;
    const listIssue =
      list !== null && !list.ok
        ? {
            kind: list.error.kind,
            fileOffset: list.error.fileOffset,
            message: list.error.message,
          }
        : null;
    if (standardInformation === undefined)
      return malformed("Invalid standard-information value");
    return ok({
      ...common,
      storage: {
        kind: "resident",
        valueFileOffset: fileOffset + valueOffset,
        valueBytes,
        standardInformation,
        listEntries,
        listIssue,
      },
    });
  }
  const lowestVcn = attribute.readBigUInt64LE(16),
    highestVcn = attribute.readBigUInt64LE(24);
  const extended = (common.flags & 0x8001) !== 0 && lowestVcn === 0n;
  const runsOffset = attribute.readUInt16LE(32);
  if (
    runsOffset < Math.max(nameEnd, extended ? 72 : 64) ||
    runsOffset >= attribute.length ||
    (extended && nameBytes > 0 && nameOffset < 72)
  )
    return malformed("Nonresident mapping pairs or name overlap the header");
  const empty = lowestVcn === 0n && highestVcn === 0xffffffffffffffffn;
  if (highestVcn < lowestVcn && !empty)
    return malformed("Nonresident VCN range is reversed");
  const runs = readRuns(
    attribute.subarray(runsOffset),
    empty ? 0n : highestVcn - lowestVcn + 1n,
  );
  if (runs === undefined)
    return malformed("Invalid mapping pairs or incomplete VCN coverage");
  const dataBytes = attribute.readBigUInt64LE(48),
    initializedBytes = attribute.readBigUInt64LE(56);
  if (lowestVcn === 0n && initializedBytes > dataBytes)
    return malformed("Initialized size exceeds the declared data size");
  return ok({
    ...common,
    storage: {
      kind: "nonresident",
      lowestVcn: lowestVcn.toString(),
      highestVcn: highestVcn.toString(),
      compressionUnit: attribute.readUInt16LE(34),
      allocatedBytes: attribute.readBigUInt64LE(40).toString(),
      dataBytes: dataBytes.toString(),
      initializedBytes: initializedBytes.toString(),
      physicalBytes: extended ? attribute.readBigUInt64LE(64).toString() : null,
      mappingPairsFileOffset: fileOffset + runsOffset,
      mappingPairsHex: attribute.toString(
        "hex",
        runsOffset,
        runsOffset + runs.bytes,
      ),
      runCount: runs.runCount,
      sparseRunCount: runs.sparseRunCount,
    },
  });
};

/** The caller restores and verifies sector trailers before this owning boundary. */
export const readMftAttributes = (
  record: Buffer,
  first: number,
  usedBytes: number,
  fileOffset: number,
): MftAttributeScan => {
  const fileNames: MftFileName[] = [],
    attributes: MftAttribute[] = [];
  let complete = false,
    hasList = false;
  let attributeIssue: AttributeIssue | null = null;
  const malformed = (cursor: number, message: string): void => {
    attributeIssue ??= {
      kind: "malformed",
      fileOffset: fileOffset + cursor,
      message,
    };
  };
  for (let cursor = first; cursor + 4 <= usedBytes;) {
    if (record.readUInt32LE(cursor) === 0xffffffff) {
      complete = true;
      break;
    }
    if (cursor + 24 > usedBytes) {
      malformed(cursor, "Truncated attribute header");
      break;
    }
    const length = record.readUInt32LE(cursor + 4);
    if (length < 24 || length % 8 !== 0 || length > usedBytes - cursor) {
      malformed(cursor, "Invalid attribute length");
      break;
    }
    const decoded = readAttribute(
      record.subarray(cursor, cursor + length),
      fileOffset + cursor,
    );
    if (!decoded.ok) {
      attributeIssue ??= decoded.error;
      break;
    }
    const attribute = decoded.value;
    if (
      attribute.storage.kind === "resident" &&
      attribute.storage.listIssue !== null
    )
      attributeIssue ??= attribute.storage.listIssue;
    if (attribute.type === 0x30 && attribute.storage.kind === "resident") {
      const valueOffset = attribute.storage.valueFileOffset - fileOffset;
      const valueBytes = attribute.storage.valueBytes;
      if (valueBytes < 66) {
        malformed(cursor, "Truncated FILE_NAME value");
        break;
      }
      const nameBytes = record[valueOffset + 64]! * 2;
      if (66 + nameBytes > valueBytes) {
        malformed(cursor, "FILE_NAME string exceeds its value");
        break;
      }
      fileNames.push({
        fileOffset: fileOffset + valueOffset,
        parent: decodeMftFileReference(record.readBigUInt64LE(valueOffset)),
        ...readTimes(record.subarray(valueOffset + 8)),
        namespace: record[valueOffset + 65]!,
        name: record.toString(
          "utf16le",
          valueOffset + 66,
          valueOffset + 66 + nameBytes,
        ),
        allocatedBytes: record.readBigUInt64LE(valueOffset + 40).toString(),
        dataBytes: record.readBigUInt64LE(valueOffset + 48).toString(),
        fileAttributes: record.readUInt32LE(valueOffset + 56),
        reparseOrEa: record.readUInt32LE(valueOffset + 60),
      });
    }
    hasList ||= attribute.type === 0x20;
    attributes.push(attribute);
    cursor += length;
  }
  if (!complete && attributeIssue === null)
    malformed(usedBytes, "Missing attribute end marker");
  return {
    fileNames,
    attributes,
    attributeIssue,
    fileNameCoverage:
      complete && attributeIssue === null && !hasList
        ? "complete"
        : "incomplete",
    attributeCoverage:
      complete && attributeIssue === null ? "complete" : "incomplete",
  };
};
