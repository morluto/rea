import { logicalPathNfc } from "./artifactIdentity.js";
import { err, ok, type Result } from "./result.js";

/**
 * Android boot (`ANDROID!`, versions 0-4) and vendor boot (`VNDRBOOT`,
 * versions 3-4) headers. Multi-byte header fields are little-endian.
 * Component bytes are located and bounded here; they are not decompressed,
 * executed, or signature-checked.
 */
export const ANDROID_BOOT_MAGIC = "ANDROID!";
export const VENDOR_BOOT_MAGIC = "VNDRBOOT";
export const ANDROID_BOOT_HEADER_PROBE_BYTES = 4096;
export const AVB_FOOTER_SIZE = 64;
const ANDROID_BOOT_MAGIC_BYTES = Buffer.from(ANDROID_BOOT_MAGIC);
const VENDOR_BOOT_MAGIC_BYTES = Buffer.from(VENDOR_BOOT_MAGIC);
const AVB_FOOTER_MAGIC_BYTES = Buffer.from("AVBf");
const BOOT_V3_PAGE_SIZE = 4096;
const LEGACY_V0_SIZE = 1632;
const LEGACY_V1_SIZE = 1648;
const LEGACY_V2_SIZE = 1660;
const MODERN_V3_SIZE = 1580;
const MODERN_V4_SIZE = 1584;
const VENDOR_V3_SIZE = 2112;
const VENDOR_V4_SIZE = 2128;
// v4 entry: size, offset, type, 32-byte name, 16 board-id words (108 bytes).
const VENDOR_RAMDISK_ENTRY_SIZE = 108;
const MAX_VENDOR_RAMDISKS = 4096;
const MAX_RAMDISK_ENTRY_SIZE = 4096;
const MAX_HEADER_SIZE = 1024 * 1024;
const PAGE_MIN = 2048;
const PAGE_MAX = 65536;
const NAME_SIZE = 16;
const BOOT_ARGS_SIZE = 512;
const BOOT_EXTRA_ARGS_SIZE = 1024;
const VENDOR_ARGS_SIZE = 2048;
const RAMDISK_NAME_SIZE = 32;
const BOARD_ID_BYTES = 64;
const BOARD_ID_OFFSET = 12 + RAMDISK_NAME_SIZE;

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type AndroidBootCompression = "gzip" | "lz4" | "zstd";

export interface AndroidBootComponentPlan {
  readonly role:
    | "kernel"
    | "ramdisk"
    | "second"
    | "recovery-dtbo"
    | "dtb"
    | "vendor-ramdisk"
    | "bootconfig"
    | "signature";
  readonly path: string;
  readonly index: number;
  readonly offset: number;
  readonly size: number;
  readonly loadAddress: number | null;
  readonly ramdiskType: number | null;
  readonly ramdiskTypeName: string | null;
  readonly nameBytesHex: string | null;
  readonly boardIdHex: string | null;
}

export interface AndroidBootParse {
  readonly imageKind: "boot" | "vendor-boot";
  readonly magic: typeof ANDROID_BOOT_MAGIC | typeof VENDOR_BOOT_MAGIC;
  readonly headerVersion: number;
  readonly pageSize: number;
  readonly headerSize: number;
  /** Bytes occupied by the page-aligned header before the first component. */
  readonly headerOccupied: number;
  readonly osVersionRaw: number | null;
  readonly osVersion: string | null;
  readonly securityPatchLevel: string | null;
  readonly name: string | null;
  readonly nameBytesHex: string | null;
  readonly cmdline: string | null;
  readonly cmdlineBytesHex: string;
  readonly extraCmdline: string | null;
  readonly extraCmdlineBytesHex: string | null;
  readonly commandLine: string | null;
  readonly headerDigestHex: string | null;
  readonly kernelAddr: number | null;
  readonly ramdiskAddr: number | null;
  readonly secondAddr: number | null;
  readonly tagsAddr: number | null;
  readonly dtbAddr: number | null;
  readonly kernelSize: number | null;
  readonly ramdiskSize: number | null;
  readonly secondSize: number | null;
  readonly recoveryDtboSize: number | null;
  readonly recoveryDtboOffset: number | null;
  readonly dtbSize: number | null;
  readonly signatureSize: number | null;
  readonly vendorRamdiskSize: number | null;
  readonly vendorRamdiskTableEntryCount: number | null;
  readonly vendorRamdiskTableEntrySize: number | null;
  readonly bootconfigSize: number | null;
  readonly components: readonly AndroidBootComponentPlan[];
  readonly imageEnd: number;
  readonly limitations: readonly string[];
  readonly tableRange: {
    readonly offset: number;
    readonly size: number;
  } | null;
  readonly vendorRamdiskSection: {
    readonly offset: number;
    readonly size: number;
  } | null;
}

export interface VendorRamdiskTableParse {
  readonly components: readonly AndroidBootComponentPlan[];
  readonly limitations: readonly string[];
}

export interface AvbFooterFacts {
  readonly present: boolean;
  readonly footerSize: typeof AVB_FOOTER_SIZE | null;
  readonly versionMajor: number | null;
  readonly versionMinor: number | null;
  readonly originalImageSize: number | null;
  readonly vbmetaOffset: number | null;
  readonly vbmetaSize: number | null;
  readonly limitations: readonly string[];
}

export type AndroidBootParseError =
  | { readonly _tag: "AndroidBootFormatFailure"; readonly message: string }
  | {
      readonly _tag: "AndroidBootCapacityFailure";
      readonly message: string;
      readonly limit: AndroidBootFixedLimit;
    };

/** A fixed parser ceiling, named so readers can report shared recovery. */
export interface AndroidBootFixedLimit {
  readonly name: string;
  readonly maximum: number;
  readonly unit: string;
}

class FormatError extends Error {}
class CapacityError extends Error {
  constructor(
    message: string,
    readonly limit: AndroidBootFixedLimit,
  ) {
    super(message);
  }
}

const formatError = (message: string): never => {
  throw new FormatError(message);
};

const capacityError = (
  message: string,
  limit: AndroidBootFixedLimit,
): never => {
  throw new CapacityError(message, limit);
};

const parsed = <T>(read: () => T): Result<T, AndroidBootParseError> => {
  try {
    return ok(read());
  } catch (cause) {
    if (cause instanceof FormatError)
      return err({ _tag: "AndroidBootFormatFailure", message: cause.message });
    if (cause instanceof CapacityError)
      return err({
        _tag: "AndroidBootCapacityFailure",
        message: cause.message,
        limit: cause.limit,
      });
    throw cause;
  }
};

const requireBytes = (buffer: Buffer, length: number, what: string): void => {
  if (buffer.length < length)
    formatError(
      `${what} is truncated: ${buffer.length} bytes available, at least ${length} required`,
    );
};

const u32 = (buffer: Buffer, offset: number): number => {
  requireBytes(buffer, offset + 4, "header");
  return buffer.readUInt32LE(offset);
};

const u64 = (buffer: Buffer, offset: number, what: string): number => {
  requireBytes(buffer, offset + 8, what);
  const low = buffer.readUInt32LE(offset);
  const high = buffer.readUInt32LE(offset + 4);
  if (high > 0x1f_ffff) formatError(`${what} exceeds a safe integer`);
  return high * 0x1_0000_0000 + low;
};

const u64be = (buffer: Buffer, offset: number, what: string): number => {
  requireBytes(buffer, offset + 8, what);
  const high = buffer.readUInt32BE(offset);
  const low = buffer.readUInt32BE(offset + 4);
  if (high > 0x1f_ffff) formatError(`${what} exceeds a safe integer`);
  return high * 0x1_0000_0000 + low;
};

const alignUp = (value: number, page: number): number => {
  if (!Number.isSafeInteger(value) || value < 0)
    formatError("a component extent is not a safe nonnegative integer");
  const remainder = value % page;
  if (remainder === 0) return value;
  const aligned = value + (page - remainder);
  if (!Number.isSafeInteger(aligned))
    formatError("a page-aligned component extent is not a safe integer");
  return aligned;
};

const endOf = (offset: number, size: number): number => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0
  )
    formatError("a component range is not a safe nonnegative extent");
  const end = offset + size;
  if (!Number.isSafeInteger(end))
    formatError("a component range overflows a safe integer");
  return end;
};

const requirePageSize = (value: number): number => {
  if (
    !Number.isInteger(value) ||
    value < PAGE_MIN ||
    value > PAGE_MAX ||
    (value & (value - 1)) !== 0
  )
    formatError(
      `page size ${value} is not a power of two from 2048 through 65536`,
    );
  return value;
};

const requireHeaderSize = (
  value: number,
  minimum: number,
  maximum: number,
): number => {
  if (value > MAX_HEADER_SIZE)
    capacityError(
      `header_size ${value} exceeds the ${MAX_HEADER_SIZE} byte header bound`,
      {
        name: "Android boot image header_size",
        maximum: MAX_HEADER_SIZE,
        unit: "bytes",
      },
    );
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    formatError(
      `header_size ${value} is outside the supported range ${minimum} through ${maximum}`,
    );
  return value;
};

const requireFileCovers = (fileSize: number, imageEnd: number): void => {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0)
    formatError("file size is not a safe nonnegative integer");
  if (imageEnd > fileSize)
    formatError(
      `image is truncated: components end at byte ${imageEnd} but the file is ${fileSize} bytes`,
    );
};

const decodeField = (
  bytes: Buffer,
): { readonly text: string | null; readonly hex: string } => {
  const nul = bytes.indexOf(0);
  const slice = nul === -1 ? bytes : bytes.subarray(0, nul);
  try {
    return { text: UTF8.decode(slice), hex: bytes.toString("hex") };
  } catch {
    return { text: null, hex: bytes.toString("hex") };
  }
};

const commandFields = (
  cmdlineBytes: Buffer,
  extraBytes: Buffer | null,
): Pick<
  AndroidBootParse,
  | "cmdline"
  | "cmdlineBytesHex"
  | "extraCmdline"
  | "extraCmdlineBytesHex"
  | "commandLine"
> => {
  const cmdline = decodeField(cmdlineBytes);
  const extra = extraBytes === null ? null : decodeField(extraBytes);
  return {
    cmdline: cmdline.text,
    cmdlineBytesHex: cmdline.hex,
    extraCmdline: extra?.text ?? null,
    extraCmdlineBytesHex: extra?.hex ?? null,
    commandLine:
      cmdline.text === null || (extra !== null && extra.text === null)
        ? null
        : `${cmdline.text}${extra?.text ?? ""}`,
  };
};

const decodeOsVersion = (
  raw: number,
): {
  readonly osVersion: string | null;
  readonly securityPatchLevel: string | null;
  readonly limitation: string | null;
} => {
  const major = (raw >>> 25) & 0x7f;
  const minor = (raw >>> 18) & 0x7f;
  const patch = (raw >>> 11) & 0x7f;
  const year = (raw >>> 4) & 0x7f;
  const month = raw & 0xf;
  const osVersion =
    major === 0 && minor === 0 && patch === 0
      ? null
      : `${String(major)}.${String(minor)}.${String(patch)}`;
  if (year === 0 && month === 0)
    return { osVersion, securityPatchLevel: null, limitation: null };
  if (month < 1 || month > 12)
    return {
      osVersion,
      securityPatchLevel: null,
      limitation: `security patch month ${String(month)} is not a calendar month; the raw os_version field is retained`,
    };
  const monthText = String(month).padStart(2, "0");
  return {
    osVersion,
    securityPatchLevel: `${String(2000 + year)}-${monthText}`,
    limitation: null,
  };
};

const baseLimitations = (
  imageKind: AndroidBootParse["imageKind"],
): string[] => [
  "Command line, board name, and vendor ramdisk names are target-derived and untrusted.",
  ...(imageKind === "boot"
    ? [
        "ANDROID! covers boot, init_boot, and recovery images; the header does not record which role the file had.",
      ]
    : []),
];

const component = (
  role: AndroidBootComponentPlan["role"],
  path: string,
  offset: number,
  size: number,
  loadAddress: number | null,
  extra?: Partial<
    Pick<
      AndroidBootComponentPlan,
      | "index"
      | "ramdiskType"
      | "ramdiskTypeName"
      | "nameBytesHex"
      | "boardIdHex"
    >
  >,
): AndroidBootComponentPlan => ({
  role,
  path,
  index: extra?.index ?? 0,
  offset,
  size,
  loadAddress,
  ramdiskType: extra?.ramdiskType ?? null,
  ramdiskTypeName: extra?.ramdiskTypeName ?? null,
  nameBytesHex: extra?.nameBytesHex ?? null,
  boardIdHex: extra?.boardIdHex ?? null,
});

const place = (
  components: AndroidBootComponentPlan[],
  cursor: number,
  page: number,
  planned: AndroidBootComponentPlan | null,
): number => {
  if (planned === null || planned.size === 0) return cursor;
  components.push(planned);
  return alignUp(endOf(cursor, planned.size), page);
};

const bootParse = (
  fields: Pick<
    AndroidBootParse,
    | "imageKind"
    | "magic"
    | "headerVersion"
    | "pageSize"
    | "headerSize"
    | "headerOccupied"
    | "cmdlineBytesHex"
    | "components"
    | "imageEnd"
    | "limitations"
  > &
    Partial<AndroidBootParse>,
): AndroidBootParse => ({
  osVersionRaw: null,
  osVersion: null,
  securityPatchLevel: null,
  name: null,
  nameBytesHex: null,
  cmdline: null,
  extraCmdline: null,
  extraCmdlineBytesHex: null,
  commandLine: null,
  headerDigestHex: null,
  kernelAddr: null,
  ramdiskAddr: null,
  secondAddr: null,
  tagsAddr: null,
  dtbAddr: null,
  kernelSize: null,
  ramdiskSize: null,
  secondSize: null,
  recoveryDtboSize: null,
  recoveryDtboOffset: null,
  dtbSize: null,
  signatureSize: null,
  vendorRamdiskSize: null,
  vendorRamdiskTableEntryCount: null,
  vendorRamdiskTableEntrySize: null,
  bootconfigSize: null,
  tableRange: null,
  vendorRamdiskSection: null,
  ...fields,
});

const RAMDISK_TYPE_NAMES: Readonly<Record<number, string>> = {
  0: "none",
  1: "platform",
  2: "recovery",
  3: "dlkm",
};

const ramdiskTypeName = (value: number): string =>
  RAMDISK_TYPE_NAMES[value] ?? "unknown";

const hasPrefix = (buffer: Buffer, bytes: readonly number[]): boolean =>
  buffer.length >= bytes.length &&
  bytes.every((byte, index) => buffer[index] === byte);

/** True when the first eight bytes are ANDROID! or VNDRBOOT. */
export const hasAndroidBootImageMagic = (prefix: Buffer): boolean =>
  prefix.length >= 8 &&
  (prefix.subarray(0, 8).equals(ANDROID_BOOT_MAGIC_BYTES) ||
    prefix.subarray(0, 8).equals(VENDOR_BOOT_MAGIC_BYTES));

/** gzip, lz4 frame, lz4 legacy, or zstd magic. Other prefixes stay unknown. */
export const compressionFromPrefix = (
  prefix: Buffer,
): AndroidBootCompression | null => {
  if (hasPrefix(prefix, [0x1f, 0x8b])) return "gzip";
  if (hasPrefix(prefix, [0x04, 0x22, 0x4d, 0x18])) return "lz4";
  if (hasPrefix(prefix, [0x02, 0x21, 0x4c, 0x18])) return "lz4";
  if (hasPrefix(prefix, [0x28, 0xb5, 0x2f, 0xfd])) return "zstd";
  return null;
};

const legacyStructSize = (version: number): number => {
  if (version === 0) return LEGACY_V0_SIZE;
  if (version === 1) return LEGACY_V1_SIZE;
  return LEGACY_V2_SIZE;
};

const layoutLegacyTail = (
  prefix: Buffer,
  version: number,
  page: number,
  cursor: number,
  components: AndroidBootComponentPlan[],
  limitations: string[],
): {
  readonly cursor: number;
  readonly recoveryDtboSize: number | null;
  readonly recoveryDtboOffset: number | null;
  readonly dtbSize: number | null;
  readonly dtbAddr: number | null;
} => {
  if (version < 1)
    return {
      cursor,
      recoveryDtboSize: null,
      recoveryDtboOffset: null,
      dtbSize: null,
      dtbAddr: null,
    };
  const recoveryDtboSize = u32(prefix, LEGACY_V0_SIZE);
  const recoveryDtboOffset = u64(
    prefix,
    LEGACY_V0_SIZE + 4,
    "recovery_dtbo offset",
  );
  let next = cursor;
  if (recoveryDtboSize > 0) {
    if (recoveryDtboOffset % page !== 0)
      formatError(
        `recovery_dtbo offset ${recoveryDtboOffset} is not aligned to page size ${page}`,
      );
    endOf(recoveryDtboOffset, recoveryDtboSize);
    if (recoveryDtboOffset < cursor)
      formatError("recovery_dtbo overlaps an earlier component");
    if (recoveryDtboOffset > cursor)
      limitations.push(
        "Bytes between the sequential layout and recovery_dtbo were not exposed as entries.",
      );
    components.push(
      component(
        "recovery-dtbo",
        "recovery_dtbo",
        recoveryDtboOffset,
        recoveryDtboSize,
        null,
      ),
    );
    next = alignUp(endOf(recoveryDtboOffset, recoveryDtboSize), page);
  }
  if (version < 2)
    return {
      cursor: next,
      recoveryDtboSize,
      recoveryDtboOffset,
      dtbSize: null,
      dtbAddr: null,
    };
  const dtbSize = u32(prefix, LEGACY_V1_SIZE);
  const dtbAddr = u64(prefix, LEGACY_V1_SIZE + 4, "dtb address");
  return {
    cursor: place(
      components,
      next,
      page,
      dtbSize === 0 ? null : component("dtb", "dtb", next, dtbSize, dtbAddr),
    ),
    recoveryDtboSize,
    recoveryDtboOffset,
    dtbSize,
    dtbAddr,
  };
};

const parseLegacyBoot = (
  prefix: Buffer,
  fileSize: number,
  headerVersion: number,
): AndroidBootParse => {
  const structSize = legacyStructSize(headerVersion);
  requireBytes(prefix, structSize, "header");
  const pageSize = requirePageSize(u32(prefix, 36));
  const headerSize =
    headerVersion === 0
      ? LEGACY_V0_SIZE
      : requireHeaderSize(
          u32(prefix, LEGACY_V1_SIZE - 4),
          structSize,
          pageSize,
        );
  const limitations = baseLimitations("boot");
  if (headerVersion > 0 && headerSize > structSize)
    limitations.push(
      `Header bytes after the v${String(headerVersion)} structure were not decoded.`,
    );
  const osRaw = u32(prefix, 44);
  const os = decodeOsVersion(osRaw);
  if (os.limitation !== null) limitations.push(os.limitation);
  const name = decodeField(prefix.subarray(48, 48 + NAME_SIZE));
  const commands = commandFields(
    prefix.subarray(64, 64 + BOOT_ARGS_SIZE),
    prefix.subarray(608, 608 + BOOT_EXTRA_ARGS_SIZE),
  );
  const components: AndroidBootComponentPlan[] = [];
  const kernelSize = u32(prefix, 8);
  const kernelAddr = u32(prefix, 12);
  const ramdiskSize = u32(prefix, 16);
  const ramdiskAddr = u32(prefix, 20);
  const secondSize = u32(prefix, 24);
  const secondAddr = u32(prefix, 28);
  let cursor = place(
    components,
    pageSize,
    pageSize,
    kernelSize === 0
      ? null
      : component("kernel", "kernel", pageSize, kernelSize, kernelAddr),
  );
  cursor = place(
    components,
    cursor,
    pageSize,
    ramdiskSize === 0
      ? null
      : component("ramdisk", "ramdisk", cursor, ramdiskSize, ramdiskAddr),
  );
  cursor = place(
    components,
    cursor,
    pageSize,
    secondSize === 0
      ? null
      : component("second", "second", cursor, secondSize, secondAddr),
  );
  const tail = layoutLegacyTail(
    prefix,
    headerVersion,
    pageSize,
    cursor,
    components,
    limitations,
  );
  requireFileCovers(fileSize, tail.cursor);
  return bootParse({
    imageKind: "boot",
    magic: ANDROID_BOOT_MAGIC,
    headerVersion,
    pageSize,
    headerSize,
    headerOccupied: pageSize,
    osVersionRaw: osRaw,
    osVersion: os.osVersion,
    securityPatchLevel: os.securityPatchLevel,
    name: name.text,
    nameBytesHex: name.hex,
    ...commands,
    headerDigestHex: prefix.subarray(576, 608).toString("hex"),
    kernelAddr,
    ramdiskAddr,
    secondAddr,
    tagsAddr: u32(prefix, 32),
    dtbAddr: tail.dtbAddr,
    kernelSize,
    ramdiskSize,
    secondSize,
    recoveryDtboSize: tail.recoveryDtboSize,
    recoveryDtboOffset: tail.recoveryDtboOffset,
    dtbSize: tail.dtbSize,
    components,
    imageEnd: tail.cursor,
    limitations,
  });
};

const parseModernBoot = (
  prefix: Buffer,
  fileSize: number,
  headerVersion: 3 | 4,
): AndroidBootParse => {
  const structSize = headerVersion === 4 ? MODERN_V4_SIZE : MODERN_V3_SIZE;
  requireBytes(prefix, structSize, "header");
  const headerSize = requireHeaderSize(
    u32(prefix, 20),
    structSize,
    BOOT_V3_PAGE_SIZE,
  );
  const limitations = baseLimitations("boot");
  if (headerSize > structSize)
    limitations.push(
      `Header bytes after the v${String(headerVersion)} structure were not decoded.`,
    );
  const osRaw = u32(prefix, 16);
  const os = decodeOsVersion(osRaw);
  if (os.limitation !== null) limitations.push(os.limitation);
  const commands = commandFields(
    prefix.subarray(44, 44 + BOOT_ARGS_SIZE + BOOT_EXTRA_ARGS_SIZE),
    null,
  );
  const kernelSize = u32(prefix, 8);
  const ramdiskSize = u32(prefix, 12);
  const signatureSize =
    headerVersion === 4 ? u32(prefix, MODERN_V3_SIZE) : null;
  const components: AndroidBootComponentPlan[] = [];
  let cursor = place(
    components,
    BOOT_V3_PAGE_SIZE,
    BOOT_V3_PAGE_SIZE,
    kernelSize === 0
      ? null
      : component("kernel", "kernel", BOOT_V3_PAGE_SIZE, kernelSize, null),
  );
  cursor = place(
    components,
    cursor,
    BOOT_V3_PAGE_SIZE,
    ramdiskSize === 0
      ? null
      : component("ramdisk", "ramdisk", cursor, ramdiskSize, null),
  );
  cursor = place(
    components,
    cursor,
    BOOT_V3_PAGE_SIZE,
    signatureSize === null || signatureSize === 0
      ? null
      : component("signature", "signature", cursor, signatureSize, null),
  );
  requireFileCovers(fileSize, cursor);
  return bootParse({
    imageKind: "boot",
    magic: ANDROID_BOOT_MAGIC,
    headerVersion,
    pageSize: BOOT_V3_PAGE_SIZE,
    headerSize,
    headerOccupied: BOOT_V3_PAGE_SIZE,
    osVersionRaw: osRaw,
    osVersion: os.osVersion,
    securityPatchLevel: os.securityPatchLevel,
    ...commands,
    kernelSize,
    ramdiskSize,
    signatureSize,
    components,
    imageEnd: cursor,
    limitations,
  });
};

const parseVendorTableHeader = (
  prefix: Buffer,
): {
  readonly tableSize: number;
  readonly entryCount: number;
  readonly entrySize: number;
  readonly bootconfigSize: number;
} => {
  const tableSize = u32(prefix, VENDOR_V3_SIZE);
  const entryCount = u32(prefix, VENDOR_V3_SIZE + 4);
  const entrySize = u32(prefix, VENDOR_V3_SIZE + 8);
  const bootconfigSize = u32(prefix, VENDOR_V3_SIZE + 12);
  if (entryCount > MAX_VENDOR_RAMDISKS)
    capacityError(
      `vendor ramdisk table declares more than ${MAX_VENDOR_RAMDISKS} entries`,
      {
        name: "Android vendor ramdisk table entry count",
        maximum: MAX_VENDOR_RAMDISKS,
        unit: "entries",
      },
    );
  if (entrySize > MAX_RAMDISK_ENTRY_SIZE)
    capacityError(
      `vendor ramdisk table entry size ${entrySize} exceeds the ${MAX_RAMDISK_ENTRY_SIZE} byte entry bound`,
      {
        name: "Android vendor ramdisk table entry size",
        maximum: MAX_RAMDISK_ENTRY_SIZE,
        unit: "bytes",
      },
    );
  if (entryCount > 0 && entrySize < VENDOR_RAMDISK_ENTRY_SIZE)
    formatError(
      `vendor ramdisk table entry size ${entrySize} is smaller than the ${VENDOR_RAMDISK_ENTRY_SIZE}-byte v4 entry`,
    );
  const product = entryCount * entrySize;
  if (!Number.isSafeInteger(product) || product !== tableSize)
    formatError(
      `vendor ramdisk table size ${tableSize} does not equal ${entryCount} entries of ${entrySize} bytes`,
    );
  return { tableSize, entryCount, entrySize, bootconfigSize };
};

const parseVendorHeader = (
  prefix: Buffer,
  fileSize: number,
): AndroidBootParse => {
  requireBytes(prefix, 12, "header");
  const headerVersion = u32(prefix, 8);
  if (headerVersion !== 3 && headerVersion !== 4)
    formatError(`vendor boot header version ${headerVersion} is unsupported`);
  const structSize = headerVersion === 4 ? VENDOR_V4_SIZE : VENDOR_V3_SIZE;
  requireBytes(prefix, structSize, "header");
  const pageSize = requirePageSize(u32(prefix, 12));
  const kernelAddr = u32(prefix, 16);
  const ramdiskAddr = u32(prefix, 20);
  const vendorRamdiskSize = u32(prefix, 24);
  const tagsAddr = u32(prefix, 2076);
  const name = decodeField(prefix.subarray(2080, 2080 + NAME_SIZE));
  const headerSize = requireHeaderSize(
    u32(prefix, 2096),
    structSize,
    MAX_HEADER_SIZE,
  );
  const dtbSize = u32(prefix, 2100);
  const dtbAddr = u64(prefix, 2104, "dtb address");
  const table = headerVersion === 4 ? parseVendorTableHeader(prefix) : null;
  const limitations = baseLimitations("vendor-boot");
  if (headerSize > structSize)
    limitations.push(
      `Header bytes after the v${String(headerVersion)} structure were not decoded.`,
    );
  const headerOccupied = alignUp(headerSize, pageSize);
  const sectionOffset = headerOccupied;
  let cursor =
    vendorRamdiskSize === 0
      ? sectionOffset
      : alignUp(endOf(sectionOffset, vendorRamdiskSize), pageSize);
  const components: AndroidBootComponentPlan[] = [];
  if (headerVersion === 3 && vendorRamdiskSize > 0)
    components.push(
      component(
        "vendor-ramdisk",
        "vendor_ramdisk",
        sectionOffset,
        vendorRamdiskSize,
        ramdiskAddr,
      ),
    );
  cursor = place(
    components,
    cursor,
    pageSize,
    dtbSize === 0 ? null : component("dtb", "dtb", cursor, dtbSize, dtbAddr),
  );
  const tableRange =
    table !== null && table.tableSize > 0
      ? { offset: cursor, size: table.tableSize }
      : null;
  if (tableRange !== null)
    cursor = alignUp(endOf(tableRange.offset, tableRange.size), pageSize);
  const bootconfigSize = table?.bootconfigSize ?? null;
  cursor = place(
    components,
    cursor,
    pageSize,
    bootconfigSize === null || bootconfigSize === 0
      ? null
      : component("bootconfig", "bootconfig", cursor, bootconfigSize, null),
  );
  if (table !== null && table.entryCount === 0 && vendorRamdiskSize > 0)
    limitations.push(
      "Vendor ramdisk section bytes outside the ramdisk table were not exposed as entries.",
    );
  requireFileCovers(fileSize, cursor);
  return bootParse({
    imageKind: "vendor-boot",
    magic: VENDOR_BOOT_MAGIC,
    headerVersion,
    pageSize,
    headerSize,
    headerOccupied,
    name: name.text,
    nameBytesHex: name.hex,
    ...commandFields(prefix.subarray(28, 28 + VENDOR_ARGS_SIZE), null),
    kernelAddr,
    ramdiskAddr,
    tagsAddr,
    dtbAddr,
    dtbSize,
    vendorRamdiskSize,
    vendorRamdiskTableEntryCount: table?.entryCount ?? null,
    vendorRamdiskTableEntrySize: table?.entrySize ?? null,
    bootconfigSize,
    components,
    imageEnd: cursor,
    limitations,
    tableRange,
    vendorRamdiskSection: { offset: sectionOffset, size: vendorRamdiskSize },
  });
};

const parseAndroidHeader = (
  prefix: Buffer,
  fileSize: number,
): AndroidBootParse => {
  requireBytes(prefix, 44, "header");
  const headerVersion = u32(prefix, 40);
  if (headerVersion <= 2)
    return parseLegacyBoot(prefix, fileSize, headerVersion);
  if (headerVersion === 3 || headerVersion === 4)
    return parseModernBoot(prefix, fileSize, headerVersion);
  return formatError(`header version ${headerVersion} is unsupported`);
};

/** Decode one boot or vendor_boot header and its page-aligned component ranges. */
export const parseAndroidBootHeader = (
  prefix: Buffer,
  fileSize: number,
): Result<AndroidBootParse, AndroidBootParseError> =>
  parsed(() => {
    if (!Number.isSafeInteger(fileSize) || fileSize < 0)
      formatError("file size is not a safe nonnegative integer");
    requireBytes(prefix, 8, "header");
    if (prefix.subarray(0, 8).equals(ANDROID_BOOT_MAGIC_BYTES))
      return parseAndroidHeader(prefix, fileSize);
    if (prefix.subarray(0, 8).equals(VENDOR_BOOT_MAGIC_BYTES))
      return parseVendorHeader(prefix, fileSize);
    return formatError("magic is not ANDROID! or VNDRBOOT");
  });

const vendorRamdiskPath = (
  text: string | null,
  index: number,
  used: Set<string>,
): string => {
  const base =
    text !== null &&
    text.length > 0 &&
    text !== "." &&
    text !== ".." &&
    !text.includes("/")
      ? // Inventory keys logical paths by their NFC spelling, so uniqueness
        // is checked in that spelling; name_bytes_hex keeps the stored bytes.
        logicalPathNfc(text)
      : `ramdisk-${String(index)}`;
  // `-<index>` can itself match an earlier name (`x` beside `x-2`, or a
  // fallback `ramdisk-<index>` beside a real name of that form). Keep
  // suffixing until the segment is unused.
  let unique = used.has(base) ? `${base}-${String(index)}` : base;
  let extra = 2;
  while (used.has(unique)) {
    unique = `${base}-${String(index)}-${String(extra)}`;
    extra += 1;
  }
  used.add(unique);
  return `vendor_ramdisk/${unique}`;
};

const sectionCovered = (
  entries: readonly AndroidBootComponentPlan[],
  sectionOffset: number,
  sectionSize: number,
): boolean => {
  let covered = 0;
  const spans = entries
    .map((entry) => ({
      start: entry.offset - sectionOffset,
      end: entry.offset - sectionOffset + entry.size,
    }))
    .sort((left, right) => left.start - right.start);
  for (const span of spans) {
    if (span.start > covered) return false;
    covered = Math.max(covered, span.end);
  }
  return covered === sectionSize;
};

const readVendorRamdiskTable = (
  table: Buffer,
  input: {
    readonly entryCount: number;
    readonly entrySize: number;
    readonly sectionOffset: number;
    readonly sectionSize: number;
  },
): VendorRamdiskTableParse => {
  if (input.entryCount > 0 && input.entrySize < VENDOR_RAMDISK_ENTRY_SIZE)
    formatError(
      `vendor ramdisk table entry size ${input.entrySize} is smaller than the ${VENDOR_RAMDISK_ENTRY_SIZE}-byte v4 entry`,
    );
  const expected = input.entryCount * input.entrySize;
  if (table.length !== expected)
    formatError(
      `vendor ramdisk table is ${table.length} bytes, expected ${expected}`,
    );
  const components: AndroidBootComponentPlan[] = [];
  const used = new Set<string>();
  let longer = false;
  for (let index = 0; index < input.entryCount; index += 1) {
    const base = index * input.entrySize;
    const size = table.readUInt32LE(base);
    const offset = table.readUInt32LE(base + 4);
    const ramdiskType = table.readUInt32LE(base + 8);
    if (size === 0)
      formatError(`vendor ramdisk table entry ${index} declares no bytes`);
    if (offset > input.sectionSize || size > input.sectionSize - offset)
      formatError(
        `vendor ramdisk table entry ${index} overruns the vendor ramdisk section`,
      );
    const fileOffset = endOf(input.sectionOffset, offset);
    endOf(fileOffset, size);
    const decoded = decodeField(
      table.subarray(base + 12, base + 12 + RAMDISK_NAME_SIZE),
    );
    if (input.entrySize > VENDOR_RAMDISK_ENTRY_SIZE) longer = true;
    components.push(
      component(
        "vendor-ramdisk",
        vendorRamdiskPath(decoded.text, index, used),
        fileOffset,
        size,
        // ramdisk_addr is the assembled section's base; a fragment's placement
        // depends on bootloader selection, so it is not published per entry.
        null,
        {
          index,
          ramdiskType,
          ramdiskTypeName: ramdiskTypeName(ramdiskType),
          nameBytesHex: decoded.hex,
          boardIdHex: table
            .subarray(
              base + BOARD_ID_OFFSET,
              base + BOARD_ID_OFFSET + BOARD_ID_BYTES,
            )
            .toString("hex"),
        },
      ),
    );
  }
  const ordered = [...components].sort(
    (left, right) => left.offset - right.offset || left.index - right.index,
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.offset + previous.size > current.offset
    )
      formatError(
        `vendor ramdisk table entry ${current.index} overlaps entry ${previous.index}`,
      );
  }
  const limitations: string[] = [];
  if (longer)
    limitations.push(
      `Vendor ramdisk table entries are longer than the ${String(VENDOR_RAMDISK_ENTRY_SIZE)}-byte v4 structure; trailing entry bytes were not decoded.`,
    );
  if (!sectionCovered(components, input.sectionOffset, input.sectionSize))
    limitations.push(
      "Vendor ramdisk section bytes outside the ramdisk table were not exposed as entries.",
    );
  return { components, limitations };
};

/** Split a v4 vendor ramdisk table into non-overlapping section slices. */
export const parseVendorRamdiskTable = (
  table: Buffer,
  input: {
    readonly entryCount: number;
    readonly entrySize: number;
    readonly sectionOffset: number;
    readonly sectionSize: number;
  },
): Result<VendorRamdiskTableParse, AndroidBootParseError> =>
  parsed(() => readVendorRamdiskTable(table, input));

const absentFooter = (limitations: readonly string[] = []): AvbFooterFacts => ({
  present: false,
  footerSize: null,
  versionMajor: null,
  versionMinor: null,
  originalImageSize: null,
  vbmetaOffset: null,
  vbmetaSize: null,
  limitations,
});

const rejectVbmetaOverlap = (
  vbmeta: { readonly offset: number; readonly size: number },
  fileSize: number,
  headerOccupied: number,
  components: readonly { readonly offset: number; readonly size: number }[],
): void => {
  if (vbmeta.size === 0) return;
  if (endOf(vbmeta.offset, vbmeta.size) > fileSize - AVB_FOOTER_SIZE)
    formatError("AVB vbmeta overlaps the footer");
  const occupied = [{ offset: 0, size: headerOccupied }, ...components];
  for (const componentRange of occupied)
    if (
      componentRange.size > 0 &&
      vbmeta.offset < componentRange.offset + componentRange.size &&
      componentRange.offset < vbmeta.offset + vbmeta.size
    )
      formatError(
        componentRange.offset === 0
          ? "AVB vbmeta overlaps the boot image header"
          : `AVB vbmeta overlaps a component at offset ${componentRange.offset}`,
      );
};

const readAvbFooter = (input: {
  readonly fileSize: number;
  readonly imageEnd: number;
  readonly headerOccupied: number;
  readonly components: readonly {
    readonly offset: number;
    readonly size: number;
  }[];
  readonly tail: Buffer | null;
}): AvbFooterFacts => {
  if (input.fileSize < input.imageEnd)
    formatError(
      `image is truncated: components end at byte ${input.imageEnd} but the file is ${input.fileSize} bytes`,
    );
  const trailing = input.fileSize - input.imageEnd;
  if (trailing === 0) return absentFooter();
  if (trailing < AVB_FOOTER_SIZE)
    return absentFooter([
      `${trailing} trailing bytes follow the boot image and are shorter than a 64-byte AVB footer.`,
    ]);
  const tail = input.tail;
  if (tail === null || tail.length !== AVB_FOOTER_SIZE)
    throw new FormatError("AVB footer bytes were not supplied");
  if (!tail.subarray(0, 4).equals(AVB_FOOTER_MAGIC_BYTES))
    return absentFooter([
      `${trailing} trailing bytes follow the boot image and were not decoded as an AVB footer.`,
    ]);
  const originalImageSize = u64be(tail, 12, "AVB original image size");
  const vbmetaOffset = u64be(tail, 20, "AVB vbmeta offset");
  const vbmetaSize = u64be(tail, 28, "AVB vbmeta size");
  if (originalImageSize < input.imageEnd)
    formatError(
      `AVB original image size ${originalImageSize} ends before boot image components at ${input.imageEnd}`,
    );
  if (originalImageSize > input.fileSize - AVB_FOOTER_SIZE)
    formatError(
      `AVB original image size ${originalImageSize} overlaps the footer`,
    );
  rejectVbmetaOverlap(
    { offset: vbmetaOffset, size: vbmetaSize },
    input.fileSize,
    input.headerOccupied,
    input.components,
  );
  return {
    present: true,
    footerSize: AVB_FOOTER_SIZE,
    versionMajor: tail.readUInt32BE(4),
    versionMinor: tail.readUInt32BE(8),
    originalImageSize,
    vbmetaOffset,
    vbmetaSize,
    limitations: [],
  };
};

/**
 * Report an AVB footer when the last 64 bytes start with AVBf and sit past
 * the page-aligned image. Sizes are recorded; the footer is not verified.
 */
export const inspectAvbFooter = (input: {
  readonly fileSize: number;
  readonly imageEnd: number;
  readonly headerOccupied: number;
  readonly components: readonly {
    readonly offset: number;
    readonly size: number;
  }[];
  readonly tail: Buffer | null;
}): Result<AvbFooterFacts, AndroidBootParseError> =>
  parsed(() => readAvbFooter(input));
