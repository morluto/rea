/**
 * Synthetic Android boot and vendor_boot images.
 * Field offsets follow the v0-v4 and vendor v3/v4 layouts directly.
 */

const BOOT_V3_PAGE = 4096;
const LEGACY_V1 = 1648;
const LEGACY_V2 = 1660;
const MODERN_V3 = 1580;
const MODERN_V4 = 1584;
const VENDOR_V3 = 2112;
const VENDOR_V4 = 2128;
/** `vendor_ramdisk_table_entry_v4`: 12-byte prefix, 32-byte name, 16 board ids. */
const VENDOR_ENTRY = 108;
const VENDOR_RAMDISK_NAME_SIZE = 32;
const VENDOR_RAMDISK_BOARD_ID_OFFSET = 44;

export interface BootImageOptions {
  readonly version: 0 | 1 | 2 | 3 | 4;
  readonly pageSize?: number;
  readonly headerSize?: number;
  readonly kernel?: Buffer;
  readonly ramdisk?: Buffer;
  readonly second?: Buffer;
  readonly recoveryDtbo?: Buffer;
  /** File offset. Omit to place the DTBO on the sequential page cursor. */
  readonly recoveryDtboOffset?: number;
  readonly dtb?: Buffer;
  readonly signature?: Buffer;
  readonly name?: string;
  readonly cmdline?: string;
  readonly extraCmdline?: string;
  readonly osVersion?: number;
  readonly kernelAddr?: number;
  readonly ramdiskAddr?: number;
  readonly secondAddr?: number;
  readonly tagsAddr?: number;
  readonly dtbAddr?: number;
  readonly headerDigest?: Buffer;
}

export interface VendorRamdiskFixture {
  readonly name?: string;
  readonly type?: number;
  readonly bytes: Buffer;
  readonly boardId?: Buffer;
}

export interface VendorBootImageOptions {
  readonly version: 3 | 4;
  readonly pageSize?: number;
  readonly headerSize?: number;
  readonly name?: string;
  readonly cmdline?: string;
  readonly kernelAddr?: number;
  readonly ramdiskAddr?: number;
  readonly tagsAddr?: number;
  readonly dtbAddr?: number;
  readonly dtb?: Buffer;
  /** Version 3 section bytes. Empty omits the vendor_ramdisk child. */
  readonly ramdisk?: Buffer;
  /** Version 4 table entries. Their bytes are concatenated into the section. */
  readonly ramdisks?: readonly VendorRamdiskFixture[];
  /** Section bytes with no table entries. Use to leave the section uncovered. */
  readonly section?: Buffer;
  readonly bootconfig?: Buffer;
  readonly entrySize?: number;
}

interface Placement {
  readonly offset: number;
  readonly bytes: Buffer;
}

/** Pack the boot header os_version word. `year` is the calendar year. */
export const osVersionRaw = (
  major: number,
  minor: number,
  patch: number,
  year: number,
  month: number,
): number =>
  ((major & 0x7f) << 25) |
  ((minor & 0x7f) << 18) |
  ((patch & 0x7f) << 11) |
  (((year - 2000) & 0x7f) << 4) |
  (month & 0xf);

const alignUp = (value: number, page: number): number => {
  const remainder = value % page;
  return remainder === 0 ? value : value + (page - remainder);
};

const writeU32 = (buffer: Buffer, offset: number, value: number): void => {
  buffer.writeUInt32LE(value >>> 0, offset);
};

const writeU64 = (buffer: Buffer, offset: number, value: number): void => {
  writeU32(buffer, offset, value >>> 0);
  writeU32(buffer, offset + 4, Math.floor(value / 2 ** 32));
};

const writeU64be = (buffer: Buffer, offset: number, value: number): void => {
  buffer.writeUInt32BE(Math.floor(value / 2 ** 32), offset);
  buffer.writeUInt32BE(value >>> 0, offset + 4);
};

const writeText = (
  buffer: Buffer,
  offset: number,
  length: number,
  text: string,
): void => {
  Buffer.from(text, "utf8").copy(buffer, offset, 0, length);
};

const place = (
  placed: Placement[],
  cursor: number,
  page: number,
  bytes: Buffer | undefined,
): number => {
  if (bytes === undefined || bytes.length === 0) return cursor;
  placed.push({ offset: cursor, bytes });
  return alignUp(cursor + bytes.length, page);
};

const writeLegacyHeader = (
  image: Buffer,
  options: BootImageOptions,
  version: 0 | 1 | 2,
  page: number,
  sizes: {
    readonly kernel: number;
    readonly ramdisk: number;
    readonly second: number;
    readonly recovery: number;
    readonly recoveryOffset: number;
    readonly dtb: number;
  },
): void => {
  writeU32(image, 8, sizes.kernel);
  writeU32(image, 12, options.kernelAddr ?? 0x8000_8000);
  writeU32(image, 16, sizes.ramdisk);
  writeU32(image, 20, options.ramdiskAddr ?? 0x8100_0000);
  writeU32(image, 24, sizes.second);
  writeU32(image, 28, options.secondAddr ?? 0x8110_0000);
  writeU32(image, 32, options.tagsAddr ?? 0x8000_0100);
  writeU32(image, 36, page);
  writeU32(image, 40, version);
  writeU32(image, 44, options.osVersion ?? 0);
  writeText(image, 48, 16, options.name ?? "board");
  writeText(image, 64, 512, options.cmdline ?? "console=tty0");
  (options.headerDigest ?? Buffer.alloc(32)).copy(image, 576, 0, 32);
  writeText(
    image,
    608,
    1024,
    options.extraCmdline ?? " androidboot.hardware=test",
  );
  if (version === 0) return;
  writeU32(image, 1632, sizes.recovery);
  writeU64(image, 1636, sizes.recoveryOffset);
  writeU32(
    image,
    1644,
    options.headerSize ?? (version === 1 ? LEGACY_V1 : LEGACY_V2),
  );
  if (version < 2) return;
  writeU32(image, LEGACY_V1, sizes.dtb);
  writeU64(image, LEGACY_V1 + 4, options.dtbAddr ?? 0x8200_0000);
};

const writeModernHeader = (
  image: Buffer,
  options: BootImageOptions,
  version: 3 | 4,
  sizes: {
    readonly kernel: number;
    readonly ramdisk: number;
    readonly signature: number;
  },
): void => {
  writeU32(image, 8, sizes.kernel);
  writeU32(image, 12, sizes.ramdisk);
  writeU32(image, 16, options.osVersion ?? 0);
  writeU32(
    image,
    20,
    options.headerSize ?? (version === 4 ? MODERN_V4 : MODERN_V3),
  );
  writeU32(image, 40, version);
  writeText(
    image,
    44,
    1536,
    `${options.cmdline ?? "console=tty0"}${options.extraCmdline ?? ""}`,
  );
  if (version === 4) writeU32(image, MODERN_V3, sizes.signature);
};

/** Build a page-padded ANDROID! image. Zero-length components are omitted. */
export const buildBootImage = (options: BootImageOptions): Buffer => {
  const version = options.version;
  const modern = version >= 3;
  const page = modern ? BOOT_V3_PAGE : (options.pageSize ?? 2048);
  const kernel = options.kernel ?? Buffer.from("kernel");
  const ramdisk = options.ramdisk ?? Buffer.from("ramdisk");
  const second = options.second ?? Buffer.alloc(0);
  const recovery = !modern && version >= 1 ? options.recoveryDtbo : undefined;
  const dtb = !modern && version >= 2 ? options.dtb : undefined;
  const signature = version === 4 ? options.signature : undefined;
  const placed: Placement[] = [];
  let cursor = page;
  cursor = place(placed, cursor, page, kernel);
  cursor = place(placed, cursor, page, ramdisk);
  if (!modern) cursor = place(placed, cursor, page, second);
  let recoveryOffset = 0;
  if (recovery !== undefined && recovery.length > 0) {
    recoveryOffset = options.recoveryDtboOffset ?? cursor;
    placed.push({ offset: recoveryOffset, bytes: recovery });
    cursor = Math.max(cursor, alignUp(recoveryOffset + recovery.length, page));
  }
  if (!modern && version >= 2) cursor = place(placed, cursor, page, dtb);
  if (version === 4) cursor = place(placed, cursor, page, signature);
  const image = Buffer.alloc(cursor);
  image.write("ANDROID!", 0, "ascii");
  const sizes = {
    kernel: kernel.length,
    ramdisk: ramdisk.length,
    second: second.length,
    recovery: recovery?.length ?? 0,
    recoveryOffset,
    dtb: dtb?.length ?? 0,
    signature: signature?.length ?? 0,
  };
  switch (version) {
    case 0:
    case 1:
    case 2:
      writeLegacyHeader(image, options, version, page, sizes);
      break;
    case 3:
    case 4:
      writeModernHeader(image, options, version, sizes);
      break;
  }
  for (const item of placed) item.bytes.copy(image, item.offset);
  return image;
};

const vendorRamdiskTable = (
  ramdisks: readonly VendorRamdiskFixture[],
  entrySize: number,
): Buffer => {
  const table = Buffer.alloc(ramdisks.length * entrySize);
  let offset = 0;
  for (const [index, ramdisk] of ramdisks.entries()) {
    const base = index * entrySize;
    writeU32(table, base, ramdisk.bytes.length);
    writeU32(table, base + 4, offset);
    writeU32(table, base + 8, ramdisk.type ?? 0);
    writeText(table, base + 12, VENDOR_RAMDISK_NAME_SIZE, ramdisk.name ?? "");
    ramdisk.boardId?.copy(table, base + VENDOR_RAMDISK_BOARD_ID_OFFSET, 0, 64);
    offset += ramdisk.bytes.length;
  }
  return table;
};

const writeVendorHeader = (
  image: Buffer,
  options: VendorBootImageOptions,
  facts: {
    readonly version: 3 | 4;
    readonly page: number;
    readonly headerSize: number;
    readonly sectionSize: number;
    readonly dtbSize: number;
    readonly tableSize: number;
    readonly entryCount: number;
    readonly entrySize: number;
    readonly bootconfigSize: number;
  },
): void => {
  image.write("VNDRBOOT", 0, "ascii");
  writeU32(image, 8, facts.version);
  writeU32(image, 12, facts.page);
  writeU32(image, 16, options.kernelAddr ?? 0x8000_8000);
  writeU32(image, 20, options.ramdiskAddr ?? 0x8100_0000);
  writeU32(image, 24, facts.sectionSize);
  writeText(image, 28, 2048, options.cmdline ?? "console=tty0");
  writeU32(image, 2076, options.tagsAddr ?? 0x8000_0100);
  writeText(image, 2080, 16, options.name ?? "board");
  writeU32(image, 2096, facts.headerSize);
  writeU32(image, 2100, facts.dtbSize);
  writeU64(image, 2104, options.dtbAddr ?? 0x8200_0000);
  if (facts.version < 4) return;
  writeU32(image, VENDOR_V3, facts.tableSize);
  writeU32(image, VENDOR_V3 + 4, facts.entryCount);
  writeU32(image, VENDOR_V3 + 8, facts.entrySize);
  writeU32(image, VENDOR_V3 + 12, facts.bootconfigSize);
};

/** Build a page-padded VNDRBOOT image. The v4 table is not a child. */
export const buildVendorBootImage = (
  options: VendorBootImageOptions,
): Buffer => {
  const version = options.version;
  const page = options.pageSize ?? 4096;
  const headerSize =
    options.headerSize ?? (version === 4 ? VENDOR_V4 : VENDOR_V3);
  const ramdisks = options.ramdisks ?? [];
  const entrySize = options.entrySize ?? VENDOR_ENTRY;
  const section =
    options.section ??
    (version === 3
      ? (options.ramdisk ?? Buffer.alloc(0))
      : Buffer.concat(ramdisks.map((item) => item.bytes)));
  const dtb = options.dtb ?? Buffer.alloc(0);
  const bootconfig =
    version === 4 ? (options.bootconfig ?? Buffer.alloc(0)) : Buffer.alloc(0);
  const table =
    version === 4 && ramdisks.length > 0
      ? vendorRamdiskTable(ramdisks, entrySize)
      : Buffer.alloc(0);
  const placed: Placement[] = [];
  let cursor = alignUp(headerSize, page);
  const sectionOffset = cursor;
  if (section.length > 0)
    cursor = alignUp(sectionOffset + section.length, page);
  cursor = place(placed, cursor, page, dtb);
  cursor = place(placed, cursor, page, table);
  cursor = place(placed, cursor, page, bootconfig);
  const image = Buffer.alloc(cursor);
  writeVendorHeader(image, options, {
    version,
    page,
    headerSize,
    sectionSize: section.length,
    dtbSize: dtb.length,
    tableSize: table.length,
    entryCount: ramdisks.length,
    entrySize,
    bootconfigSize: bootconfig.length,
  });
  if (section.length > 0) section.copy(image, sectionOffset);
  for (const item of placed) item.bytes.copy(image, item.offset);
  return image;
};

/** Append an AVBf footer. Sizes are written; nothing is signed. */
export const appendAvbFooter = (
  image: Buffer,
  options: {
    readonly vbmeta?: Buffer;
    readonly vbmetaOffset?: number;
    readonly originalImageSize?: number;
    readonly partitionSize?: number;
  } = {},
): Buffer => {
  const vbmeta = options.vbmeta ?? Buffer.from("vbmeta-test");
  const vbmetaOffset = options.vbmetaOffset ?? image.length;
  const originalImageSize = options.originalImageSize ?? image.length;
  const minimum = Math.max(image.length, vbmetaOffset + vbmeta.length) + 64;
  const partitionSize = options.partitionSize ?? minimum;
  if (partitionSize < minimum)
    throw new Error("partition is shorter than the image, vbmeta, and footer");
  if (vbmetaOffset + vbmeta.length > partitionSize - 64)
    throw new Error("vbmeta does not fit before the footer");
  const out = Buffer.alloc(partitionSize);
  image.copy(out, 0, 0, Math.min(image.length, out.length));
  vbmeta.copy(out, vbmetaOffset);
  const footerAt = partitionSize - 64;
  out.write("AVBf", footerAt, "ascii");
  out.writeUInt32BE(1, footerAt + 4);
  out.writeUInt32BE(0, footerAt + 8);
  writeU64be(out, footerAt + 12, originalImageSize);
  writeU64be(out, footerAt + 20, vbmetaOffset);
  writeU64be(out, footerAt + 28, vbmeta.length);
  return out;
};

/** Drop the final byte. The view is a copy, so the source image stays intact. */
export const truncateImage = (image: Buffer): Buffer =>
  Buffer.from(image.subarray(0, Math.max(0, image.length - 1)));

/**
 * Rewrite a v4 vendor table count. `entry_size` stays 108 and `table_size`
 * becomes `count * 108`.
 */
export const declareVendorRamdiskCount = (
  image: Buffer,
  count: number,
): Buffer => {
  const copy = Buffer.from(image);
  writeU32(copy, VENDOR_V3, count * VENDOR_ENTRY);
  writeU32(copy, VENDOR_V3 + 4, count);
  return copy;
};
