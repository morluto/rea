import { createHash } from "node:crypto";

import {
  DEFAULT_ANDROID_SUPER_IMAGE_READER_LIMITS,
  type AndroidSuperImageReaderLimits,
} from "../artifactReaderLimits.js";
import { readUint32At } from "../binaryContainer.js";
import type { AndroidSuperImageMetadata } from "../formatMetadata/androidSuperImageMetadata.js";
import {
  ANDROID_SUPER_FORMAT,
  androidSuperFields,
  malformedSuper,
  readSuperPartitions,
  readSuperTableDescriptors,
  SECTOR_BYTES,
  type SuperPartition,
} from "./androidSuperTables.js";
import {
  decodeLimit,
  ParseFailureError,
  truncatedInput,
  unsupportedInput,
} from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";

const GEOMETRY_MAGIC = 0x616c4467;
const HEADER_MAGIC = 0x414c5030;
const GEOMETRY_BLOCK = 4096;
const GEOMETRY_SIZE = 52;
const PRIMARY_GEOMETRY = 4096;
const BACKUP_GEOMETRY = PRIMARY_GEOMETRY + GEOMETRY_BLOCK;
const PRIMARY_METADATA = BACKUP_GEOMETRY + GEOMETRY_BLOCK;

export const ANDROID_SUPER_RECOGNITION_BYTES = BACKUP_GEOMETRY + 8;
export const ANDROID_SUPER_INVENTORY_SCOPE =
  "Android super inventory reports checksummed logical partition metadata. Partition contents, filesystems, AVB authenticity, and unused redundant copies are outside this inventory. Expand Android sparse images first.";

const geometryMagicAt = (bytes: Buffer, offset: number): boolean =>
  bytes.length >= offset + 4 &&
  readUint32At(bytes, offset, true) === GEOMETRY_MAGIC;

const hasGeometryHeaderAt = (bytes: Buffer, offset: number): boolean =>
  bytes.length >= offset + 8 &&
  geometryMagicAt(bytes, offset) &&
  readUint32At(bytes, offset + 4, true) === GEOMETRY_SIZE;

export const hasAndroidSuperGeometry = (prefix: Buffer): boolean =>
  geometryMagicAt(prefix, 0) ||
  hasGeometryHeaderAt(prefix, PRIMARY_GEOMETRY) ||
  hasGeometryHeaderAt(prefix, BACKUP_GEOMETRY);

const LEGACY_HEADER_BYTES = 128;
const EXPANDED_HEADER_BYTES = 256;
const SHA256_BYTES = 32;

type ReadRange = (offset: number, length: number) => Promise<Buffer>;
type Copy = AndroidSuperImageMetadata["copies"][number];
type CopyLocation = Pick<Copy, "slot" | "copy" | "metadata_offset">;
type AdmitRecords = (count: number, offset: number) => void;
export type AndroidSuperLimitParameter =
  `artifact_limits.android_super_image.${keyof AndroidSuperImageReaderLimits}`;

const admit = (
  limit: keyof AndroidSuperImageReaderLimits,
  field: string,
  offset: number,
  required: number,
  maximum: number,
) => {
  if (required > maximum)
    throw decodeLimit(
      ANDROID_SUPER_FORMAT,
      `Android super ${field} requires ${String(required)}, exceeding the limit of ${String(maximum)}`,
      {
        name: `artifact_limits.android_super_image.${limit}` satisfies AndroidSuperLimitParameter,
        maximum,
        required,
      },
      { field, offset },
    );
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest();

const verifyChecksum = (
  bytes: Buffer,
  expected: Buffer,
  field: string,
  offset: number,
  zeroAt?: number,
): string => {
  const input = zeroAt === undefined ? bytes : Buffer.from(bytes);
  if (zeroAt !== undefined) input.fill(0, zeroAt, zeroAt + SHA256_BYTES);
  const observed = sha256(input);
  if (!observed.equals(expected))
    throw malformedSuper(
      `Android super ${field} does not match the stored SHA-256`,
      field,
      offset,
    );
  return observed.toString("hex");
};

const checkRange = (
  fileSize: number,
  offset: number,
  length: number,
  field: string,
): void => {
  if (length > fileSize - offset)
    throw truncatedInput(
      ANDROID_SUPER_FORMAT,
      `Android super ${field} extends past the image`,
      {
        offset,
        field,
        extent: {
          availableBytes: Math.max(0, fileSize - offset),
          requiredBytes: length,
        },
      },
    );
};

const readGeometry = async (
  read: ReadRange,
  fileSize: number,
  offset: number,
) => {
  checkRange(fileSize, offset, GEOMETRY_SIZE, "geometry");
  const bytes = await read(offset, GEOMETRY_SIZE);
  if (!hasGeometryHeaderAt(bytes, 0))
    throw malformedSuper(
      "Invalid Android super geometry magic or structure size",
      "geometry",
      offset,
    );
  const geometrySha256 = verifyChecksum(
    bytes,
    bytes.subarray(8, 40),
    "geometry_checksum",
    offset + 8,
    8,
  );
  const geometryFields = androidSuperFields(bytes);
  const metadataMaxSize = geometryFields.u32(40);
  const slotCount = geometryFields.u32(44);
  const blockSize = geometryFields.u32(48);
  if (metadataMaxSize < SECTOR_BYTES || metadataMaxSize % SECTOR_BYTES !== 0)
    throw malformedSuper(
      "Invalid Android super metadata slot size",
      "metadata_max_size",
      offset + 40,
    );
  if (slotCount === 0)
    throw malformedSuper(
      "Android super geometry declares zero metadata slots",
      "metadata_slot_count",
      offset + 44,
    );
  if (blockSize === 0 || blockSize % SECTOR_BYTES !== 0)
    throw malformedSuper(
      "Invalid Android super logical block size",
      "logical_block_size",
      offset + 48,
    );
  return { offset, geometrySha256, metadataMaxSize, slotCount, blockSize };
};

type Geometry = Awaited<ReturnType<typeof readGeometry>>;

const readCopy = async (
  read: ReadRange,
  fileSize: number,
  geometry: Geometry,
  metadataEnd: number,
  location: CopyLocation,
  admitRecords: AdmitRecords,
) => {
  const { metadata_offset: offset } = location;
  checkRange(fileSize, offset, LEGACY_HEADER_BYTES, "header");
  const prefix = await read(offset, LEGACY_HEADER_BYTES);
  const prefixFields = androidSuperFields(prefix);
  if (prefixFields.u32(0) !== HEADER_MAGIC)
    throw malformedSuper(
      "Invalid Android super metadata header magic",
      "header",
      offset,
    );
  const major = prefixFields.u16(4);
  const minor = prefixFields.u16(6);
  if (major !== 10 || minor > 2)
    throw unsupportedInput(
      ANDROID_SUPER_FORMAT,
      `Unsupported Android super metadata version ${String(major)}.${String(minor)}`,
      {
        field: "metadata_version",
        offset: offset + 4,
        undecodedContent: true,
      },
    );
  const headerSize = minor === 2 ? EXPANDED_HEADER_BYTES : LEGACY_HEADER_BYTES;
  if (prefixFields.u32(8) !== headerSize)
    throw malformedSuper(
      "Invalid Android super metadata header size",
      "header_size",
      offset + 8,
    );
  checkRange(fileSize, offset, headerSize, "header");
  const header =
    headerSize === prefix.length
      ? prefix
      : Buffer.concat([
          prefix,
          await read(offset + prefix.length, headerSize - prefix.length),
        ]);
  const headerSha256 = verifyChecksum(
    header,
    header.subarray(12, 44),
    "header_checksum",
    offset + 12,
    12,
  );
  const headerFields =
    header === prefix ? prefixFields : androidSuperFields(header);
  const tablesSize = headerFields.u32(44);
  if (tablesSize > geometry.metadataMaxSize - headerSize)
    throw malformedSuper(
      "Android super header and tables exceed the metadata slot",
      "tables_size",
      offset + 44,
    );
  const descriptors = readSuperTableDescriptors(
    headerFields,
    tablesSize,
    offset,
  );
  const tablesOffset = offset + headerSize;
  checkRange(fileSize, tablesOffset, tablesSize, "tables");
  const bytes = await read(tablesOffset, tablesSize);
  const tablesSha256 = verifyChecksum(
    bytes,
    header.subarray(48, 80),
    "tables_checksum",
    offset + 48,
  );
  const recordCount = Object.values(descriptors).reduce(
    (total, table) => total + table.count,
    0,
  );
  admitRecords(recordCount, offset);
  const copy: Copy = {
    ...location,
    major_version: major,
    minor_version: minor,
    header_size: headerSize,
    header_sha256: headerSha256,
    tables_size: tablesSize,
    tables_sha256: tablesSha256,
    flags: minor === 2 ? headerFields.u32(128) : null,
    partition_count: descriptors.partitions.count,
    extent_count: descriptors.extents.count,
    group_count: descriptors.groups.count,
    block_device_count: descriptors.block_devices.count,
  };
  return {
    copy,
    partitions: readSuperPartitions(
      bytes,
      tablesOffset,
      descriptors,
      {
        slot: copy.slot,
        metadataEnd,
        rawFileSize: location.copy === "template" ? null : fileSize,
      },
      minor,
    ),
  };
};

const withBackup = async <T>(
  primary: () => Promise<T>,
  backup: () => Promise<T>,
  label: string,
  limitations: string[],
): Promise<T> => {
  try {
    return await primary();
  } catch (cause: unknown) {
    // A damaged version field can make a primary copy look unsupported.
    // A parser capacity refusal, cancellation or I/O error still stops the read.
    if (!(cause instanceof ParseFailureError) || cause.kind === "limit")
      throw cause;
    try {
      const parsed = await backup();
      limitations.push(`Used backup Android super ${label}: ${cause.message}.`);
      return parsed;
    } catch (backupCause: unknown) {
      if (
        !(backupCause instanceof ParseFailureError) ||
        backupCause.kind === "limit"
      )
        throw backupCause;
      throw cause;
    }
  }
};

interface Inventory {
  readonly metadata: AndroidSuperImageMetadata;
  readonly partitions: readonly SuperPartition[];
  readonly limitations: readonly string[];
}

export const readAndroidSuperImage = async (
  fileSize: number,
  read: ReadRange,
  limits: AndroidSuperImageReaderLimits = DEFAULT_ANDROID_SUPER_IMAGE_READER_LIMITS,
): Promise<Result<Inventory, ParseFailureError>> => {
  try {
    checkRange(fileSize, 0, 4, "image");
    const template = geometryMagicAt(await read(0, 4), 0);
    const limitations: string[] = [];
    const geometryAt = (offset: number) => readGeometry(read, fileSize, offset);
    const geometry = template
      ? await geometryAt(0)
      : await withBackup(
          () => geometryAt(PRIMARY_GEOMETRY),
          () => geometryAt(BACKUP_GEOMETRY),
          "geometry",
          limitations,
        );
    admit(
      "slot_count",
      "metadata_slot_count",
      geometry.offset + 44,
      geometry.slotCount,
      limits.slot_count,
    );
    const metadataSpan = geometry.metadataMaxSize * geometry.slotCount;
    const metadataEnd = PRIMARY_METADATA + 2 * metadataSpan;
    admit(
      "metadata_bytes",
      "metadata_max_size",
      geometry.offset + 40,
      template ? geometry.metadataMaxSize : 2 * metadataSpan,
      limits.metadata_bytes,
    );
    let examinedRecords = 0;
    const admitRecords: AdmitRecords = (count, offset) => {
      examinedRecords += count;
      admit(
        "record_count",
        "table_records",
        offset,
        examinedRecords,
        limits.record_count,
      );
    };
    const readAt = (location: CopyLocation) =>
      readCopy(read, fileSize, geometry, metadataEnd, location, admitRecords);
    const copies: Copy[] = [];
    const partitions: SuperPartition[] = [];
    if (template) {
      const parsed = await readAt({
        slot: null,
        copy: "template",
        metadata_offset: GEOMETRY_BLOCK,
      });
      copies.push(parsed.copy);
      partitions.push(...parsed.partitions);
    } else {
      checkRange(
        fileSize,
        PRIMARY_METADATA,
        2 * metadataSpan,
        "metadata slots",
      );
      for (let slot = 0; slot < geometry.slotCount; slot++) {
        const offset = PRIMARY_METADATA + slot * geometry.metadataMaxSize;
        const parsed = await withBackup(
          () => readAt({ slot, copy: "primary", metadata_offset: offset }),
          () =>
            readAt({
              slot,
              copy: "backup",
              metadata_offset: offset + metadataSpan,
            }),
          `slot ${String(slot)} metadata`,
          limitations,
        );
        copies.push(parsed.copy);
        partitions.push(...parsed.partitions);
      }
    }
    return ok({
      metadata: {
        kind: ANDROID_SUPER_FORMAT,
        layout: template ? "metadata-only" : "raw",
        geometry_offset: geometry.offset,
        geometry_sha256: geometry.geometrySha256,
        metadata_max_size: geometry.metadataMaxSize,
        metadata_slot_count: geometry.slotCount,
        logical_block_size: geometry.blockSize,
        copies,
      },
      partitions,
      limitations,
    });
  } catch (cause: unknown) {
    if (cause instanceof ParseFailureError) return err(cause);
    throw cause;
  }
};
