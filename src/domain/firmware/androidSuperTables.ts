import { BinaryReader } from "../binaryContainer.js";
import type { AndroidSuperPartitionMetadata } from "../formatMetadata/androidSuperImageMetadata.js";
import { malformedInput, unsupportedInput } from "../parseFailure.js";

import { decodeUtf8PreservingBomOrNull } from "../strictUtf8.js";

export const ANDROID_SUPER_FORMAT = "android-super-image";
export const ANDROID_SUPER_PARTITION_RECORD_BYTES = 52;
export const SECTOR_BYTES = 512;
const SECTOR = BigInt(SECTOR_BYTES);
const MAX_SECTORS = 0xffff_ffff_ffff_ffffn / SECTOR;
const NAME_BYTES = 36;

export const androidSuperFields = (bytes: Buffer): BinaryReader =>
  new BinaryReader(bytes, true, ANDROID_SUPER_FORMAT);

export const malformedSuper = (detail: string, field: string, offset: number) =>
  malformedInput(ANDROID_SUPER_FORMAT, detail, { field, offset });

const TABLES = {
  partitions: {
    descriptor: 80,
    stride: ANDROID_SUPER_PARTITION_RECORD_BYTES,
  },
  extents: { descriptor: 92, stride: 24 },
  groups: { descriptor: 104, stride: 48 },
  block_devices: { descriptor: 116, stride: 64 },
} as const;
export type SuperPartition = AndroidSuperPartitionMetadata & {
  readonly record_offset: number;
};
type Extent = AndroidSuperPartitionMetadata["extents"][number];

type TableName = keyof typeof TABLES;
type Table = {
  readonly start: number;
  readonly count: number;
  readonly end: number;
};
type Tables = Record<TableName, Table>;
const readTable = (
  name: TableName,
  header: BinaryReader,
  tablesSize: number,
  copyOffset: number,
): Table => {
  const { descriptor, stride } = TABLES[name];
  const start = header.u32(descriptor);
  const count = header.u32(descriptor + 4);
  const end = start + count * stride;
  if (header.u32(descriptor + 8) !== stride || end > tablesSize)
    throw malformedSuper(
      `Invalid Android super ${name} table stride or range`,
      name,
      copyOffset + descriptor,
    );
  return { start, count, end };
};

export const readSuperTableDescriptors = (
  header: BinaryReader,
  tablesSize: number,
  copyOffset: number,
): Tables => {
  const tables = {
    partitions: readTable("partitions", header, tablesSize, copyOffset),
    extents: readTable("extents", header, tablesSize, copyOffset),
    groups: readTable("groups", header, tablesSize, copyOffset),
    block_devices: readTable("block_devices", header, tablesSize, copyOffset),
  };
  if (tables.block_devices.count === 0)
    throw malformedSuper(
      "Android super metadata has no block devices",
      "block_devices",
      copyOffset + TABLES.block_devices.descriptor,
    );
  const occupied = (Object.keys(tables) as TableName[])
    .filter((name) => tables[name].count !== 0)
    .sort((left, right) => tables[left].start - tables[right].start);
  let end = 0;
  for (const name of occupied) {
    if (tables[name].start !== end)
      throw malformedSuper(
        `Android super table overlaps another table or follows a gap: ${name}`,
        name,
        copyOffset + TABLES[name].descriptor,
      );
    end = tables[name].end;
  }
  if (end !== tablesSize)
    throw malformedSuper(
      "Android super table region has trailing bytes",
      "tables_size",
      copyOffset + 44,
    );
  return tables;
};

const records = <T>(
  bytes: Buffer,
  tablesOffset: number,
  tables: Tables,
  name: TableName,
  parse: (record: Buffer, offset: number, index: number) => T,
): T[] => {
  const table = tables[name];
  const { stride } = TABLES[name];
  return Array.from({ length: table.count }, (_, index) => {
    const start = table.start + index * stride;
    return parse(
      bytes.subarray(start, start + stride),
      tablesOffset + start,
      index,
    );
  });
};

const readNameBytes = (bytes: Buffer, offset: number): Buffer => {
  const field = bytes.subarray(0, NAME_BYTES);
  const zero = field.indexOf(0);
  if (
    zero === 0 ||
    (zero > 0 && field.subarray(zero).some((byte) => byte !== 0))
  )
    throw malformedSuper(
      "Invalid Android super name or padding",
      "name",
      offset,
    );
  return zero < 0 ? field : field.subarray(0, zero);
};

const readMetadataName = (record: Buffer, offset: number) => {
  const bytes = readNameBytes(record, offset);
  const text = decodeUtf8PreservingBomOrNull(bytes);
  return { text, rawHex: text === null ? bytes.toString("hex") : null };
};

const readDevice = (
  record: Buffer,
  offset: number,
  index: number,
  metadataEnd: number,
) => {
  const fields = androidSuperFields(record);
  const first = fields.word(0, 64);
  const bytes = fields.word(16, 64);
  if (
    bytes === 0n ||
    bytes % SECTOR !== 0n ||
    first > bytes / SECTOR ||
    (index === 0 && first * SECTOR < BigInt(metadataEnd))
  )
    throw malformedSuper(
      "Invalid Android super block device size or first usable sector",
      "block_devices",
      offset,
    );
  return {
    first,
    sectors: bytes / SECTOR,
    name: readMetadataName(record.subarray(24), offset + 24),
    flags: fields.u32(60),
  };
};

const readGroup = (record: Buffer, offset: number) => {
  const fields = androidSuperFields(record);
  return {
    name: readMetadataName(record, offset),
    flags: fields.u32(36),
    maximumBytes: fields.word(40, 64),
    maximumSizeOffset: offset + 40,
    allocatedBytes: 0n,
  };
};

type Device = ReturnType<typeof readDevice>;

const readExtent = (
  record: Buffer,
  offset: number,
  index: number,
  devices: readonly Device[],
  rawFileSize: bigint | null,
  sectorsPerBlock: bigint,
) => {
  const fields = androidSuperFields(record);
  const sectors = fields.word(0, 64);
  const type = fields.u32(8);
  const physicalSector = fields.word(12, 64);
  const deviceIndex = fields.u32(20);
  if (sectors === 0n || sectors > MAX_SECTORS)
    throw malformedSuper(
      "Invalid Android super extent sector count",
      "num_sectors",
      offset,
    );
  if (sectors % sectorsPerBlock !== 0n)
    throw malformedSuper(
      "Android super extent size is not aligned to the logical block size",
      "num_sectors",
      offset,
    );
  const length = sectors * SECTOR;
  const common = { index, record_offset: offset, length_bytes: String(length) };
  if (type === 1) {
    if (physicalSector !== 0n || deviceIndex !== 0)
      throw malformedSuper(
        "Android super zero extent declares physical mapping",
        "target_data",
        offset + 12,
      );
    return { length, facts: { ...common, kind: "zero" as const } };
  }
  if (type !== 0)
    throw unsupportedInput(
      ANDROID_SUPER_FORMAT,
      `Unsupported Android super extent target ${String(type)}`,
      {
        field: "target_type",
        offset: offset + 8,
        undecodedContent: true,
      },
    );
  const device = devices[deviceIndex];
  if (device === undefined)
    throw malformedSuper(
      "Android super extent names an absent block device",
      "target_source",
      offset + 20,
    );
  if (
    physicalSector < device.first ||
    physicalSector + sectors > device.sectors
  )
    throw malformedSuper(
      "Android super extent exceeds its block device range",
      "target_data",
      offset + 12,
    );
  const physical = physicalSector * SECTOR;
  // A short capture affects byte availability, while the checked device
  // bounds above determine whether this mapping is valid metadata.
  const imageRangeStatus =
    rawFileSize === null || deviceIndex !== 0
      ? "not-in-image"
      : physical + length > rawFileSize
        ? "truncated"
        : "present";
  return {
    length,
    facts: {
      ...common,
      kind: "linear",
      device_index: deviceIndex,
      device_name: device.name.text,
      device_name_bytes_hex: device.name.rawHex,
      device_flags: device.flags,
      physical_offset: String(physical),
      image_offset: imageRangeStatus === "present" ? Number(physical) : null,
      image_range_status: imageRangeStatus,
    } as const,
    physical: {
      deviceIndex,
      start: physicalSector,
      end: physicalSector + sectors,
    },
  };
};

export const readSuperPartitions = (
  bytes: Buffer,
  tablesOffset: number,
  tables: Tables,
  {
    slot,
    metadataEnd,
    rawFileSize,
    logicalBlockSize,
  }: {
    readonly slot: number | null;
    readonly metadataEnd: number;
    readonly rawFileSize: number | null;
    readonly logicalBlockSize: number;
  },
  minorVersion: number,
): SuperPartition[] => {
  const groups = records(bytes, tablesOffset, tables, "groups", readGroup);
  const devices = records(
    bytes,
    tablesOffset,
    tables,
    "block_devices",
    (record, offset, index) => readDevice(record, offset, index, metadataEnd),
  );
  const sectorsPerBlock = BigInt(logicalBlockSize) / SECTOR;
  const capturedBytes = rawFileSize === null ? null : BigInt(rawFileSize);
  const extents = records(
    bytes,
    tablesOffset,
    tables,
    "extents",
    (record, offset, index) =>
      readExtent(
        record,
        offset,
        index,
        devices,
        capturedBytes,
        sectorsPerBlock,
      ),
  );
  const claimed = new Set<number>();
  const names = new Set<string>();
  const partitions = records(
    bytes,
    tablesOffset,
    tables,
    "partitions",
    (record, offset, index): SuperPartition => {
      const name = readNameBytes(record, offset).toString("latin1");
      if (!/^[A-Za-z0-9_]+$/u.test(name))
        throw malformedSuper(
          "Invalid Android super partition name",
          "name",
          offset,
        );
      if (names.has(name))
        throw malformedSuper(
          "Duplicate Android super partition name",
          "name",
          offset,
        );
      names.add(name);
      const fields = androidSuperFields(record);
      const attributes = fields.u32(36);
      if (attributes > (minorVersion === 0 ? 3 : 15))
        throw malformedSuper(
          "Invalid Android super partition attributes for this version",
          "attributes",
          offset + 36,
        );
      const firstExtent = fields.u32(40);
      const extentCount = fields.u32(44);
      if (firstExtent + extentCount > extents.length)
        throw malformedSuper(
          "Android super partition extent list exceeds its table",
          "extent_list",
          offset + 40,
        );
      const groupIndex = fields.u32(48);
      const group = groups[groupIndex];
      if (group === undefined)
        throw malformedSuper(
          "Android super partition names an absent group",
          "group_index",
          offset + 48,
        );
      let logical = 0n;
      const partitionExtents: Extent[] = [];
      for (let i = firstExtent; i < firstExtent + extentCount; i++) {
        if (claimed.has(i))
          throw malformedSuper(
            "Android super partitions share extent records",
            "extent_list",
            offset + 40,
          );
        claimed.add(i);
        const extent = extents[i]!;
        partitionExtents.push({
          ...extent.facts,
          logical_offset: String(logical),
        });
        logical += extent.length;
        // AOSP accounts only for extents backed by storage in group capacity.
        if (extent.facts.kind === "linear")
          group.allocatedBytes += extent.length;
        if (logical > MAX_SECTORS * SECTOR)
          throw malformedSuper(
            "Android super logical partition size overflows 64 bits",
            "extent_list",
            offset + 40,
          );
      }
      if (
        group.maximumBytes !== 0n &&
        group.allocatedBytes > group.maximumBytes
      )
        throw malformedSuper(
          `Android super group allocates ${String(group.allocatedBytes)} bytes and exceeds its declared maximum of ${String(group.maximumBytes)} bytes`,
          "maximum_size",
          group.maximumSizeOffset,
        );
      return {
        kind: "android-super-partition",
        slot,
        index,
        record_offset: offset,
        name,
        attributes,
        group_index: groupIndex,
        group_name: group.name.text,
        group_name_bytes_hex: group.name.rawHex,
        group_flags: group.flags,
        logical_bytes: String(logical),
        extents: partitionExtents,
      };
    },
  );
  if (claimed.size !== extents.length)
    throw malformedSuper(
      "Android super metadata contains unclaimed extent records",
      "extents",
      tablesOffset + tables.extents.start,
    );
  const mapped = extents
    .flatMap(({ physical, facts }) =>
      physical === undefined
        ? []
        : [{ ...physical, offset: facts.record_offset }],
    )
    .sort(
      (left, right) =>
        left.deviceIndex - right.deviceIndex ||
        (left.start < right.start ? -1 : left.start > right.start ? 1 : 0),
    );
  let previous: (typeof mapped)[number] | undefined;
  for (const extent of mapped) {
    if (
      previous?.deviceIndex === extent.deviceIndex &&
      extent.start < previous.end
    )
      throw malformedSuper(
        "Android super linear extents overlap on a block device",
        "target_data",
        extent.offset + 12,
      );
    previous = extent;
  }
  return partitions;
};
