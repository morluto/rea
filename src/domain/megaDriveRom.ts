import type {
  MegaDriveRomEntryMetadata,
  MegaDriveRomMetadata,
} from "./formatMetadata/packageAndGameMetadata.js";
import type {
  RegionDecodeFailure,
  RegionDecoder,
} from "./firmware/regionDecoder.js";
import { err, ok, type Result } from "./result.js";

/**
 * Sega Mega Drive / Genesis ROM header at file offset 0x100, preceded by the
 * 68000 vector table. An SMD copier dump is a 512-byte header plus 16 KiB
 * blocks whose first half is the odd bytes and whose second half is the even
 * bytes. This module is the only place that interprets those bytes.
 */

/** Linear cartridge window this reader admits. */
export const MEGA_DRIVE_MAX_ROM_BYTES = 8 * 1024 * 1024;
export const MEGA_DRIVE_SMD_HEADER_BYTES = 512;
export const MEGA_DRIVE_SMD_BLOCK_BYTES = 16 * 1024;
/** Same 8 MiB image, counted as 16 KiB SMD blocks. */
export const MEGA_DRIVE_MAX_SMD_BLOCKS = 512;
const VECTOR_BYTES = 0x100;
const HEADER_BYTES = 0x100;
const MIN_IMAGE_BYTES = VECTOR_BYTES + HEADER_BYTES;
const CHECKSUM_START = 0x200;
const SEGA = [0x53, 0x45, 0x47, 0x41] as const;

/**
 * Header text fields, as image offset and byte length. The layout is the
 * one in SGDK's `rom_head.c` and Genesis Plus GX's `getrominfo`. SGDK
 * declares 0x180 as one 14-byte serial; this reader keeps the common split
 * into a 12-byte serial and a 2-byte revision at 0x18C, and both keep their
 * raw bytes.
 */
const TEXT_FIELDS = {
  system: { offset: 0x100, length: 16, label: "system type" },
  copyright: { offset: 0x110, length: 16, label: "copyright" },
  domesticTitle: { offset: 0x120, length: 48, label: "domestic title" },
  overseasTitle: { offset: 0x150, length: 48, label: "overseas title" },
  serial: { offset: 0x180, length: 12, label: "serial" },
  revision: { offset: 0x18c, length: 2, label: "revision" },
  deviceSupport: { offset: 0x190, length: 16, label: "device support" },
  modem: { offset: 0x1bc, length: 12, label: "modem" },
  memo: { offset: 0x1c8, length: 40, label: "memo" },
  region: { offset: 0x1f0, length: 16, label: "region" },
} as const;

type TextFieldName = keyof typeof TEXT_FIELDS;

/** Big-endian header words and longwords, as image offsets. */
const CHECKSUM_OFFSET = 0x18e;
const ROM_START_OFFSET = 0x1a0;
const ROM_END_OFFSET = 0x1a4;
const RAM_START_OFFSET = 0x1a8;
const RAM_END_OFFSET = 0x1ac;

/**
 * External (backup) RAM block: the `RA` marker, a type byte, then start and
 * end longwords, as in SGDK's `rom_head.c` and Genesis Plus GX's
 * `sram_init`. Offsets inside the block.
 */
const EXTERNAL_RAM = {
  offset: 0x1b0,
  length: 12,
  marker: [0x52, 0x41],
  typeOffset: 2,
  startOffset: 4,
  endOffset: 8,
} as const;

const SYSTEM_OFFSET = TEXT_FIELDS.system.offset;

/** SMD copier header: the `AA BB` identification bytes at offset 8. */
const SMD_MARK_OFFSET = 8;
const SMD_MARK = [0xaa, 0xbb] as const;
/** Copier header byte 2. This bit means more split parts follow. */
const SMD_SPLIT_FOLLOWS = 0x40;

const DEVICE_LETTERS = new Set([
  "J",
  "6",
  "0",
  "4",
  "K",
  "P",
  "B",
  "F",
  "L",
  "M",
  "C",
  "R",
  "T",
  "V",
  "S",
]);

const REGION_LETTERS = new Set(["J", "U", "E", "A", "B"]);

/**
 * The 68000 side of the Mega Drive memory map, and the only place header
 * addresses are interpreted. Metadata keeps every declared value; these
 * helpers decide only whether a declared address means what the header
 * field says.
 *
 * The MC68000 drives 24 address lines, so the top byte of a longword
 * address is ignored: SGDK headers declare work RAM as
 * `0xE0FF0000`-`0xE0FFFFFF`, and a reset vector of `0xFF000200` fetches
 * from `0x200`. The 64 KiB work RAM is mirrored every 64 KiB through
 * `0xE00000`-`0xFFFFFF` (Genesis Plus GX `gen_init` maps pages `0xE0`
 * through `0xFF` to it), so `0xE00000`-`0xE0FFFF` is the same RAM as
 * `0xFF0000`-`0xFFFFFF`.
 */
const M68000_ADDRESS_MASK = 0x00ff_ffff;
const WORK_RAM_BYTES = 0x1_0000;
const WORK_RAM_MIRROR_START = 0x00e0_0000;
const WORK_RAM_MIRROR_END = 0x00ff_ffff;

const busAddress = (declared: number): number =>
  (declared & M68000_ADDRESS_MASK) >>> 0;

/** A declared range with the bus addresses the 68000 drives for it. */
const busRange = (start: number, end: number) => ({
  start,
  end,
  bus_start: busAddress(start),
  bus_end: busAddress(end),
});

/**
 * Whether a declared range is in order on the bus. Every header range is
 * ordered by this, so endpoints that alias through different top bytes,
 * such as `0xE0FF0000`-`0x00FFFFFF`, compare as the addresses the 68000
 * drives.
 */
const busOrdered = (start: number, end: number): boolean =>
  busAddress(end) >= busAddress(start);

/** Whether `[start, end]` is an ordered bus range that `outer` contains. */
const busRangeWithin = (
  start: number,
  end: number,
  outer: { readonly start: number; readonly end: number },
): boolean => {
  return (
    busOrdered(start, end) &&
    busAddress(start) >= outer.start &&
    busAddress(end) <= outer.end
  );
};

/** At most 64 KiB inside the work-RAM mirror, on the 24-bit bus. */
const addressesWorkRam = (start: number, end: number): boolean =>
  busRangeWithin(start, end, {
    start: WORK_RAM_MIRROR_START,
    end: WORK_RAM_MIRROR_END,
  }) && busAddress(end) - busAddress(start) + 1 <= WORK_RAM_BYTES;

/** Whether the 68000 fetches `address` from inside the declared ROM range. */
const addressesRom = (
  address: number,
  romStart: number,
  romEnd: number,
): boolean =>
  busRangeWithin(address, address, {
    start: busAddress(romStart),
    end: busAddress(romEnd),
  });

const EXTERNAL_RAM_TYPES: Readonly<
  Record<
    number,
    {
      readonly access: "word" | "byte-even" | "byte-odd";
      readonly battery: boolean;
    }
  >
> = {
  0xa0: { access: "word", battery: false },
  0xb0: { access: "byte-even", battery: false },
  0xb8: { access: "byte-odd", battery: false },
  0xe0: { access: "word", battery: true },
  0xf0: { access: "byte-even", battery: true },
  0xf8: { access: "byte-odd", battery: true },
};

export type MegaDriveLayout = "plain" | "smd";
export type MegaDriveFileCeiling = "rom-bytes" | "smd-blocks";

export interface MegaDriveFileLimit {
  readonly ceiling: MegaDriveFileCeiling;
  readonly message: string;
}

export interface MegaDriveRegion {
  readonly path: string;
  /** File offset when the bytes are one stored range; null when de-interleaved. */
  readonly fileOffset: number | null;
  readonly metadata: MegaDriveRomEntryMetadata;
  readonly bytes: Uint8Array;
}

export interface MegaDriveRom {
  readonly metadata: MegaDriveRomMetadata;
  readonly regions: readonly MegaDriveRegion[];
  readonly limitations: readonly string[];
  /** False when any header fact could not be taken as declared. */
  readonly complete: boolean;
}

const u32 = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)) >>>
  0;

const u16 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);

const HEX = "0123456789abcdef";

const hexBytes = (bytes: Uint8Array): string => {
  let out = "";
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
  return out;
};

const hasSegaAt = (bytes: Uint8Array, offset: number): boolean =>
  offset >= 0 &&
  offset + SEGA.length <= bytes.length &&
  SEGA.every((byte, index) => bytes[offset + index] === byte);

/**
 * Where an SMD block keeps each half of its 16 KiB: the odd image bytes
 * first, then the even ones. Recognition and de-interleaving both use this.
 */
const SMD_ODD_HALF = 0;
const SMD_EVEN_HALF = MEGA_DRIVE_SMD_BLOCK_BYTES / 2;

/** SMD file offset of one linear-image byte, for the bytes a prefix can see. */
const smdSegaFileOffset = (imageOffset: number): number => {
  const block = Math.floor(imageOffset / MEGA_DRIVE_SMD_BLOCK_BYTES);
  const within = imageOffset % MEGA_DRIVE_SMD_BLOCK_BYTES;
  const pair = Math.floor(within / 2);
  const odd = (within & 1) === 1;
  const blockOffset = (odd ? SMD_ODD_HALF : SMD_EVEN_HALF) + pair;
  return (
    MEGA_DRIVE_SMD_HEADER_BYTES +
    block * MEGA_DRIVE_SMD_BLOCK_BYTES +
    blockOffset
  );
};

/**
 * Bytes that show `SEGA` at file offset 0x100, or the SMD odd half of that
 * marker at file offsets 640 and 641.
 */
const LAYOUT_PROBE_BYTES = smdSegaFileOffset(SYSTEM_OFFSET + 3) + 1;

const smdBlockCount = (fileBytes: number): number | undefined => {
  if (
    !Number.isSafeInteger(fileBytes) ||
    fileBytes < MEGA_DRIVE_SMD_HEADER_BYTES + MEGA_DRIVE_SMD_BLOCK_BYTES
  )
    return undefined;
  const body = fileBytes - MEGA_DRIVE_SMD_HEADER_BYTES;
  if (body % MEGA_DRIVE_SMD_BLOCK_BYTES !== 0) return undefined;
  const blocks = body / MEGA_DRIVE_SMD_BLOCK_BYTES;
  return blocks >= 1 ? blocks : undefined;
};

const romByteLimit = (fileBytes: number): MegaDriveFileLimit => ({
  ceiling: "rom-bytes",
  message: `file is ${String(fileBytes)} bytes, exceeding the fixed ${String(MEGA_DRIVE_MAX_ROM_BYTES)}-byte Mega Drive ROM ceiling`,
});

const smdBlockLimit = (blocks: number): MegaDriveFileLimit => ({
  ceiling: "smd-blocks",
  message: `SMD image declares ${String(blocks)} blocks, exceeding the fixed ${String(MEGA_DRIVE_MAX_SMD_BLOCKS)}-block ceiling`,
});

const fileLimitFailure = (
  ceiling: MegaDriveFileLimit,
): RegionDecodeFailure => ({
  kind: "limit",
  boundary: "file-size",
  ceiling: ceiling.ceiling,
  message: ceiling.message,
});

/**
 * Ceiling for one layout. A plain image, and a file whose layout is still
 * unknown, stops at 8 MiB. The 512-block allowance applies only when
 * `layout` is `"smd"` (the same image plus the 512-byte copier header).
 * A block count above 512 is the block ceiling before the layout is known,
 * because that size cannot be a plain image of at most 8 MiB either.
 */
export const megaDriveFileCeiling = (
  fileBytes: number,
  layout?: MegaDriveLayout,
): MegaDriveFileLimit | undefined => {
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 0)
    return {
      ceiling: "rom-bytes",
      message: `file size ${String(fileBytes)} is not a byte count`,
    };
  if (layout === "plain") {
    if (fileBytes <= MEGA_DRIVE_MAX_ROM_BYTES) return undefined;
    return romByteLimit(fileBytes);
  }
  if (layout === "smd") {
    const blocks = smdBlockCount(fileBytes);
    if (blocks !== undefined && blocks <= MEGA_DRIVE_MAX_SMD_BLOCKS)
      return undefined;
    if (blocks !== undefined) return smdBlockLimit(blocks);
    return romByteLimit(fileBytes);
  }
  if (fileBytes <= MEGA_DRIVE_MAX_ROM_BYTES) return undefined;
  const blocks = smdBlockCount(fileBytes);
  if (blocks !== undefined && blocks > MEGA_DRIVE_MAX_SMD_BLOCKS)
    return smdBlockLimit(blocks);
  return romByteLimit(fileBytes);
};

/**
 * Size gate before the header is known. Above 8 MiB, a size that can still
 * be an SMD dump of at most 512 blocks is kept long enough to read the
 * header. The block allowance applies once that layout is SMD.
 */
const ceilingBeforeHeader = (
  fileBytes: number,
): MegaDriveFileLimit | undefined => {
  const ceiling = megaDriveFileCeiling(fileBytes);
  if (ceiling === undefined) return undefined;
  const blocks = smdBlockCount(fileBytes);
  if (
    ceiling.ceiling === "rom-bytes" &&
    blocks !== undefined &&
    blocks <= MEGA_DRIVE_MAX_SMD_BLOCKS
  )
    return undefined;
  return ceiling;
};

const plausibleSmd = (prefix: Uint8Array, fileSize: number): boolean => {
  if (prefix.length < SMD_MARK_OFFSET + 2) return false;
  if (
    prefix[SMD_MARK_OFFSET] !== SMD_MARK[0] ||
    prefix[SMD_MARK_OFFSET + 1] !== SMD_MARK[1]
  )
    return false;
  const blocks = smdBlockCount(fileSize);
  if (blocks === undefined) return false;
  return prefix[0] === (blocks & 0xff);
};

/**
 * Every SEGA byte the prefix actually holds must match, and the odd half
 * (`E` and `A`, file offsets 640 and 641) must be present. The even half
 * sits near file offset 8832, past a 4 KiB or 8 KiB classification prefix.
 */
const smdSegaAgrees = (prefix: Uint8Array): boolean => {
  let seen = 0;
  for (let index = 0; index < SEGA.length; index += 1) {
    const fileOffset = smdSegaFileOffset(SYSTEM_OFFSET + index);
    if (fileOffset >= prefix.length) continue;
    if (prefix[fileOffset] !== SEGA[index]) return false;
    seen += 1;
  }
  const oddE = smdSegaFileOffset(SYSTEM_OFFSET + 1);
  const oddA = smdSegaFileOffset(SYSTEM_OFFSET + 3);
  return seen > 0 && oddE < prefix.length && oddA < prefix.length;
};

/**
 * `plain` when `SEGA` is at 0x100. Otherwise `smd` when the copier header and
 * the SEGA bytes this prefix holds agree. The caller yields to native
 * executable headers before using this.
 */
export const recognizeMegaDriveRom = (
  prefix: Uint8Array,
  fileSize: number,
): MegaDriveLayout | undefined => {
  if (
    hasSegaAt(prefix, SYSTEM_OFFSET) &&
    Number.isSafeInteger(fileSize) &&
    fileSize >= prefix.length
  )
    return "plain";
  if (!plausibleSmd(prefix, fileSize) || !smdSegaAgrees(prefix))
    return undefined;
  return "smd";
};

export interface MegaDriveWordSum {
  readonly computed: number;
  readonly summedBytes: number;
  /** ROM end is below the checksum window, so the sum is 0. */
  readonly empty: boolean;
  /** ROM end runs past the image; only complete words inside the image were summed. */
  readonly bounded: boolean;
}

/**
 * 16-bit sum of big-endian words from image offset 0x200 through `romEnd`
 * inclusive. `romEnd` is a 24-bit bus address, which is also the image
 * offset. A word counts only when both of its bytes are inside that
 * window and inside the image. The loop never follows a ROM end past the
 * image.
 */
export const megaDriveWordSum = (
  image: Uint8Array,
  romEnd: number,
): MegaDriveWordSum => {
  if (!Number.isInteger(romEnd) || romEnd < CHECKSUM_START)
    return { computed: 0, summedBytes: 0, empty: true, bounded: false };
  const lastAvailable = image.length - 1;
  const last = romEnd < lastAvailable ? romEnd : lastAvailable;
  let computed = 0;
  let summedBytes = 0;
  for (let offset = CHECKSUM_START; offset + 1 <= last; offset += 2) {
    computed =
      (computed + (((image[offset] ?? 0) << 8) | (image[offset + 1] ?? 0))) &
      0xffff;
    summedBytes += 2;
  }
  return {
    computed,
    summedBytes,
    empty: false,
    bounded: romEnd > lastAvailable,
  };
};

const vectorName = (index: number): string => {
  if (index === 0) return "initial_ssp";
  if (index === 1) return "reset_pc";
  if (index === 2) return "bus_error";
  if (index === 3) return "address_error";
  if (index === 4) return "illegal_instruction";
  if (index === 5) return "zero_divide";
  if (index === 6) return "chk";
  if (index === 7) return "trapv";
  if (index === 8) return "privilege_violation";
  if (index === 9) return "trace";
  if (index === 10) return "line_1010";
  if (index === 11) return "line_1111";
  if (index === 15) return "uninitialized_interrupt";
  if (index === 24) return "spurious_interrupt";
  if (index >= 25 && index <= 31)
    return `interrupt_level_${String(index - 24)}`;
  if (index >= 32 && index <= 47) return `trap_${String(index - 32)}`;
  return "reserved";
};

interface TextField {
  readonly text: string;
  readonly raw_hex: string;
  readonly unprintable: boolean;
}

/** Trim trailing spaces. Bytes outside printable ASCII become `?`. */
const textField = (bytes: Uint8Array): TextField => {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0x20) end -= 1;
  let text = "";
  let unprintable = false;
  for (let index = 0; index < end; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte === 0x20) text += " ";
    else if (byte >= 0x21 && byte <= 0x7e) text += String.fromCharCode(byte);
    else {
      text += "?";
      unprintable = true;
    }
  }
  return { text, raw_hex: hexBytes(bytes), unprintable };
};

const deviceLetters = (
  bytes: Uint8Array,
): { readonly devices: string[]; readonly unknown: string } => {
  const devices: string[] = [];
  let unknown = "";
  for (const byte of bytes) {
    if (byte === 0x20) continue;
    const printable = byte >= 0x21 && byte <= 0x7e;
    const char = printable ? String.fromCharCode(byte) : "?";
    if (printable && DEVICE_LETTERS.has(char)) devices.push(char);
    else unknown += char;
  }
  return { devices, unknown };
};

const deinterleaveSmd = (file: Uint8Array): Uint8Array | undefined => {
  const blocks = smdBlockCount(file.length);
  if (blocks === undefined) return undefined;
  const image = new Uint8Array(blocks * MEGA_DRIVE_SMD_BLOCK_BYTES);
  const pairs = MEGA_DRIVE_SMD_BLOCK_BYTES / 2;
  for (let block = 0; block < blocks; block += 1) {
    const src =
      MEGA_DRIVE_SMD_HEADER_BYTES + block * MEGA_DRIVE_SMD_BLOCK_BYTES;
    const dst = block * MEGA_DRIVE_SMD_BLOCK_BYTES;
    for (let pair = 0; pair < pairs; pair += 1) {
      image[dst + pair * 2] = file[src + SMD_EVEN_HALF + pair] ?? 0;
      image[dst + pair * 2 + 1] = file[src + SMD_ODD_HALF + pair] ?? 0;
    }
  }
  return image;
};

interface SmdFacts {
  readonly blocks: number;
  /** Copier header byte 2. Bit 0x40 means more split parts follow. */
  readonly splitFlag: number;
}

const parseMegaDriveImage = (
  image: Uint8Array,
  layout: MegaDriveLayout,
  smd?: SmdFacts,
): Result<MegaDriveRom, RegionDecodeFailure> => {
  if (image.length < MIN_IMAGE_BYTES)
    return err({
      kind: "truncated",
      message: `the image is ${String(image.length)} bytes, shorter than the ${String(MIN_IMAGE_BYTES)}-byte vector table and header`,
      extent: { availableBytes: image.length, requiredBytes: MIN_IMAGE_BYTES },
    });
  if (!hasSegaAt(image, SYSTEM_OFFSET))
    return err({
      kind: "malformed",
      message: "system type at 0x100 does not begin with SEGA",
    });

  const limitations: string[] = [];
  const note = (message: string): void => {
    limitations.push(message);
  };
  const fieldBytes = (name: TextFieldName): Uint8Array => {
    const { offset, length } = TEXT_FIELDS[name];
    return image.subarray(offset, offset + length);
  };
  const readText = (name: TextFieldName): MegaDriveRomMetadata["system"] => {
    const decoded = textField(fieldBytes(name));
    if (decoded.unprintable)
      note(
        `The ${TEXT_FIELDS[name].label} field contains bytes outside printable ASCII; raw_hex keeps them and text shows ? for each one.`,
      );
    return { text: decoded.text, raw_hex: decoded.raw_hex };
  };

  const system = readText("system");
  let systemKind: MegaDriveRomMetadata["system_kind"];
  if (system.text.includes("32X")) {
    systemKind = "32x";
    note("The system string names 32X; 32X structures are not decoded.");
  } else if (system.text.includes("MEGA-CD") || system.text.includes("CD")) {
    systemKind = "sega-cd";
    note("The system string names Sega CD; disc structures are not decoded.");
  } else if (system.text === "SEGA GENESIS") systemKind = "genesis";
  else if (system.text === "SEGA MEGA DRIVE") systemKind = "mega-drive";
  else systemKind = "other";

  const copyright = readText("copyright");
  const domesticTitle = readText("domesticTitle");
  const overseasTitle = readText("overseasTitle");
  const serial = readText("serial");
  const revision = readText("revision");
  const deviceSupport = readText("deviceSupport");
  const devices = deviceLetters(fieldBytes("deviceSupport"));
  if (devices.unknown.length > 0)
    note(
      `Device support includes characters outside the known set (${devices.unknown}).`,
    );

  const region = readText("region");
  const regionCharacters: string[] = [];
  for (let index = 0; index < region.text.length; index += 1)
    regionCharacters.push(region.text.charAt(index));
  const lettersOnly =
    region.text.length > 0 &&
    regionCharacters.every((char) => REGION_LETTERS.has(char));
  const hexDigit = /^[0-9A-Fa-f]$/u.test(region.text);
  let regionStyle: MegaDriveRomMetadata["region_style"];
  let regionMask: number | null = null;
  if (region.text.length === 0) regionStyle = "empty";
  else if (lettersOnly && hexDigit) {
    // `A`, `B` and `E` are both a classic region letter and a one-digit
    // mask, and the header does not say which form it uses.
    regionStyle = "ambiguous";
    regionMask = Number.parseInt(region.text, 16);
    note(
      `The region field ${region.text} reads either as the classic region letter ${region.text} or as the region mask 0x${regionMask.toString(16)}; the header does not say which form it uses.`,
    );
  } else if (lettersOnly) regionStyle = "letters";
  else if (hexDigit) {
    regionStyle = "hex";
    regionMask = Number.parseInt(region.text, 16);
  } else regionStyle = "other";

  const modem = readText("modem");
  const memo = readText("memo");
  const romStart = u32(image, ROM_START_OFFSET);
  const romEnd = u32(image, ROM_END_OFFSET);
  const ramStart = u32(image, RAM_START_OFFSET);
  const ramEnd = u32(image, RAM_END_OFFSET);
  // The 68000 drives 24 address lines, so ordering, extent and the checksum
  // window use the bus addresses; metadata keeps the declared values.
  const romBusStart = busAddress(romStart);
  const romBusEnd = busAddress(romEnd);
  const romOrdered = busOrdered(romStart, romEnd);
  if (!romOrdered)
    note(
      `Declared ROM end 0x${romEnd.toString(16)} is before ROM start 0x${romStart.toString(16)}.`,
    );
  else {
    const declared = BigInt(romBusEnd) - BigInt(romBusStart) + 1n;
    const imageBytes = BigInt(image.length);
    if (declared > imageBytes)
      note(
        `Declared ROM range 0x${romStart.toString(16)}-0x${romEnd.toString(16)} is ${declared.toString()} bytes, longer than the ${imageBytes.toString()}-byte image.`,
      );
    else if (declared < imageBytes)
      note(
        `The image is ${imageBytes.toString()} bytes and the declared ROM range covers ${declared.toString()} bytes; bytes after that range stay in program.bin.`,
      );
  }
  if (romBusStart !== 0)
    note(
      `Declared ROM start is 0x${romStart.toString(16)}; file offset 0 is mapped at that address, and the checksum still sums image offset 0x200.`,
    );
  if (!busOrdered(ramStart, ramEnd))
    note(
      `Declared RAM end 0x${ramEnd.toString(16)} is before RAM start 0x${ramStart.toString(16)}.`,
    );
  else if (!addressesWorkRam(ramStart, ramEnd))
    note(
      `Declared RAM range 0x${ramStart.toString(16)}-0x${ramEnd.toString(16)} is not within the 64 KiB work RAM, which the 68000's 24-bit bus mirrors through 0x${WORK_RAM_MIRROR_START.toString(16)}-0x${WORK_RAM_MIRROR_END.toString(16)}.`,
    );

  const externalRaw = image.subarray(
    EXTERNAL_RAM.offset,
    EXTERNAL_RAM.offset + EXTERNAL_RAM.length,
  );
  const externalPresent =
    externalRaw[0] === EXTERNAL_RAM.marker[0] &&
    externalRaw[1] === EXTERNAL_RAM.marker[1];
  const externalType = externalRaw[EXTERNAL_RAM.typeOffset] ?? 0;
  const knownExternal = EXTERNAL_RAM_TYPES[externalType];
  const externalStart = u32(externalRaw, EXTERNAL_RAM.startOffset);
  const externalEnd = u32(externalRaw, EXTERNAL_RAM.endOffset);
  if (externalPresent && knownExternal === undefined)
    note(
      `External RAM type byte 0x${externalType.toString(16)} is not a known access and battery value.`,
    );
  if (externalPresent && !busOrdered(externalStart, externalEnd))
    note(
      `External RAM end 0x${externalEnd.toString(16)} is before its start 0x${externalStart.toString(16)}.`,
    );

  const summed = megaDriveWordSum(image, romBusEnd);
  if (summed.empty)
    note(
      `Declared ROM end 0x${romEnd.toString(16)} is below 0x200, so the checksum window is empty and the computed sum is 0.`,
    );
  else if (summed.bounded)
    note(
      `Declared ROM end 0x${romEnd.toString(16)} is past the image; the checksum sums the ${String(summed.summedBytes)} bytes present from 0x200.`,
    );
  const declaredChecksum = u16(image, CHECKSUM_OFFSET);
  if (declaredChecksum !== summed.computed)
    note(
      `Declared checksum 0x${declaredChecksum.toString(16)} does not match the computed word sum 0x${summed.computed.toString(16)}.`,
    );

  const vectors = Array.from({ length: 64 }, (_, index) => ({
    index,
    name: vectorName(index),
    value: u32(image, index * 4),
  }));
  const initialSsp = vectors[0]?.value ?? 0;
  const resetPc = vectors[1]?.value ?? 0;
  if (resetPc % 2 !== 0)
    note(
      `Reset PC 0x${resetPc.toString(16)} is odd; a 68000 fetches instructions from even addresses.`,
    );
  if (romOrdered && !addressesRom(resetPc, romStart, romEnd))
    note(
      `Reset PC 0x${resetPc.toString(16)} lies outside the declared ROM range 0x${romStart.toString(16)}-0x${romEnd.toString(16)}.`,
    );
  if (smd !== undefined && (smd.splitFlag & SMD_SPLIT_FOLLOWS) !== 0)
    note(
      `SMD copier header byte 2 is 0x${smd.splitFlag.toString(16)}, so more split parts follow; the file is still read as one image.`,
    );

  const metadata = {
    kind: "mega-drive-rom",
    layout,
    system_kind: systemKind,
    system,
    copyright,
    domestic_title: domesticTitle,
    overseas_title: overseasTitle,
    serial,
    revision,
    device_support: deviceSupport,
    devices: devices.devices,
    unknown_device_characters: devices.unknown,
    region,
    region_characters: regionCharacters,
    region_style: regionStyle,
    region_mask: regionMask,
    modem,
    memo,
    initial_ssp: initialSsp,
    reset_pc: resetPc,
    reset_pc_bus: busAddress(resetPc),
    vectors,
    checksum: {
      declared: declaredChecksum,
      computed: summed.computed,
      matches: declaredChecksum === summed.computed,
      summed_bytes: summed.summedBytes,
    },
    rom: busRange(romStart, romEnd),
    ram: busRange(ramStart, ramEnd),
    external_ram: externalPresent
      ? {
          present: true,
          raw_hex: hexBytes(externalRaw),
          type: externalType,
          battery_backed: knownExternal?.battery ?? null,
          access: knownExternal?.access ?? null,
          start: externalStart,
          end: externalEnd,
        }
      : {
          present: false,
          raw_hex: hexBytes(externalRaw),
          type: null,
          battery_backed: null,
          access: null,
          start: null,
          end: null,
        },
    image_bytes: image.length,
    smd_blocks: smd?.blocks ?? null,
  } satisfies MegaDriveRomMetadata;

  const stored = (imageOffset: number): number | null =>
    layout === "plain" ? imageOffset : null;
  const entry = (
    role: MegaDriveRomEntryMetadata["role"],
    imageOffset: number,
  ): MegaDriveRomEntryMetadata => ({
    kind: "mega-drive-rom-entry",
    role,
    image_offset: imageOffset,
  });

  return ok({
    metadata,
    limitations,
    complete: limitations.length === 0,
    regions: [
      {
        path: "vectors.bin",
        fileOffset: stored(0),
        metadata: entry("vectors", 0),
        bytes: image.subarray(0, VECTOR_BYTES),
      },
      {
        path: "header.bin",
        fileOffset: stored(SYSTEM_OFFSET),
        metadata: entry("header", SYSTEM_OFFSET),
        bytes: image.subarray(SYSTEM_OFFSET, MIN_IMAGE_BYTES),
      },
      {
        path: "program.bin",
        fileOffset: stored(0),
        metadata: entry("program", 0),
        bytes: image,
      },
    ],
  });
};

/** Decode one admitted file, plain or SMD, without allocating above the ceiling. */
export const decodeMegaDriveRom = (
  bytes: Uint8Array,
): Result<MegaDriveRom, RegionDecodeFailure> => {
  const layout = recognizeMegaDriveRom(bytes, bytes.length);
  if (layout === undefined)
    return err({
      kind: "malformed",
      message: "file is not a Mega Drive ROM or an SMD dump",
    });
  const ceiling = megaDriveFileCeiling(bytes.length, layout);
  if (ceiling !== undefined) return err(fileLimitFailure(ceiling));
  if (layout === "plain") return parseMegaDriveImage(bytes, "plain");
  const image = deinterleaveSmd(bytes);
  if (image === undefined)
    return err({
      kind: "malformed",
      message: "SMD blocks do not fill the file",
    });
  return parseMegaDriveImage(image, "smd", {
    blocks: image.length / MEGA_DRIVE_SMD_BLOCK_BYTES,
    splitFlag: bytes[2] ?? 0,
  });
};

/**
 * Start a decoder that retains the admitted file and parses it on finish.
 * The ceiling is applied before the buffer is allocated. Above 8 MiB the
 * buffer waits until the header shows an SMD dump; a plain image stops at
 * the ROM byte ceiling.
 */
export const createMegaDriveRomDecoder = (
  fileBytes: number,
): Result<RegionDecoder<MegaDriveRom>, RegionDecodeFailure> => {
  const ceiling = ceilingBeforeHeader(fileBytes);
  if (ceiling !== undefined) return err(fileLimitFailure(ceiling));
  return ok(new RetainingMegaDriveDecoder(fileBytes));
};

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
};

const copyBytes = (bytes: Uint8Array): Uint8Array => {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
};

class RetainingMegaDriveDecoder implements RegionDecoder<MegaDriveRom> {
  readonly #fileBytes: number;
  /** Present once the layout ceiling admits the file. */
  #bytes: Uint8Array | undefined;
  #length = 0;
  /** Header bytes held until an over-8 MiB file is confirmed as SMD. */
  #pending: Uint8Array = new Uint8Array(0);
  #failure: RegionDecodeFailure | undefined;

  constructor(fileBytes: number) {
    this.#fileBytes = fileBytes;
    if (fileBytes <= MEGA_DRIVE_MAX_ROM_BYTES)
      this.#bytes = new Uint8Array(fileBytes);
  }

  write(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    if (this.#failure !== undefined) return err(this.#failure);
    if (this.#bytes === undefined) return this.#writeBeforeLayout(chunk);
    return this.#writeAdmitted(chunk);
  }

  finish(): Result<MegaDriveRom, RegionDecodeFailure> {
    if (this.#failure !== undefined) return err(this.#failure);
    if (this.#bytes === undefined) {
      const ceiling = megaDriveFileCeiling(this.#fileBytes, "plain");
      if (ceiling !== undefined) return err(fileLimitFailure(ceiling));
      return decodeMegaDriveRom(this.#pending);
    }
    return decodeMegaDriveRom(this.#bytes.subarray(0, this.#length));
  }

  #writeAdmitted(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    const bytes = this.#bytes;
    if (bytes === undefined || this.#length + chunk.length > bytes.length)
      return err({
        kind: "limit",
        boundary: "file-size",
        message: "file grew beyond its admitted size while being read",
      });
    bytes.set(chunk, this.#length);
    this.#length += chunk.length;
    return ok(undefined);
  }

  /**
   * Above 8 MiB, keep only a header probe until the layout is SMD. A plain
   * image is the ROM byte ceiling and its body is not buffered.
   */
  #writeBeforeLayout(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    if (this.#pending.length + chunk.length > this.#fileBytes)
      return err({
        kind: "limit",
        boundary: "file-size",
        message: "file grew beyond its admitted size while being read",
      });
    const incoming =
      this.#pending.length === 0 ? chunk : concatBytes(this.#pending, chunk);
    if (incoming.length < LAYOUT_PROBE_BYTES) {
      this.#pending = incoming === chunk ? copyBytes(chunk) : incoming;
      return ok(undefined);
    }
    const layout = recognizeMegaDriveRom(
      incoming.subarray(0, LAYOUT_PROBE_BYTES),
      this.#fileBytes,
    );
    const ceiling = megaDriveFileCeiling(
      this.#fileBytes,
      layout === "smd" ? "smd" : "plain",
    );
    if (ceiling !== undefined) {
      this.#pending = new Uint8Array(0);
      this.#failure = fileLimitFailure(ceiling);
      return err(this.#failure);
    }
    this.#bytes = new Uint8Array(this.#fileBytes);
    this.#bytes.set(incoming);
    this.#length = incoming.length;
    this.#pending = new Uint8Array(0);
    return ok(undefined);
  }
}
