import { byteToHex } from "../../kernel/byteToHex.js";
import { BinaryReader } from "../binaryContainer.js";
import { decodeIso9660VolumeDate } from "./iso9660Dates.js";
import {
  assertIso9660Volume,
  ISO9660_DESCRIPTOR_OFFSET,
  ISO9660_FLAG_DIRECTORY,
  ISO9660_FORMAT,
  ISO9660_LIMITS,
  ISO9660_MINIMUM_IMAGE_BYTES,
  ISO9660_SECTOR_BYTES,
  ISO9660_STANDARD_IDENTIFIER,
  iso9660DirectoryRecordAt,
  iso9660LimitFailure,
  iso9660Malformed,
  parsedIso9660,
  readBothEndian16,
  readBothEndian32,
  type Iso9660DirectoryRecord,
  type Iso9660VolumeSetMember,
} from "./iso9660Structures.js";
import type { Result } from "../result.js";
import {
  truncatedInput,
  unsupportedInput,
  type ParseFailureError,
} from "../parseFailure.js";

/**
 * The ISO 9660 volume descriptor set: the primary descriptor, a Joliet
 * supplementary descriptor, and an El Torito boot record. Other
 * descriptor types are counted and skipped.
 *
 * Identifiers, sizes, dates, roots and the boot catalog sector are observed
 * in the descriptors. `jolietLevel`, `treeRoot`, `nameSource`, `elTorito`,
 * `descriptorCount` and `treeCoverage` are derived from which descriptors
 * were present and admitted.
 */
export interface Iso9660VolumeDescriptorSet {
  readonly systemIdentifier: string;
  readonly volumeIdentifier: string;
  readonly volumeSetIdentifier: string;
  readonly publisherIdentifier: string;
  readonly dataPreparerIdentifier: string;
  readonly applicationIdentifier: string;
  readonly volumeSpaceSize: number;
  readonly volumeSetSize: number;
  readonly volumeSequenceNumber: number;
  readonly logicalBlockSize: 2048;
  readonly pathTableSize: number;
  readonly creationDate: string | null;
  readonly modificationDate: string | null;
  readonly expirationDate: string | null;
  readonly effectiveDate: string | null;
  readonly primaryRoot: Iso9660DirectoryRecord;
  readonly jolietLevel: 1 | 2 | 3 | null;
  readonly jolietRoot: Iso9660DirectoryRecord | null;
  /** The root of the tree to walk: Joliet when one was admitted. */
  readonly treeRoot: Iso9660DirectoryRecord;
  readonly nameSource: "primary" | "joliet";
  readonly elTorito: boolean;
  readonly bootCatalogSector: number | null;
  /** Descriptors in the set, including the terminator. */
  readonly descriptorCount: number;
  /**
   * `complete` only when the walked tree is the image's only directory tree.
   * The primary, Joliet and other supplementary hierarchies are separate and
   * may list different files; equivalence is not established, so any tree
   * left unwalked makes image-wide coverage `unknown`.
   */
  readonly treeCoverage: "complete" | "unknown";
  readonly limitations: readonly string[];
}

type PrimaryVolume = Omit<
  Iso9660VolumeDescriptorSet,
  | "jolietLevel"
  | "jolietRoot"
  | "treeRoot"
  | "nameSource"
  | "elTorito"
  | "bootCatalogSector"
  | "descriptorCount"
  | "treeCoverage"
  | "limitations"
> & {
  /** Absolute image offset of the primary descriptor. */
  readonly offset: number;
};

const EL_TORITO_IDENTIFIER = "EL TORITO SPECIFICATION";
const ROOT_RECORD_OFFSET = 156;
const ROOT_RECORD_BYTES = 34;

/** A fixed-width a-character or d-character field without its space padding. */
const textField = (bytes: Buffer, start: number, end: number): string =>
  bytes
    .subarray(start, end)
    .toString("latin1")
    .replace(/[ \0]+$/u, "");

/**
 * The descriptor's 34-byte root record: a directory with the one-byte
 * identifier 0x00, in one extent, on the volume the descriptor declares.
 */
const rootRecord = (
  sector: Buffer,
  base: number,
  volume: Iso9660VolumeSetMember,
): Iso9660DirectoryRecord => {
  if (sector[ROOT_RECORD_OFFSET] !== ROOT_RECORD_BYTES)
    throw iso9660Malformed(
      "root directory record is not 34 bytes",
      base + ROOT_RECORD_OFFSET,
      "root_directory_record",
    );
  const root = iso9660DirectoryRecordAt(
    sector,
    ROOT_RECORD_OFFSET,
    base,
    ROOT_RECORD_OFFSET + ROOT_RECORD_BYTES,
  );
  if (root.identifier[0] !== 0)
    throw iso9660Malformed(
      `root directory record identifier is 0x${byteToHex(root.identifier[0]!)}, not 0x00`,
      base + ROOT_RECORD_OFFSET + 33,
      "file_identifier",
    );
  if ((root.flags & ISO9660_FLAG_DIRECTORY) === 0)
    throw iso9660Malformed(
      "root directory record is not a directory",
      base + ROOT_RECORD_OFFSET + 25,
      "file_flags",
    );
  assertIso9660Volume(root, volume);
  return root;
};

/**
 * ECMA-119 and Joliet descriptors record file structure version 1; another
 * value describes records this reader does not interpret.
 */
const admitFileStructureVersion = (sector: Buffer, base: number): void => {
  if (sector[881] !== 1)
    throw unsupportedInput(
      ISO9660_FORMAT,
      `ISO 9660 file structure version ${String(sector[881])} is unsupported; this reader decodes version 1`,
      {
        offset: base + 881,
        field: "file_structure_version",
        undecodedContent: true,
      },
    );
};

/** The volume set size and this volume's sequence number within it. */
const volumeSet = (sector: Buffer, base: number): Iso9660VolumeSetMember => {
  const size = readBothEndian16(sector, 120, base, "volume_set_size");
  const sequence = readBothEndian16(
    sector,
    124,
    base,
    "volume_sequence_number",
  );
  if (size === 0)
    throw iso9660Malformed(
      "volume set size is 0",
      base + 120,
      "volume_set_size",
    );
  if (sequence === 0 || sequence > size)
    throw iso9660Malformed(
      `volume sequence number ${String(sequence)} is outside the volume set of ${String(size)}`,
      base + 124,
      "volume_sequence_number",
    );
  return { size, sequence };
};

const admitBlockSize = (sector: Buffer, base: number): 2048 => {
  const size = readBothEndian16(sector, 128, base, "logical_block_size");
  if (size !== ISO9660_SECTOR_BYTES)
    throw unsupportedInput(
      ISO9660_FORMAT,
      `ISO 9660 logical block size ${String(size)} is unsupported; this reader decodes 2048-byte blocks`,
      {
        offset: base + 128,
        field: "logical_block_size",
        undecodedContent: true,
      },
    );
  return ISO9660_SECTOR_BYTES;
};

const jolietLevel = (sector: Buffer): 1 | 2 | 3 | null => {
  const escapes = sector.subarray(88, 91).toString("latin1");
  if (escapes === "%/E") return 3;
  if (escapes === "%/C") return 2;
  if (escapes === "%/@") return 1;
  return null;
};

const primaryVolume = (sector: Buffer, base: number): PrimaryVolume => {
  if (sector[6] !== 1)
    throw iso9660Malformed(
      `primary volume descriptor version ${String(sector[6])} is not 1`,
      base + 6,
      "version",
    );
  admitFileStructureVersion(sector, base);
  const set = volumeSet(sector, base);
  return {
    offset: base,
    systemIdentifier: textField(sector, 8, 40),
    volumeIdentifier: textField(sector, 40, 72),
    volumeSpaceSize: readBothEndian32(sector, 80, base, "volume_space_size"),
    volumeSetSize: set.size,
    volumeSequenceNumber: set.sequence,
    logicalBlockSize: admitBlockSize(sector, base),
    pathTableSize: readBothEndian32(sector, 132, base, "path_table_size"),
    primaryRoot: rootRecord(sector, base, set),
    volumeSetIdentifier: textField(sector, 190, 318),
    publisherIdentifier: textField(sector, 318, 446),
    dataPreparerIdentifier: textField(sector, 446, 574),
    applicationIdentifier: textField(sector, 574, 702),
    creationDate: decodeIso9660VolumeDate(sector, 813),
    modificationDate: decodeIso9660VolumeDate(sector, 830),
    expirationDate: decodeIso9660VolumeDate(sector, 847),
    effectiveDate: decodeIso9660VolumeDate(sector, 864),
  };
};

/** The supplementary descriptor fields that must repeat the primary's. */
const SHARED_VOLUME_FIELDS = [
  ["volumeSpaceSize", 80, "volume_space_size"],
  ["volumeSetSize", 120, "volume_set_size"],
  ["volumeSequenceNumber", 124, "volume_sequence_number"],
] as const;

/** What the descriptors before the terminator established. */
interface DescriptorState {
  primarySector?: Buffer;
  primary: PrimaryVolume | undefined;
  joliet: {
    readonly level: 1 | 2 | 3;
    /** Absolute image offset of the Joliet descriptor. */
    readonly offset: number;
    readonly volumeSpaceSize: number;
    readonly volumeSetSize: number;
    readonly volumeSequenceNumber: number;
    readonly root: Iso9660DirectoryRecord;
  } | null;
  bootCatalogSector: number | null;
  /** Joliet descriptors skipped as ineligible; the fallback follows selection. */
  readonly skippedJoliet: string[];
  /** Other supplementary descriptors whose trees are not walked. */
  readonly unwalkedTrees: string[];
}

/**
 * A Joliet tree is used only from a version-1 supplementary descriptor whose
 * volume flags declare registered escape sequences (bit 0 clear). Otherwise
 * the UCS-2 encoding is not established, so the primary tree is kept.
 */
const jolietIneligibility = (sector: Buffer): string | null => {
  if (sector[6] !== 1)
    return `its descriptor version is ${String(sector[6])}, not 1`;
  if (((sector[7] ?? 0) & 0x01) !== 0)
    return "its volume flags declare unregistered escape sequences";
  return null;
};

const recordDescriptor = (
  state: DescriptorState,
  sector: Buffer,
  base: number,
): void => {
  const type = sector[0];
  if (type === 0) {
    if (textField(sector, 7, 39) === EL_TORITO_IDENTIFIER) {
      if (sector[6] !== 1)
        throw unsupportedInput(
          ISO9660_FORMAT,
          `El Torito boot record version ${String(sector[6])} is unsupported`,
          { offset: base + 6, field: "version", undecodedContent: true },
        );
      const catalogSector = new BinaryReader(sector, true, ISO9660_FORMAT).u32(
        71,
      );
      if (
        state.bootCatalogSector !== null &&
        state.bootCatalogSector !== catalogSector
      )
        throw iso9660Malformed(
          `El Torito catalog sector ${String(catalogSector)} conflicts with the first declaration of sector ${String(state.bootCatalogSector)}`,
          base + 71,
          "boot_catalog_sector",
        );
      state.bootCatalogSector = catalogSector;
    }
    return;
  }
  if (type === 1) {
    if (state.primarySector) {
      if (!state.primarySector.equals(sector))
        throw iso9660Malformed(
          "repeated primary volume descriptor differs from its first recording",
          base,
          "primary_volume_descriptor",
        );
      return;
    }
    state.primarySector = sector;
    state.primary = primaryVolume(sector, base);
    return;
  }
  if (type === 3) return;
  if (type !== 2)
    throw iso9660Malformed(
      `reserved volume descriptor type ${String(type)}`,
      base,
      "volume_descriptor_type",
    );
  const level = jolietLevel(sector);
  if (level === null || state.joliet !== null) {
    state.unwalkedTrees.push(
      `The directory tree of the ${level === null ? "non-Joliet supplementary" : "additional Joliet"} descriptor at byte ${String(base)} was not walked; files listed only there are not reported.`,
    );
    return;
  }
  const ineligible = jolietIneligibility(sector);
  if (ineligible !== null) {
    state.skippedJoliet.push(
      `A supplementary descriptor at byte ${String(base)} carries a Joliet escape sequence but was not used because ${ineligible}.`,
    );
    return;
  }
  admitFileStructureVersion(sector, base);
  admitBlockSize(sector, base);
  const set = volumeSet(sector, base);
  state.joliet = {
    level,
    offset: base,
    volumeSpaceSize: readBothEndian32(sector, 80, base, "volume_space_size"),
    volumeSetSize: set.size,
    volumeSequenceNumber: set.sequence,
    root: rootRecord(sector, base, set),
  };
};

const completedSet = (
  state: DescriptorState,
  base: number,
  descriptorCount: number,
  fileSize: number,
): Iso9660VolumeDescriptorSet => {
  const volume = state.primary;
  if (volume === undefined)
    throw iso9660Malformed(
      "the volume descriptor set has no primary volume descriptor",
      base,
      "type",
    );
  // The volume space must hold at least the system area and this set.
  const setEnd =
    ISO9660_DESCRIPTOR_OFFSET / ISO9660_SECTOR_BYTES + descriptorCount;
  if (volume.volumeSpaceSize < setEnd)
    throw iso9660Malformed(
      `volume space size ${String(volume.volumeSpaceSize)} ends before the volume descriptor set terminator at block ${String(setEnd - 1)}`,
      volume.offset + 80,
      "volume_space_size",
    );
  const { joliet } = state;
  // A Joliet tree describes this volume only if it declares the same volume.
  if (joliet !== null)
    for (const [key, at, field] of SHARED_VOLUME_FIELDS)
      if (joliet[key] !== volume[key])
        throw iso9660Malformed(
          `Joliet ${field.replaceAll("_", " ")} ${String(joliet[key])} disagrees with the primary descriptor's ${String(volume[key])}`,
          joliet.offset + at,
          field,
        );
  const { offset: _offset, ...facts } = volume;
  // Only one tree is walked; each other tree may list different files.
  const unwalked = [
    ...(joliet === null
      ? []
      : [
          `The primary directory tree (root extent at block ${String(volume.primaryRoot.extentLocation)}) was not walked; files listed only there are not reported.`,
        ]),
    ...state.unwalkedTrees,
  ];
  return {
    ...facts,
    jolietLevel: joliet?.level ?? null,
    jolietRoot: joliet?.root ?? null,
    treeRoot: joliet?.root ?? volume.primaryRoot,
    nameSource: joliet === null ? "primary" : "joliet",
    elTorito: state.bootCatalogSector !== null,
    bootCatalogSector: state.bootCatalogSector,
    descriptorCount,
    treeCoverage:
      unwalked.length > 0 || state.skippedJoliet.length > 0
        ? "unknown"
        : "complete",
    limitations: [
      ...(volume.volumeSpaceSize * ISO9660_SECTOR_BYTES > fileSize
        ? [
            `The primary volume descriptor declares ${String(volume.volumeSpaceSize)} blocks; the image holds ${String(fileSize)} bytes.`,
          ]
        : []),
      ...state.skippedJoliet,
      ...(state.joliet === null && state.skippedJoliet.length > 0
        ? [
            "Names come from the primary tree, and whether the skipped Joliet tree applies is unknown.",
          ]
        : []),
      ...unwalked,
    ],
  };
};

/**
 * Decode the volume descriptor set. `bytes` begins at sector 16 and holds
 * whole sectors; `fileSize` is the image size.
 */
export const parseIso9660VolumeDescriptors = (
  bytes: Buffer,
  fileSize: number,
  maxDescriptors = ISO9660_LIMITS.descriptors.maximum,
): Result<Iso9660VolumeDescriptorSet, ParseFailureError> =>
  parsedIso9660(() => {
    if (fileSize < ISO9660_MINIMUM_IMAGE_BYTES)
      throw truncatedInput(
        ISO9660_FORMAT,
        "ISO 9660 image is truncated: it ends before its first volume descriptor",
        { offset: fileSize, field: "volume_descriptor" },
      );
    const state: DescriptorState = {
      primary: undefined,
      joliet: null,
      bootCatalogSector: null,
      skippedJoliet: [],
      unwalkedTrees: [],
    };
    const sectors = Math.floor(bytes.length / ISO9660_SECTOR_BYTES);
    const limit = ISO9660_LIMITS.descriptors;
    for (let index = 0; index < maxDescriptors; index++) {
      const base = ISO9660_DESCRIPTOR_OFFSET + index * ISO9660_SECTOR_BYTES;
      if (index >= sectors)
        throw truncatedInput(
          ISO9660_FORMAT,
          "ISO 9660 image is truncated: the volume descriptor set has no terminator",
          { offset: base, field: "volume_descriptor" },
        );
      const sector = bytes.subarray(
        index * ISO9660_SECTOR_BYTES,
        (index + 1) * ISO9660_SECTOR_BYTES,
      );
      if (!sector.subarray(1, 6).equals(ISO9660_STANDARD_IDENTIFIER))
        throw iso9660Malformed(
          `volume descriptor ${String(index)} lacks the CD001 identifier`,
          base + 1,
          "standard_identifier",
        );
      if (sector[0] === 255) {
        if (sector[6] !== 1)
          throw iso9660Malformed(
            `volume descriptor set terminator version ${String(sector[6])} is not 1`,
            base + 6,
            "version",
          );
        return completedSet(state, base, index + 1, fileSize);
      }
      recordDescriptor(state, sector, base);
    }
    throw iso9660LimitFailure(limit, maxDescriptors + 1, maxDescriptors);
  });
