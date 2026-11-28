import { crc32 } from "node:zlib";

import { byteToHex } from "../kernel/byteToHex.js";
import type {
  N64RomEntryMetadata,
  N64RomMetadata,
} from "./formatMetadata/packageAndGameMetadata.js";
import {
  decodeLimit,
  malformedInput,
  truncatedInput,
  type ParseFailureError,
} from "./parseFailure.js";

export type { N64RomMetadata };

/**
 * Nintendo 64 cartridge image. Dumps circulate as big-endian z64
 * (`80 37 12 40`), 16-bit byte-swapped v64 (`37 80 40 12`) and 32-bit
 * little-endian n64 (`40 12 37 80`). Header fields follow the big-endian
 * layout: PI DOM1 at 0x00, clock rate at 0x04, boot address at 0x08, libultra
 * release at 0x0C, CRC1/CRC2 at 0x10/0x14, title at 0x20, media at 0x3B,
 * cartridge ID at 0x3C, destination at 0x3E and version at 0x3F. IPL3 occupies
 * 0x40..0x1000. The cartridge CRC covers the 1 MiB window at 0x1000..0x101000.
 * Nothing here is executed or patched.
 */
export const N64_FORMAT = "n64-rom";

/** Bytes of the cartridge header. */
export const N64_HEADER_BYTES = 0x40;
/** First byte of IPL3, immediately after the header. */
export const N64_IPL3_OFFSET = 0x40;
/** First byte after IPL3. The checksum window starts here. */
export const N64_IPL3_END = 0x1000;
/** Length of the cartridge checksum window, in bytes. */
export const N64_CHECKSUM_LENGTH = 0x10_0000;
/** First byte after the checksum window. */
export const N64_CHECKSUM_END = N64_IPL3_END + N64_CHECKSUM_LENGTH;
/**
 * Largest cartridge image REA normalizes. Retail masks stop at 64 MiB
 * (512 Mbit). A larger file is refused before its bytes are swapped.
 */
export const N64_MAX_ROM_BYTES = 64 * 1024 * 1024;
/** Named limit {@link n64RomSizeFailure} raises above {@link N64_MAX_ROM_BYTES}. */
export const N64_ROM_BYTES_LIMIT = "n64.rom_bytes";

/**
 * First-word magic of each dump order: the big-endian PI DOM1 configuration
 * word `80 37 12 40` as each order stores it (mupen64plus-core `is_valid_rom`).
 */
export const N64_MAGIC: Readonly<Record<N64ByteOrder, number>> = {
  z64: 0x8037_1240,
  v64: 0x3780_4012,
  n64: 0x4012_3780,
};

/**
 * Header field offsets in the big-endian image. Ranges are `[start, end)`.
 * Sources: mupen64plus-core `m64p_rom_header` (`src/api/m64p_types.h`) for
 * the words, title, cartridge ID, destination and version; libdragon
 * `tools/n64tool.c` (`CATEGORY_OFFSET`) for the media category at 0x3B.
 */
export const N64_HEADER_FIELD = {
  piDom1Config: 0x00,
  clockRate: 0x04,
  bootAddress: 0x08,
  libultraRelease: 0x0c,
  crc1: 0x10,
  crc2: 0x14,
  reservedLow: [0x18, 0x20],
  title: [0x20, 0x34],
  reservedHigh: [0x34, 0x3b],
  media: 0x3b,
  cartridgeId: [0x3c, 0x3e],
  destination: 0x3e,
  version: 0x3f,
} as const;

/**
 * File offset of the 256-byte boot-code table CIC 6105/7105 mixes into its
 * checksum: IPL3 offset 0x710 (Project64 `CalculateRomCrc`, n64crc).
 */
export const N64_CIC_6105_TABLE_OFFSET = 0x750;

/** KSEG0 and KSEG1 together: the unmapped segments IPL3 can jump to. */
const N64_KSEG0_START = 0x8000_0000;
const N64_KSEG1_END = 0xbfff_ffff;

export const N64_HEADER_ENTRY = "header.bin";
export const N64_IPL3_ENTRY = "ipl3.bin";
export const N64_PROGRAM_ENTRY = "program.z64";

export type N64ByteOrder = N64RomMetadata["source_order"];
export type N64CicId = N64RomMetadata["cic"];
type N64KnownCicId = Exclude<N64CicId, "unknown">;
type N64MediaName = NonNullable<N64RomMetadata["media_name"]>;
type N64DestinationName = NonNullable<N64RomMetadata["destination_name"]>;

/** A listed byte range and the normalized bytes it serves. */
export interface N64RomRegion {
  readonly path: string;
  readonly offset: number;
  readonly length: number;
  readonly metadata: N64RomEntryMetadata;
}

/** Header facts, limitations and the ranges a reader lists. */
export interface N64RomImage {
  readonly metadata: N64RomMetadata;
  readonly limitations: readonly string[];
  readonly entries: readonly N64RomRegion[];
}

/** One known IPL3 image: its CRC32, checksum seed and whether it uses the 6105 table. */
export interface N64CicVariant {
  readonly id: N64KnownCicId;
  readonly ipl3Crc32: number;
  /** Initial value of every checksum accumulator. */
  readonly seed: number;
  /**
   * CIC 6105/7105 adds each window word XOR a boot-code word at 0x750 to t1
   * instead of the word XOR t5.
   */
  readonly usesLut: boolean;
}

/**
 * Published IPL3 CRC32 values and checksum seeds. 6101 shares the 6102
 * routine. The table is frozen; tests register a synthetic boot stub through
 * {@link registerN64TestCic} and must not replace these rows.
 */
export const N64_CIC_VARIANTS: readonly N64CicVariant[] = [
  { id: "6101", ipl3Crc32: 0x6170_a4a1, seed: 0xf8ca_4ddc, usesLut: false },
  {
    id: "6102/7101",
    ipl3Crc32: 0x90bb_6cb5,
    seed: 0xf8ca_4ddc,
    usesLut: false,
  },
  {
    id: "6103/7103",
    ipl3Crc32: 0x0b05_0ee0,
    seed: 0xa388_6759,
    usesLut: false,
  },
  { id: "6105/7105", ipl3Crc32: 0x98bc_2c86, seed: 0xdf26_f436, usesLut: true },
  {
    id: "6106/7106",
    ipl3Crc32: 0xacc8_580a,
    seed: 0x1fea_617a,
    usesLut: false,
  },
];

const productionCic = new Map(
  N64_CIC_VARIANTS.map((variant) => [variant.ipl3Crc32, variant] as const),
);
const testCic = new Map<number, N64CicVariant>();

/**
 * Register an extra IPL3 hash for tests. A hash that collides with a published
 * row is refused so a synthetic stub cannot hide behind a real variant.
 * Production readers do not call this.
 */
export const registerN64TestCic = (variant: N64CicVariant): void => {
  const hash = variant.ipl3Crc32 >>> 0;
  if (productionCic.has(hash))
    throw new Error(
      `test CIC CRC32 ${hex32(hash)} collides with published IPL3 ${productionCic.get(hash)?.id ?? ""}`,
    );
  testCic.set(hash, { ...variant, ipl3Crc32: hash });
};

const cicForHash = (hash: number): N64CicVariant | undefined =>
  productionCic.get(hash) ?? testCic.get(hash);

const hex32 = (value: number): string =>
  `0x${(value >>> 0).toString(16).padStart(8, "0")}`;

const readBe = (bytes: Uint8Array, offset: number): number => {
  if (offset < 0 || offset + 4 > bytes.length) return 0;
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
};

/** First-word byte order, or undefined when the word is not an N64 magic. */
export const n64ByteOrder = (prefix: Uint8Array): N64ByteOrder | undefined => {
  if (prefix.length < 4) return undefined;
  const word = readBe(prefix, N64_HEADER_FIELD.piDom1Config);
  for (const order of ["z64", "v64", "n64"] as const)
    if (word === N64_MAGIC[order]) return order;
  return undefined;
};

/**
 * Bytes each order swaps as one unit: v64 swaps 16-bit halves and n64
 * reverses 32-bit words, so a v64 dump needs an even length and an n64 dump a
 * multiple of 4. A z64 dump is already big-endian and has no unit. This
 * matches mupen64plus-core's `is_valid_rom`.
 */
export const N64_SWAP_UNIT: Readonly<Record<N64ByteOrder, number>> = {
  z64: 1,
  v64: 2,
  n64: 4,
};

const n64AlignmentFailure = (
  length: number,
  order: N64ByteOrder,
): ParseFailureError<"malformed"> | undefined => {
  const unit = N64_SWAP_UNIT[order];
  if (length % unit === 0) return undefined;
  return malformedInput(
    N64_FORMAT,
    `Nintendo 64 ${order} ROM length ${String(length)} is not a multiple of ${String(unit)}, so its byte order cannot be normalized.`,
    { offset: 0, field: "byte_order" },
  );
};

/**
 * Return `bytes` in big-endian order. z64 is already big-endian and is
 * returned as-is, so callers must not mutate the result. v64 swaps each pair
 * and n64 reverses each 4-byte word into a new array. The length must be a
 * whole number of that order's swap unit ({@link N64_SWAP_UNIT}).
 */
export const swapN64Bytes = (
  bytes: Uint8Array,
  order: N64ByteOrder,
): Uint8Array => {
  const alignment = n64AlignmentFailure(bytes.length, order);
  if (alignment !== undefined) throw alignment;
  if (order === "z64") return bytes;
  const out = new Uint8Array(bytes.length);
  if (order === "v64") {
    for (let index = 0; index < bytes.length; index += 2) {
      out[index] = bytes[index + 1] ?? 0;
      out[index + 1] = bytes[index] ?? 0;
    }
    return out;
  }
  for (let index = 0; index < bytes.length; index += 4) {
    out[index] = bytes[index + 3] ?? 0;
    out[index + 1] = bytes[index + 2] ?? 0;
    out[index + 2] = bytes[index + 1] ?? 0;
    out[index + 3] = bytes[index] ?? 0;
  }
  return out;
};

/**
 * Rotate `value` left by `bits` (mod 32). A multiple of 32 returns the word
 * unchanged. JavaScript `>>> 32` masks the shift to 0, so the zero case is
 * explicit.
 */
const rol32 = (value: number, bits: number): number => {
  const word = value >>> 0;
  const shift = bits & 31;
  if (shift === 0) return word;
  return ((word << shift) | (word >>> (32 - shift))) >>> 0;
};

/**
 * The bytes the checksum routine reads: the image through
 * {@link N64_CHECKSUM_END}, with every byte past the end of a shorter image
 * taken as zero. Only missing bytes are filled, so a final word the file ends
 * inside keeps its present bytes. The references define no value for bytes a
 * cartridge does not hold (Project64 reads the window unbounded; libdragon's
 * n64tool zero-pads the images it writes), so zero is an assumption the
 * parser reports as a limitation.
 */
export const n64ChecksumWindow = (normalized: Uint8Array): Uint8Array => {
  if (normalized.length >= N64_CHECKSUM_END) return normalized;
  const window = new Uint8Array(N64_CHECKSUM_END);
  window.set(normalized);
  return window;
};

/**
 * Cartridge CRC pair over the 1 MiB window, as the IPL3 checksum routine and
 * the public n64crc reference compute it, read through
 * {@link n64ChecksumWindow}.
 * Every CIC runs the same six accumulators. Only 6105/7105 replaces the t1
 * step with a word from its boot-code table at 0x750. 6103 and 6106 combine
 * the accumulators with an add or a multiply; the rest XOR them.
 */
export const n64CartridgeCrc = (
  normalized: Uint8Array,
  variant: N64CicVariant,
): { readonly crc1: number; readonly crc2: number } => {
  const window = n64ChecksumWindow(normalized);
  let t1 = variant.seed >>> 0;
  let t2 = t1;
  let t3 = t1;
  let t4 = t1;
  let t5 = t1;
  let t6 = t1;
  for (let offset = N64_IPL3_END; offset < N64_CHECKSUM_END; offset += 4) {
    const data = readBe(window, offset);
    const sum = (t6 + data) >>> 0;
    if (sum < t6) t4 = (t4 + 1) >>> 0;
    t6 = sum;
    t3 = (t3 ^ data) >>> 0;
    const rotated = rol32(data, data & 31);
    t5 = (t5 + rotated) >>> 0;
    t2 = t2 > data ? (t2 ^ rotated) >>> 0 : (t2 ^ t6 ^ data) >>> 0;
    const mix = variant.usesLut
      ? readBe(window, N64_CIC_6105_TABLE_OFFSET + (offset & 0xff))
      : t5;
    t1 = (t1 + ((mix ^ data) >>> 0)) >>> 0;
  }
  if (variant.id === "6103/7103")
    return {
      crc1: (((t6 ^ t4) >>> 0) + t3) >>> 0,
      crc2: (((t5 ^ t2) >>> 0) + t1) >>> 0,
    };
  if (variant.id === "6106/7106")
    return {
      crc1: (Math.imul(t6, t4) + t3) >>> 0,
      crc2: (Math.imul(t5, t2) + t1) >>> 0,
    };
  return {
    crc1: (t6 ^ t4 ^ t3) >>> 0,
    crc2: (t5 ^ t2 ^ t1) >>> 0,
  };
};

/** KSEG0/KSEG1 and 4-byte aligned: the boot address IPL3 jumps to. */
export const n64BootAddressPlausible = (bootAddress: number): boolean =>
  (bootAddress & 3) === 0 &&
  bootAddress >= N64_KSEG0_START &&
  bootAddress <= N64_KSEG1_END;

/**
 * The one boot-address decision recognition and parsing share, read from a
 * big-endian header.
 */
const bootAddressFailure = (
  header: Uint8Array,
): ParseFailureError<"malformed"> | undefined => {
  const bootAddress = readBe(header, N64_HEADER_FIELD.bootAddress);
  if (n64BootAddressPlausible(bootAddress)) return undefined;
  return malformedInput(
    N64_FORMAT,
    `Boot address ${hex32(bootAddress)} lies outside KSEG0/KSEG1 or is not 4-byte aligned.`,
    { offset: N64_HEADER_FIELD.bootAddress, field: "boot_address" },
  );
};

/**
 * Structural size check. A file above 64 MiB is a named limit. A short header
 * is truncated. When the byte order is known, a length that is not a whole
 * number of its swap unit is malformed; without it only the order-free checks
 * run, so a caller can refuse before reading the first word.
 */
export const n64RomSizeFailure = (
  fileSize: number,
  order?: N64ByteOrder,
):
  | ParseFailureError<"malformed">
  | ParseFailureError<"truncated">
  | ParseFailureError<"limit">
  | undefined => {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0)
    return malformedInput(
      N64_FORMAT,
      `Nintendo 64 ROM length ${String(fileSize)} is not a byte count.`,
      { offset: 0, field: "rom_bytes" },
    );
  if (fileSize < N64_HEADER_BYTES)
    return truncatedInput(
      N64_FORMAT,
      `Nintendo 64 ROM header needs ${String(N64_HEADER_BYTES)} bytes; the file has ${String(fileSize)}.`,
      {
        offset: 0,
        field: "header",
        extent: { availableBytes: fileSize, requiredBytes: N64_HEADER_BYTES },
      },
    );
  const alignment =
    order === undefined ? undefined : n64AlignmentFailure(fileSize, order);
  if (alignment !== undefined) return alignment;
  if (fileSize > N64_MAX_ROM_BYTES)
    return decodeLimit(
      N64_FORMAT,
      `Nintendo 64 ROM is ${String(fileSize)} bytes. The fixed ceiling is ${String(N64_MAX_ROM_BYTES)} bytes (64 MiB). This release has no runtime override.`,
      {
        name: N64_ROM_BYTES_LIMIT,
        maximum: N64_MAX_ROM_BYTES,
        required: fileSize,
      },
      { offset: 0, field: "rom_bytes" },
    );
  return undefined;
};

/** Recognition refusals are clauses; the target resolver ends the sentence. */
const refusalReason = (detail: string): string => detail.replace(/\.$/u, "");

export type N64RomClaim =
  | { readonly state: "recognized" }
  | { readonly state: "refused"; readonly reason: string };

/**
 * Claim an N64 image from a prefix. A prefix shorter than the header does not
 * claim the format. A length the byte order cannot normalize or an
 * implausible boot address is refused.
 * A file above the 64 MiB ceiling is still recognized when the header is
 * plausible, so the reader can report that fixed ceiling.
 */
export const n64RomRecognition = (
  prefix: Uint8Array,
  fileSize: number,
): N64RomClaim | undefined => {
  const order = n64ByteOrder(prefix);
  if (order === undefined || prefix.length < N64_HEADER_BYTES) return undefined;
  const size = n64RomSizeFailure(fileSize, order);
  if (size !== undefined && size.kind !== "limit")
    return { state: "refused", reason: refusalReason(size.message) };
  const boot = bootAddressFailure(
    swapN64Bytes(prefix.subarray(0, N64_HEADER_BYTES), order),
  );
  if (boot !== undefined)
    return { state: "refused", reason: refusalReason(boot.message) };
  return { state: "recognized" };
};

const MEDIA_NAMES: Readonly<Record<number, N64MediaName>> = {
  0x4e: "cartridge",
  0x44: "64dd",
  0x43: "expandable-cartridge",
  0x45: "expandable-64dd",
  0x5a: "aleck64",
};

const DESTINATION_NAMES: Readonly<Record<number, N64DestinationName>> = {
  0x41: "Asia",
  0x42: "Brazil",
  0x43: "China",
  0x44: "Germany",
  0x45: "North America",
  0x46: "France",
  0x47: "Gateway 64 NTSC",
  0x48: "Netherlands",
  0x49: "Italy",
  0x4a: "Japan",
  0x4b: "Korea",
  0x4c: "Gateway 64 PAL",
  0x4e: "Canada",
  0x50: "Europe",
  0x53: "Spain",
  0x55: "Australia",
  0x57: "Scandinavia",
  0x58: "Europe",
  0x59: "Europe",
  0x37: "Beta",
};

const renderBytes = (bytes: Uint8Array, blank: string): string => {
  let text = "";
  for (const byte of bytes)
    text += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : blank;
  return text;
};

const hexBytes = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byteToHex(byte)).join("");

const fieldBytes = (
  header: Uint8Array,
  [start, end]: readonly [number, number],
): Uint8Array => header.subarray(start, end);

const reservedLimitation = (header: Uint8Array): string | undefined => {
  const low = fieldBytes(header, N64_HEADER_FIELD.reservedLow);
  const high = fieldBytes(header, N64_HEADER_FIELD.reservedHigh);
  const blank = (bytes: Uint8Array): boolean =>
    bytes.every((byte) => byte === 0);
  if (blank(low) && blank(high)) return undefined;
  return `Header reserved bytes at 0x18..0x1F are ${hexBytes(low)} and at 0x34..0x3A are ${hexBytes(high)}.`;
};

const entryFor = (
  path: string,
  offset: number,
  length: number,
  order: N64ByteOrder,
  role: N64RomEntryMetadata["role"],
): N64RomRegion => ({
  path,
  offset,
  length,
  metadata: {
    kind: "n64-rom-entry",
    role,
    source_order: order,
    decoded: order !== "z64",
  },
});

/**
 * The members of a ROM of `fileSize` bytes. The layout depends only on the
 * file size and byte order, so a reader can charge its allowance before it
 * reads the checksum window.
 */
export const n64RomRegions = (
  fileSize: number,
  order: N64ByteOrder,
): readonly N64RomRegion[] => [
  entryFor(N64_HEADER_ENTRY, 0, N64_HEADER_BYTES, order, "header"),
  ...(fileSize >= N64_IPL3_END
    ? [
        entryFor(
          N64_IPL3_ENTRY,
          N64_IPL3_OFFSET,
          N64_IPL3_END - N64_IPL3_OFFSET,
          order,
          "ipl3",
        ),
      ]
    : []),
  entryFor(N64_PROGRAM_ENTRY, 0, fileSize, order, "program"),
];

/**
 * Bytes the members of a ROM of `fileSize` bytes hold when served. Each member
 * is hashed on its own, including the program range that overlaps the header
 * and IPL3, and a v64 or n64 dump also holds a decoded copy of each member.
 */
export const n64RomMemberBytes = (
  fileSize: number,
  order: N64ByteOrder,
): bigint => {
  let bytes = 0n;
  for (const region of n64RomRegions(fileSize, order))
    bytes += BigInt(region.length) * (order === "z64" ? 1n : 2n);
  return bytes;
};

/**
 * Interpret a cartridge image. `bytes` must cover the file, or the first
 * {@link N64_CHECKSUM_END} bytes when the file is longer. The result is the
 * big-endian header. A known CIC variant recomputes the CRC pair; a short
 * window is read as zero and named in a limitation. A mismatch is reported
 * and left unchanged.
 */
export const parseN64Rom = (
  bytes: Uint8Array,
  fileSize: number,
): N64RomImage => {
  const order = n64ByteOrder(bytes);
  const sizeFailure = n64RomSizeFailure(fileSize, order);
  if (sizeFailure !== undefined) throw sizeFailure;
  if (order === undefined)
    throw malformedInput(
      N64_FORMAT,
      "Nintendo 64 ROM magic is absent from the first word.",
      { offset: 0, field: "pi_dom1_config" },
    );
  const covered = Math.min(fileSize, N64_CHECKSUM_END);
  if (bytes.length < covered)
    throw malformedInput(
      N64_FORMAT,
      `Checksum window needs ${String(covered)} leading bytes; ${String(bytes.length)} were supplied.`,
      { offset: 0, field: "crc" },
    );
  const normalized = swapN64Bytes(bytes.subarray(0, covered), order);
  const bootFailure = bootAddressFailure(normalized);
  if (bootFailure !== undefined) throw bootFailure;
  const bootAddress = readBe(normalized, N64_HEADER_FIELD.bootAddress);
  const limitations: string[] = [];
  const reserved = reservedLimitation(normalized);
  if (reserved !== undefined) limitations.push(reserved);

  const ipl3Complete = fileSize >= N64_IPL3_END;
  const ipl3Crc32 = ipl3Complete
    ? crc32(normalized.subarray(N64_IPL3_OFFSET, N64_IPL3_END)) >>> 0
    : null;
  const variant = ipl3Crc32 === null ? undefined : cicForHash(ipl3Crc32);
  if (!ipl3Complete)
    limitations.push(
      `The file has ${String(fileSize)} bytes. IPL3 is the 4032 bytes at 0x40..0x1000, so the boot code is incomplete, the CIC variant stays unknown, and the cartridge CRC pair stays unchecked.`,
    );
  else if (variant === undefined)
    limitations.push(
      `IPL3 CRC32 ${hex32(ipl3Crc32 ?? 0)} matches none of the known CIC variants 6101, 6102/7101, 6103/7103, 6105/7105 and 6106/7106. The cartridge CRC pair stays unchecked.`,
    );

  const declaredCrc1 = readBe(normalized, N64_HEADER_FIELD.crc1);
  const declaredCrc2 = readBe(normalized, N64_HEADER_FIELD.crc2);
  let crc: N64RomMetadata["crc"] = {
    status: "not-checked",
    declared_crc1: declaredCrc1,
    declared_crc2: declaredCrc2,
    computed_crc1: null,
    computed_crc2: null,
  };
  if (variant !== undefined) {
    if (fileSize < N64_CHECKSUM_END)
      limitations.push(
        `The checksum window is ${String(N64_CHECKSUM_LENGTH)} bytes starting at 0x1000. The file has ${String(fileSize)} bytes, so the ${String(N64_CHECKSUM_END - fileSize)} bytes past the file were taken as zero.`,
      );
    const computed = n64CartridgeCrc(normalized, variant);
    const matches =
      computed.crc1 === declaredCrc1 && computed.crc2 === declaredCrc2;
    crc = {
      status: matches ? "match" : "mismatch",
      declared_crc1: declaredCrc1,
      declared_crc2: declaredCrc2,
      computed_crc1: computed.crc1,
      computed_crc2: computed.crc2,
    };
    if (!matches)
      limitations.push(
        `Declared CRC1 ${hex32(declaredCrc1)} and CRC2 ${hex32(declaredCrc2)} differ from computed CRC1 ${hex32(computed.crc1)} and CRC2 ${hex32(computed.crc2)} for CIC ${variant.id}.`,
      );
  }

  const title = fieldBytes(normalized, N64_HEADER_FIELD.title);
  const cartridge = fieldBytes(normalized, N64_HEADER_FIELD.cartridgeId);
  const mediaByte = normalized[N64_HEADER_FIELD.media] ?? 0;
  const destinationByte = normalized[N64_HEADER_FIELD.destination] ?? 0;
  const metadata = {
    kind: "n64-rom",
    source_order: order,
    rom_bytes: fileSize,
    pi_dom1_config: readBe(normalized, N64_HEADER_FIELD.piDom1Config),
    clock_rate: readBe(normalized, N64_HEADER_FIELD.clockRate),
    boot_address: bootAddress,
    libultra_release: readBe(normalized, N64_HEADER_FIELD.libultraRelease),
    crc,
    ipl3_crc32: ipl3Crc32,
    cic: variant?.id ?? "unknown",
    title_raw_hex: hexBytes(title),
    title_ascii: renderBytes(title, "."),
    media_byte: mediaByte,
    media_name: MEDIA_NAMES[mediaByte] ?? null,
    cartridge_id: renderBytes(cartridge, "?"),
    cartridge_id_hex: hexBytes(cartridge),
    destination_byte: destinationByte,
    destination_code: renderBytes(Uint8Array.of(destinationByte), "?"),
    destination_name: DESTINATION_NAMES[destinationByte] ?? null,
    version: normalized[N64_HEADER_FIELD.version] ?? 0,
  } satisfies N64RomMetadata;

  return { metadata, limitations, entries: n64RomRegions(fileSize, order) };
};
