import { z } from "zod";
import { BinaryReader } from "../binaryContainer.js";
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
  // domain-vocabulary: whether every $ATTRIBUTE_LIST entry resolved within the inline reference budget.
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

const attributeReader = (bytes: Buffer): BinaryReader =>
  new BinaryReader(bytes, true, "ntfs-mft");

const readTimes = (value: BinaryReader, offset: number) => ({
  createdFileTime: value.word(offset, 64).toString(),
  modifiedFileTime: value.word(offset + 8, 64).toString(),
  mftChangedFileTime: value.word(offset + 16, 64).toString(),
  accessedFileTime: value.word(offset + 24, 64).toString(),
});

const isStandardInformationSize = (size: number): boolean =>
  size === 48 || size >= 72;

const readStandardInformation = (
  value: BinaryReader,
): z.infer<typeof standardInformationSchema> => {
  const extended = value.bytes.length >= 72;
  return {
    ...readTimes(value, 0),
    fileAttributes: value.u32(32),
    maximumVersions: value.u32(36),
    version: value.u32(40),
    classId: value.u32(44),
    ownerId: extended ? value.u32(48) : null,
    securityId: extended ? value.u32(52) : null,
    quotaCharged: extended ? value.word(56, 64).toString() : null,
    usn: extended ? BigInt.asIntN(64, value.word(64, 64)).toString() : null,
  };
};

const fileNameByteLength = (bytes: Buffer): Result<number, string> => {
  if (bytes.length < 66) return err("Truncated FILE_NAME value");
  const nameBytes = bytes[64]! * 2;
  if (66 + nameBytes > bytes.length)
    return err("FILE_NAME string exceeds its value");
  const namespace = bytes[65]!;
  if (namespace > 3)
    return err("FILE_NAME namespace is outside the NTFS range");
  return ok(nameBytes);
};

const readFileName = (
  value: BinaryReader,
  fileOffset: number,
  nameBytes: number,
): MftFileName => {
  const { bytes } = value;
  return {
    fileOffset,
    parent: decodeMftFileReference(value.word(0, 64)),
    ...readTimes(value, 8),
    namespace: bytes[65]!,
    name: bytes.toString("utf16le", 66, 66 + nameBytes),
    allocatedBytes: value.word(40, 64).toString(),
    dataBytes: value.word(48, 64).toString(),
    fileAttributes: value.u32(56),
    reparseOrEa: value.u32(60),
  };
};

type ListEntry = z.infer<typeof listEntrySchema>;

const walkList = (
  value: BinaryReader,
  fileOffset: number,
  entries: ListEntry[] | null,
): AttributeIssue | null => {
  const malformed = (cursor: number, message: string): AttributeIssue => ({
    kind: "malformed",
    fileOffset: fileOffset + cursor,
    message,
  });
  const { bytes } = value;
  for (let cursor = 0; cursor < bytes.length;) {
    if (bytes.length - cursor < 26)
      return malformed(cursor, "Truncated attribute-list entry");
    const length = value.u16(cursor + 4);
    const nameBytes = bytes[cursor + 6]! * 2;
    const nameOffset = bytes[cursor + 7]!;
    if (
      length < 26 ||
      length % 8 !== 0 ||
      length > bytes.length - cursor ||
      (nameBytes > 0 &&
        (nameOffset < 26 ||
          nameOffset % 2 !== 0 ||
          nameOffset + nameBytes > length))
    )
      return malformed(cursor, "Invalid attribute-list entry length or name");
    entries?.push({
      fileOffset: fileOffset + cursor,
      recordBytes: length,
      type: value.u32(cursor),
      name:
        nameBytes === 0
          ? ""
          : bytes.toString(
              "utf16le",
              cursor + nameOffset,
              cursor + nameOffset + nameBytes,
            ),
      lowestVcn: value.word(cursor + 8, 64).toString(),
      reference: decodeMftFileReference(value.word(cursor + 16, 64)),
      attributeId: value.u16(cursor + 24),
    });
    cursor += length;
  }
  return null;
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

type DecodedAttribute = {
  readonly attribute: MftAttribute | null;
  readonly fileName: MftFileName | null;
  readonly listIssue: AttributeIssue | null;
};

const readAttribute = (
  reader: BinaryReader,
  type: number,
  fileOffset: number,
  detail: boolean,
): Result<DecodedAttribute, AttributeIssue> => {
  const malformed = (message: string): Result<never, AttributeIssue> =>
    err({ kind: "malformed", fileOffset, message });
  const attribute = reader.bytes;
  const form = attribute[8];
  const headerBytes = form === 0 ? 24 : 64;
  if (form === undefined || form > 1 || attribute.length < headerBytes)
    return malformed("Invalid attribute form or header extent");
  const nameBytes = attribute[9]! * 2;
  const nameOffset = reader.u16(10);
  if (
    nameBytes > 0 &&
    (nameOffset < headerBytes ||
      nameOffset % 2 !== 0 ||
      nameOffset + nameBytes > attribute.length)
  )
    return malformed("Attribute name is outside its declared extent");
  const nameEnd = nameBytes === 0 ? headerBytes : nameOffset + nameBytes;
  const flags = reader.u16(12);
  const common = detail
    ? {
        fileOffset,
        recordBytes: attribute.length,
        type,
        id: reader.u16(14),
        flags,
        name:
          nameBytes === 0
            ? ""
            : attribute.toString("utf16le", nameOffset, nameEnd),
      }
    : null;
  if (form === 1 && (type === 0x10 || type === 0x30))
    return malformed("Standard information and FILE_NAME must be resident");
  if (form === 0) {
    const valueBytes = reader.u32(16),
      valueOffset = reader.u16(20);
    if (valueOffset < nameEnd || valueBytes > attribute.length - valueOffset)
      return malformed(
        "Resident value overlaps its header/name or exceeds the attribute",
      );
    const value = reader.range(
      valueOffset,
      valueBytes,
      "resident attribute value",
    );
    const valueFileOffset = fileOffset + valueOffset;
    if (type === 0x10 && !isStandardInformationSize(valueBytes))
      return malformed("Invalid standard-information value");
    const fileNameLength = type === 0x30 ? fileNameByteLength(value) : null;
    if (fileNameLength !== null && !fileNameLength.ok)
      return malformed(fileNameLength.error);
    const listEntries: ListEntry[] | null = type === 0x20 && detail ? [] : null;
    const listIssue =
      type === 0x20
        ? walkList(attributeReader(value), valueFileOffset, listEntries)
        : null;
    if (common === null)
      return ok({ attribute: null, fileName: null, listIssue });
    const standardInformation =
      type === 0x10 ? readStandardInformation(attributeReader(value)) : null;
    const fileName =
      fileNameLength === null
        ? null
        : readFileName(
            attributeReader(value),
            valueFileOffset,
            fileNameLength.value,
          );
    return ok({
      attribute: {
        ...common,
        storage: {
          kind: "resident",
          valueFileOffset,
          valueBytes,
          standardInformation,
          listEntries,
          listIssue,
        },
      },
      fileName,
      listIssue,
    });
  }
  const lowestVcn = reader.word(16, 64),
    highestVcn = reader.word(24, 64);
  const extended = (flags & 0x8001) !== 0 && lowestVcn === 0n;
  const runsOffset = reader.u16(32);
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
  const dataBytes = reader.word(48, 64),
    initializedBytes = reader.word(56, 64);
  if (lowestVcn === 0n && initializedBytes > dataBytes)
    return malformed("Initialized size exceeds the declared data size");
  if (common === null)
    return ok({ attribute: null, fileName: null, listIssue: null });
  return ok({
    attribute: {
      ...common,
      storage: {
        kind: "nonresident",
        lowestVcn: lowestVcn.toString(),
        highestVcn: highestVcn.toString(),
        compressionUnit: reader.u16(34),
        allocatedBytes: reader.word(40, 64).toString(),
        dataBytes: dataBytes.toString(),
        initializedBytes: initializedBytes.toString(),
        physicalBytes: extended ? reader.word(64, 64).toString() : null,
        mappingPairsFileOffset: fileOffset + runsOffset,
        mappingPairsHex: attribute.toString(
          "hex",
          runsOffset,
          runsOffset + runs.bytes,
        ),
        runCount: runs.runCount,
        sparseRunCount: runs.sparseRunCount,
      },
    },
    fileName: null,
    listIssue: null,
  });
};

interface MftAttributeDetails {
  readonly fileNames: MftFileName[];
  readonly attributes: MftAttribute[];
}

const walkMftAttributes = (
  record: Buffer,
  first: number,
  usedBytes: number,
  fileOffset: number,
  details?: MftAttributeDetails,
): MftAttributeSummary & Pick<MftAttributeScan, "attributeIssue"> => {
  let fileNameCount = 0;
  const reader = attributeReader(record.subarray(0, usedBytes));
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
    const type = reader.u32(cursor);
    if (type === 0xffffffff) {
      complete = true;
      break;
    }
    if (cursor + 24 > usedBytes) {
      malformed(cursor, "Truncated attribute header");
      break;
    }
    const length = reader.u32(cursor + 4);
    if (length < 24 || length % 8 !== 0 || length > usedBytes - cursor) {
      malformed(cursor, "Invalid attribute length");
      break;
    }
    const decoded = readAttribute(
      attributeReader(reader.range(cursor, length, "attribute record")),
      type,
      fileOffset + cursor,
      details !== undefined,
    );
    if (!decoded.ok) {
      attributeIssue ??= decoded.error;
      break;
    }
    const { attribute, fileName, listIssue } = decoded.value;
    if (listIssue !== null) attributeIssue ??= listIssue;
    if (type === 0x30) fileNameCount += 1;
    if (fileName !== null) details?.fileNames.push(fileName);
    if (attribute !== null) details?.attributes.push(attribute);
    hasList ||= type === 0x20;
    cursor += length;
  }
  if (!complete && attributeIssue === null)
    malformed(usedBytes, "Missing attribute end marker");
  return {
    fileNameCount,
    attributeIssue,
    fileNameCoverage:
      complete && attributeIssue === null && !hasList
        ? "complete"
        : "incomplete",
    attributeCoverage:
      complete && attributeIssue === null ? "complete" : "incomplete",
  };
};

export interface MftAttributeSummary {
  readonly fileNameCount: number;
  readonly fileNameCoverage: "complete" | "incomplete";
  readonly attributeCoverage: "complete" | "incomplete";
}

/** The caller restores and verifies sector trailers before this owning boundary. */
export const readMftAttributes = (
  record: Buffer,
  first: number,
  usedBytes: number,
  fileOffset: number,
): MftAttributeScan => {
  const details: MftAttributeDetails = { fileNames: [], attributes: [] };
  const { attributeIssue, fileNameCoverage, attributeCoverage } =
    walkMftAttributes(record, first, usedBytes, fileOffset, details);
  return { ...details, attributeIssue, fileNameCoverage, attributeCoverage };
};

/** Validate the same physical records without materializing detail objects. */
export const summarizeMftAttributes = (
  record: Buffer,
  first: number,
  usedBytes: number,
  fileOffset: number,
): MftAttributeSummary => {
  const { fileNameCount, fileNameCoverage, attributeCoverage } =
    walkMftAttributes(record, first, usedBytes, fileOffset);
  return { fileNameCount, fileNameCoverage, attributeCoverage };
};
