import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { logicalPathNfc } from "../domain/artifactIdentity.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  ANDROID_BOOT_MAGIC,
  AVB_VBMETA_MAGIC,
  VENDOR_BOOT_MAGIC,
} from "../domain/androidBootImageFormat.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
  truncatedInput,
  unsupportedInput,
  type LimitRef,
} from "../domain/parseFailure.js";
import { createBinaryReaderCache } from "../domain/binaryContainer.js";

/**
 * Android boot (`ANDROID!`, versions 0-4) and vendor boot (`VNDRBOOT`,
 * versions 3-4) headers. Multi-byte header fields are little-endian.
 * Component bytes are located and bounded here; they are not decompressed,
 * executed, or signature-checked.
 */
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
const MAX_VENDOR_HEADER_SIZE = 1024 * 1024;
const PAGE_MIN = 2048;
const PAGE_MAX = 65536;
const NAME_SIZE = 16;
const BOOT_ARGS_SIZE = 512;
const BOOT_EXTRA_ARGS_SIZE = 1024;
const VENDOR_ARGS_SIZE = 2048;
const RAMDISK_NAME_SIZE = 32;
const BOARD_ID_BYTES = 64;
const BOARD_ID_OFFSET = 12 + RAMDISK_NAME_SIZE;

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
  /** End of the last declared header or component byte. */
  readonly dataEnd: number;
  /** Page-aligned end after the last component; trailing padding may be absent. */
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

/** The ParseFailure format of an Android boot or vendor boot image. */
export const ANDROID_BOOT_FORMAT = "android-boot-image";

const formatError = (message: string): never => {
  throw malformedInput(ANDROID_BOOT_FORMAT, message);
};

const capacityError = (message: string, limit: LimitRef): never => {
  throw decodeLimit(ANDROID_BOOT_FORMAT, message, limit);
};

const HEADER_SIZE_LIMIT = {
  name: "Android boot image header_size",
  maximum: MAX_VENDOR_HEADER_SIZE,
  unit: "bytes",
};
const VENDOR_RAMDISK_COUNT_LIMIT = {
  name: "Android vendor ramdisk table entry count",
  maximum: MAX_VENDOR_RAMDISKS,
  unit: "entries",
};
const VENDOR_RAMDISK_ENTRY_SIZE_LIMIT = {
  name: "Android vendor ramdisk table entry size",
  maximum: MAX_RAMDISK_ENTRY_SIZE,
  unit: "bytes",
};
/** Parser-owned fixed ceilings and their units for artifact recovery. */
export const ANDROID_BOOT_FIXED_LIMITS: ReadonlyMap<
  string,
  LimitRef & { readonly unit: string }
> = new Map([
  [HEADER_SIZE_LIMIT.name, HEADER_SIZE_LIMIT],
  [VENDOR_RAMDISK_COUNT_LIMIT.name, VENDOR_RAMDISK_COUNT_LIMIT],
  [VENDOR_RAMDISK_ENTRY_SIZE_LIMIT.name, VENDOR_RAMDISK_ENTRY_SIZE_LIMIT],
]);

const parsed = <T>(read: () => T): Result<T, ParseFailureError> => {
  try {
    return ok(read());
  } catch (cause) {
    if (!(cause instanceof ParseFailureError)) throw cause;
    return err(cause);
  }
};

const requireBytes = (buffer: Buffer, length: number, what: string): void => {
  if (buffer.length < length)
    throw truncatedInput(
      ANDROID_BOOT_FORMAT,
      `${what} is truncated: ${buffer.length} bytes available, at least ${length} required`,
      { offset: buffer.length, field: what },
    );
};

const littleEndianBootReader = createBinaryReaderCache(
  true,
  ANDROID_BOOT_FORMAT,
);
const bigEndianBootReader = createBinaryReaderCache(false, ANDROID_BOOT_FORMAT);

const u32 = (buffer: Buffer, offset: number): number => {
  requireBytes(buffer, offset + 4, "header");
  return littleEndianBootReader(buffer).u32(offset);
};

const u64 = (buffer: Buffer, offset: number, what: string): number => {
  requireBytes(buffer, offset + 8, what);
  const reader = littleEndianBootReader(buffer);
  const low = reader.u32(offset);
  const high = reader.u32(offset + 4);
  if (high > 0x1f_ffff) formatError(`${what} exceeds a safe integer`);
  return high * 0x1_0000_0000 + low;
};

const u64be = (buffer: Buffer, offset: number, what: string): number => {
  requireBytes(buffer, offset + 8, what);
  const reader = bigEndianBootReader(buffer);
  const high = reader.u32(offset);
  const low = reader.u32(offset + 4);
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
  maximum?: number,
): number => {
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  )
    formatError(
      maximum === undefined
        ? `header_size ${value} is smaller than the ${minimum}-byte structure`
        : `header_size ${value} is outside the supported range ${minimum} through ${maximum}`,
    );
  return value;
};

/**
 * Require the file to hold every declared header and component byte, and
 * return where those bytes end. Producers pad each component to the next
 * page, but the padding after the final one carries no data, so a file that
 * stops at the last declared byte is complete.
 */
const requireFileCovers = (
  fileSize: number,
  headerSize: number,
  ranges: readonly ({
    readonly offset: number;
    readonly size: number;
  } | null)[],
): number => {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0)
    formatError("file size is not a safe nonnegative integer");
  const dataEnd = ranges.reduce(
    (end, range) =>
      range === null || range.size === 0
        ? end
        : Math.max(end, endOf(range.offset, range.size)),
    headerSize,
  );
  if (dataEnd > fileSize)
    throw truncatedInput(
      ANDROID_BOOT_FORMAT,
      `image is truncated: components end at byte ${dataEnd} but the file is ${fileSize} bytes`,
      { offset: fileSize, field: "components" },
    );
  return dataEnd;
};

const untilNul = (bytes: Buffer): Buffer => {
  const nul = bytes.indexOf(0);
  return nul === -1 ? bytes : bytes.subarray(0, nul);
};

const decodeText = (bytes: Buffer): string | null => {
  try {
    return decodeStrictUtf8(bytes, "preserve");
  } catch {
    return null;
  }
};

const decodeField = (
  bytes: Buffer,
): { readonly text: string | null; readonly hex: string } => ({
  text: decodeText(untilNul(bytes)),
  hex: bytes.toString("hex"),
});

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
    // A multibyte character can straddle the cmdline/extra_cmdline split,
    // so the joined line is decoded from the joined bytes.
    commandLine:
      extraBytes === null
        ? cmdline.text
        : decodeText(
            Buffer.concat([untilNul(cmdlineBytes), untilNul(extraBytes)]),
          ),
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
    | "dataEnd"
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
  const dataEnd = requireFileCovers(fileSize, headerSize, components);
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
    dataEnd,
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
  const dataEnd = requireFileCovers(fileSize, headerSize, components);
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
    dataEnd,
    imageEnd: cursor,
    limitations,
  });
};

const vendorTableByteLength = (
  entryCount: number,
  entrySize: number,
): number => {
  if (entryCount > 0 && entrySize < VENDOR_RAMDISK_ENTRY_SIZE)
    formatError(
      `vendor ramdisk table entry size ${entrySize} is smaller than the ${VENDOR_RAMDISK_ENTRY_SIZE}-byte v4 entry`,
    );
  const bytes = entryCount * entrySize;
  if (!Number.isSafeInteger(bytes))
    formatError(
      `vendor ramdisk table dimensions ${entryCount} × ${entrySize} exceed a safe byte length`,
    );
  return bytes;
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
  if (vendorTableByteLength(entryCount, entrySize) !== tableSize)
    formatError(
      `vendor ramdisk table size ${tableSize} does not equal ${entryCount} entries of ${entrySize} bytes`,
    );
  return { tableSize, entryCount, entrySize, bootconfigSize };
};

const requireVendorTableCapacity = (
  entryCount: number,
  entrySize: number,
): void => {
  if (entryCount > MAX_VENDOR_RAMDISKS)
    capacityError(
      `vendor ramdisk table declares more than ${MAX_VENDOR_RAMDISKS} entries`,
      VENDOR_RAMDISK_COUNT_LIMIT,
    );
  if (entrySize > MAX_RAMDISK_ENTRY_SIZE)
    capacityError(
      `vendor ramdisk table entry size ${entrySize} exceeds the ${MAX_RAMDISK_ENTRY_SIZE} byte entry bound`,
      VENDOR_RAMDISK_ENTRY_SIZE_LIMIT,
    );
};

const parseVendorHeader = (
  prefix: Buffer,
  fileSize: number,
): AndroidBootParse => {
  requireBytes(prefix, 12, "header");
  const headerVersion = u32(prefix, 8);
  if (headerVersion !== 3 && headerVersion !== 4)
    throw unsupportedInput(
      ANDROID_BOOT_FORMAT,
      `vendor boot header version ${headerVersion} is unsupported`,
      { offset: 8, field: "header_version", undecodedContent: true },
    );
  const structSize = headerVersion === 4 ? VENDOR_V4_SIZE : VENDOR_V3_SIZE;
  requireBytes(prefix, structSize, "header");
  const pageSize = requirePageSize(u32(prefix, 12));
  const kernelAddr = u32(prefix, 16);
  const ramdiskAddr = u32(prefix, 20);
  const vendorRamdiskSize = u32(prefix, 24);
  const tagsAddr = u32(prefix, 2076);
  const name = decodeField(prefix.subarray(2080, 2080 + NAME_SIZE));
  const headerSize = requireHeaderSize(u32(prefix, 2096), structSize);
  if (headerSize > MAX_VENDOR_HEADER_SIZE) {
    requireFileCovers(fileSize, headerSize, []);
    capacityError(
      `header_size ${headerSize} exceeds the ${MAX_VENDOR_HEADER_SIZE} byte header bound`,
      HEADER_SIZE_LIMIT,
    );
  }
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
  const section = { offset: sectionOffset, size: vendorRamdiskSize };
  const declared = [...components, section, tableRange];
  const dataEnd = requireFileCovers(fileSize, headerSize, declared);
  if (table !== null)
    requireVendorTableCapacity(table.entryCount, table.entrySize);
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
    dataEnd,
    imageEnd: cursor,
    limitations,
    tableRange,
    vendorRamdiskSection: section,
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
  throw unsupportedInput(
    ANDROID_BOOT_FORMAT,
    `header version ${headerVersion} is unsupported`,
    { offset: 40, field: "header_version", undecodedContent: true },
  );
};

/** Decode one boot or vendor_boot header and its page-aligned component ranges. */
export const parseAndroidBootHeader = (
  prefix: Buffer,
  fileSize: number,
): Result<AndroidBootParse, ParseFailureError> =>
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
  const expected = vendorTableByteLength(input.entryCount, input.entrySize);
  requireBytes(table, expected, "vendor ramdisk table");
  if (table.length > expected)
    formatError(
      `vendor ramdisk table is ${table.length} bytes, expected ${expected}`,
    );
  const components: AndroidBootComponentPlan[] = [];
  const used = new Set<string>();
  const empty: number[] = [];
  let longer = false;
  let firstOverrunIndex: number | null = null;
  for (let index = 0; index < input.entryCount; index += 1) {
    const base = index * input.entrySize;
    const size = u32(table, base);
    const offset = u32(table, base + 4);
    const ramdiskType = u32(table, base + 8);
    if (offset > input.sectionSize || size > input.sectionSize - offset) {
      if (firstOverrunIndex === null) firstOverrunIndex = index;
    }
    // An empty fragment carries no bytes to expose, like other zero-sized
    // components; omit it rather than rejecting the image.
    if (size === 0) {
      empty.push(index);
      continue;
    }
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
      throw malformedInput(
        ANDROID_BOOT_FORMAT,
        `vendor ramdisk table entry ${current.index} overlaps entry ${previous.index}`,
        { field: "vendor_ramdisk_table_overlap" },
      );
  }
  if (firstOverrunIndex !== null)
    formatError(
      `vendor ramdisk table entry ${firstOverrunIndex} overruns the vendor ramdisk section`,
    );
  const limitations: string[] = [];
  if (longer)
    limitations.push(
      `Vendor ramdisk table entries are longer than the ${String(VENDOR_RAMDISK_ENTRY_SIZE)}-byte v4 structure; trailing entry bytes were not decoded.`,
    );
  if (empty.length > 0)
    limitations.push(
      `Vendor ramdisk table entries ${empty.join(", ")} declare no bytes and were omitted.`,
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
): Result<VendorRamdiskTableParse, ParseFailureError> =>
  parsed(() => readVendorRamdiskTable(table, input));

export const absentAvbFooter = (
  limitations: readonly string[] = [],
): AvbFooterFacts => ({
  present: false,
  footerSize: null,
  versionMajor: null,
  versionMinor: null,
  originalImageSize: null,
  vbmetaOffset: null,
  vbmetaSize: null,
  limitations,
});

const avbOverlapError = (message: string): never => {
  throw malformedInput(ANDROID_BOOT_FORMAT, message, { field: "avb_overlap" });
};

const rejectVbmetaOverlap = (
  vbmeta: { readonly offset: number; readonly size: number },
  fileSize: number,
  headerOccupied: number,
  components: readonly { readonly offset: number; readonly size: number }[],
): void => {
  if (vbmeta.size === 0) return;
  if (endOf(vbmeta.offset, vbmeta.size) > fileSize - AVB_FOOTER_SIZE)
    avbOverlapError("AVB vbmeta overlaps the footer");
  const occupied = [{ offset: 0, size: headerOccupied }, ...components];
  for (const componentRange of occupied)
    if (
      componentRange.size > 0 &&
      vbmeta.offset < componentRange.offset + componentRange.size &&
      componentRange.offset < vbmeta.offset + vbmeta.size
    )
      avbOverlapError(
        componentRange.offset === 0
          ? "AVB vbmeta overlaps the boot image header"
          : `AVB vbmeta overlaps a component at offset ${componentRange.offset}`,
      );
};

/** The partition-tail footer can start anywhere after the declared boot bytes. */
export const avbFooterOffset = (
  fileSize: number,
  dataEnd: number,
): number | null => {
  const offset = fileSize - AVB_FOOTER_SIZE;
  return offset >= dataEnd ? offset : null;
};

const readAvbFooter = (input: {
  readonly fileSize: number;
  readonly dataEnd: number;
  readonly imageEnd: number;
  readonly headerOccupied: number;
  readonly components: readonly {
    readonly offset: number;
    readonly size: number;
  }[];
  readonly tail: Buffer | null;
}): AvbFooterFacts => {
  if (input.fileSize < input.dataEnd)
    throw truncatedInput(
      ANDROID_BOOT_FORMAT,
      `image is truncated: components end at byte ${input.dataEnd} but the file is ${input.fileSize} bytes`,
      { offset: input.fileSize, field: "components" },
    );
  const { tail } = input;
  const offset = avbFooterOffset(input.fileSize, input.dataEnd);
  if (offset !== null && (tail === null || tail.length !== AVB_FOOTER_SIZE))
    return formatError("AVB footer bytes were not supplied");
  if (offset === null || !tail?.subarray(0, 4).equals(AVB_FOOTER_MAGIC_BYTES)) {
    const trailing = input.fileSize - input.imageEnd;
    if (trailing <= 0) return absentAvbFooter();
    return absentAvbFooter([
      trailing < AVB_FOOTER_SIZE
        ? `${trailing} trailing bytes follow the boot image and are shorter than a 64-byte AVB footer.`
        : `${trailing} trailing bytes follow the boot image and were not decoded as an AVB footer.`,
    ]);
  }
  const vbmetaOffset = u64be(tail, 20, "AVB vbmeta offset");
  const vbmetaSize = u64be(tail, 28, "AVB vbmeta size");
  rejectVbmetaOverlap(
    { offset: vbmetaOffset, size: vbmetaSize },
    input.fileSize,
    input.headerOccupied,
    input.components,
  );
  const originalImageSize = u64be(tail, 12, "AVB original image size");
  if (originalImageSize > input.fileSize - AVB_FOOTER_SIZE)
    avbOverlapError(
      `AVB original image size ${originalImageSize} overlaps the footer`,
    );
  // vbmeta is appended after the original image, including any padding
  // within that image. Existing component checks name specific collisions.
  if (vbmetaSize > 0 && vbmetaOffset < originalImageSize)
    avbOverlapError("AVB vbmeta overlaps the original boot image");
  if (originalImageSize < input.dataEnd)
    formatError(
      `AVB original image size ${originalImageSize} ends before boot image components at ${input.dataEnd}`,
    );
  const reader = bigEndianBootReader(tail);
  return {
    present: true,
    footerSize: AVB_FOOTER_SIZE,
    versionMajor: reader.u32(4),
    versionMinor: reader.u32(8),
    originalImageSize,
    vbmetaOffset,
    vbmetaSize,
    limitations: [],
  };
};

/**
 * Report an AVB footer when the last 64 bytes start with AVBf and sit past
 * the actual boot components. Sizes are recorded; the footer is not verified.
 */
export const inspectAvbFooter = (input: {
  readonly fileSize: number;
  readonly dataEnd: number;
  readonly imageEnd: number;
  readonly headerOccupied: number;
  readonly components: readonly {
    readonly offset: number;
    readonly size: number;
  }[];
  readonly tail: Buffer | null;
}): Result<AvbFooterFacts, ParseFailureError> =>
  parsed(() => readAvbFooter(input));

// ---------------------------------------------------------------------------
// Standalone vbmeta images (`AVB0`)
// ---------------------------------------------------------------------------
//
// Layout follows AOSP `libavb` (`avb_vbmeta_image.h`, `avb_descriptor.h` and
// the per-descriptor headers). All multi-byte fields are big-endian. The
// image is header (256 bytes), authentication block, then auxiliary block;
// the descriptor table lives inside the auxiliary block. Nothing here is
// verified: the hash and signature are recorded as offsets and sizes, the
// public key bytes are not decoded, and descriptors are target-derived.

/** The ParseFailure format of a standalone vbmeta image. */
export const AVB_VBMETA_FORMAT = "avb-vbmeta-image";
export const AVB_VBMETA_HEADER_SIZE = 256;
/** Whole-file bound the reader enforces before parsing a vbmeta image. */
export const AVB_VBMETA_MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const AVB_VBMETA_MAGIC_BYTES = Buffer.from(AVB_VBMETA_MAGIC);
const AVB_DESCRIPTOR_HEADER_SIZE = 16;
const AVB_RELEASE_STRING_SIZE = 48;
const AVB_HASH_ALGORITHM_SIZE = 32;
const AVB_HASHTREE_FIXED_SIZE = 164;
const AVB_HASH_FIXED_SIZE = 116;
const AVB_CHAIN_PARTITION_FIXED_SIZE = 76;
const MAX_AVB_DESCRIPTORS = 4096;

const AVB_DESCRIPTOR_COUNT_LIMIT = {
  name: "AVB vbmeta descriptor count",
  maximum: MAX_AVB_DESCRIPTORS,
  unit: "descriptors",
};
const AVB_VBMETA_IMAGE_SIZE_LIMIT = {
  name: "AVB vbmeta image size",
  maximum: AVB_VBMETA_MAX_IMAGE_BYTES,
  unit: "bytes",
};
/** Parser-owned fixed ceilings and their units for artifact recovery. */
export const AVB_VBMETA_FIXED_LIMITS: ReadonlyMap<
  string,
  LimitRef & { readonly unit: string }
> = new Map([
  [AVB_DESCRIPTOR_COUNT_LIMIT.name, AVB_DESCRIPTOR_COUNT_LIMIT],
  [AVB_VBMETA_IMAGE_SIZE_LIMIT.name, AVB_VBMETA_IMAGE_SIZE_LIMIT],
]);

export const AVB_ALGORITHM_NAMES: Readonly<Record<number, string>> = {
  0: "none",
  1: "sha256-rsa2048",
  2: "sha256-rsa4096",
  3: "sha256-rsa8192",
  4: "sha512-rsa2048",
  5: "sha512-rsa4096",
  6: "sha512-rsa8192",
};

export const AVB_DESCRIPTOR_TAG_NAMES: Readonly<Record<number, string>> = {
  0: "property",
  1: "hashtree",
  2: "hash",
  3: "kernel-cmdline",
  4: "chain-partition",
};

export type AvbDescriptorKind =
  | "property"
  | "hashtree"
  | "hash"
  | "kernel-cmdline"
  | "chain-partition"
  | "unknown";

interface AvbDescriptorBase {
  readonly index: number;
  readonly tag: number;
  readonly kind: AvbDescriptorKind;
  readonly tagName: string;
  /** File offset of the 16-byte descriptor header. */
  readonly offset: number;
  /** Total descriptor bytes: 16-byte header plus num_bytes_following. */
  readonly size: number;
  readonly numBytesFollowing: number;
}

export interface AvbPropertyDescriptor extends AvbDescriptorBase {
  readonly kind: "property";
  readonly key: string | null;
  readonly keyBytesHex: string;
  readonly value: string | null;
  readonly valueBytesHex: string;
}

export interface AvbHashtreeDescriptor extends AvbDescriptorBase {
  readonly kind: "hashtree";
  readonly dmVerityVersion: number;
  readonly imageSize: number;
  readonly treeOffset: number;
  readonly treeSize: number;
  readonly dataBlockSize: number;
  readonly hashBlockSize: number;
  readonly fecNumRoots: number;
  readonly fecOffset: number;
  readonly fecSize: number;
  readonly hashAlgorithm: string | null;
  readonly hashAlgorithmBytesHex: string;
  readonly partitionName: string | null;
  readonly partitionNameBytesHex: string;
  readonly saltHex: string;
  readonly rootDigestHex: string;
  readonly flags: number;
}

export interface AvbHashDescriptor extends AvbDescriptorBase {
  readonly kind: "hash";
  readonly imageSize: number;
  readonly hashAlgorithm: string | null;
  readonly hashAlgorithmBytesHex: string;
  readonly partitionName: string | null;
  readonly partitionNameBytesHex: string;
  readonly saltHex: string;
  readonly digestHex: string;
  readonly flags: number;
}

export interface AvbKernelCmdlineDescriptor extends AvbDescriptorBase {
  readonly kind: "kernel-cmdline";
  readonly flags: number;
  readonly cmdline: string | null;
  readonly cmdlineBytesHex: string;
}

export interface AvbChainPartitionDescriptor extends AvbDescriptorBase {
  readonly kind: "chain-partition";
  readonly rollbackIndexLocation: number;
  readonly partitionName: string | null;
  readonly partitionNameBytesHex: string;
  readonly publicKeySize: number;
  readonly publicKeyHex: string;
  readonly flags: number;
}

export interface AvbUnknownDescriptor extends AvbDescriptorBase {
  readonly kind: "unknown";
}

export type AvbDescriptor =
  | AvbPropertyDescriptor
  | AvbHashtreeDescriptor
  | AvbHashDescriptor
  | AvbKernelCmdlineDescriptor
  | AvbChainPartitionDescriptor
  | AvbUnknownDescriptor;

export interface AvbVbmetaParse {
  readonly magic: typeof AVB_VBMETA_MAGIC;
  readonly requiredLibavbVersionMajor: number;
  readonly requiredLibavbVersionMinor: number;
  readonly authenticationDataBlockSize: number;
  readonly auxiliaryDataBlockSize: number;
  readonly algorithmType: number;
  readonly algorithmTypeName: string;
  readonly hashOffset: number;
  readonly hashSize: number;
  readonly signatureOffset: number;
  readonly signatureSize: number;
  readonly publicKeyOffset: number;
  readonly publicKeySize: number;
  readonly publicKeyMetadataOffset: number;
  readonly publicKeyMetadataSize: number;
  readonly descriptorsOffset: number;
  readonly descriptorsSize: number;
  readonly rollbackIndex: number;
  readonly flags: number;
  readonly flagNames: readonly string[];
  readonly rollbackIndexLocation: number;
  readonly releaseString: string | null;
  readonly releaseStringBytesHex: string;
  readonly descriptors: readonly AvbDescriptor[];
  /** Declared image bytes: header plus authentication and auxiliary blocks. */
  readonly imageSize: number;
  /** File bytes past the declared image; zero for a standalone vbmeta file. */
  readonly trailingBytes: number;
  readonly limitations: readonly string[];
}

const avbFormatError = (message: string): never => {
  throw malformedInput(AVB_VBMETA_FORMAT, message);
};

const be32 = (buffer: Buffer, offset: number): number => {
  requireBytes(buffer, offset + 4, "vbmeta header");
  return cachedBootReader(buffer, false).u32(offset);
};

const avbFlagNames = (flags: number): string[] => {
  const names: string[] = [];
  if ((flags & 1) !== 0) names.push("hashtree-disabled");
  if ((flags & 2) !== 0) names.push("verification-disabled");
  return names;
};

/** A byte range inside a block; both ends must fit and ranges must not overlap. */
const requireBlockRange = (
  block: { readonly offset: number; readonly size: number },
  range: { readonly offset: number; readonly size: number },
  what: string,
): void => {
  if (range.offset > block.size || range.size > block.size - range.offset)
    avbFormatError(`${what} is outside its block`);
};

const requireNoOverlap = (
  first: { readonly offset: number; readonly size: number },
  second: { readonly offset: number; readonly size: number },
  what: string,
): void => {
  if (
    first.size > 0 &&
    second.size > 0 &&
    first.offset < second.offset + second.size &&
    second.offset < first.offset + first.size
  )
    avbFormatError(`${what} overlap`);
};

const requireNulTerminated = (bytes: Buffer, what: string): Buffer => {
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0)
    avbFormatError(`${what} is not NUL-terminated`);
  return bytes.subarray(0, bytes.length - 1);
};

const readDescriptorText = (
  body: Buffer,
  offset: number,
  length: number,
  what: string,
): { readonly text: string | null; readonly hex: string } => {
  if (offset > body.length || length > body.length - offset)
    avbFormatError(`${what} overruns its descriptor`);
  const bytes = body.subarray(offset, offset + length);
  return {
    text: decodeText(requireNulTerminated(bytes, what)),
    hex: bytes.toString("hex"),
  };
};

const readDescriptorBytes = (
  body: Buffer,
  offset: number,
  length: number,
  what: string,
): Buffer => {
  if (offset > body.length || length > body.length - offset)
    avbFormatError(`${what} overruns its descriptor`);
  return body.subarray(offset, offset + length);
};

const descriptorBase = (
  index: number,
  tag: number,
  offset: number,
  numBytesFollowing: number,
): AvbDescriptorBase => ({
  index,
  tag,
  kind:
    tag === 0
      ? "property"
      : tag === 1
        ? "hashtree"
        : tag === 2
          ? "hash"
          : tag === 3
            ? "kernel-cmdline"
            : tag === 4
              ? "chain-partition"
              : "unknown",
  tagName: AVB_DESCRIPTOR_TAG_NAMES[tag] ?? "unknown",
  offset,
  size: AVB_DESCRIPTOR_HEADER_SIZE + numBytesFollowing,
  numBytesFollowing,
});

const parsePropertyDescriptor = (
  base: AvbDescriptorBase,
  body: Buffer,
): AvbPropertyDescriptor => {
  if (body.length < 16)
    avbFormatError("property descriptor is shorter than its key/value sizes");
  const keySize = u64be(body, 0, "property key size");
  const valueSize = u64be(body, 8, "property value size");
  if (keySize > body.length - 16 || valueSize > body.length - 16 - keySize)
    avbFormatError("property descriptor key/value overruns its descriptor");
  const key = readDescriptorText(body, 16, keySize, "property key");
  const value = readDescriptorText(
    body,
    16 + keySize,
    valueSize,
    "property value",
  );
  return {
    ...base,
    kind: "property",
    key: key.text,
    keyBytesHex: key.hex,
    value: value.text,
    valueBytesHex: value.hex,
  };
};

const parseHashtreeDescriptor = (
  base: AvbDescriptorBase,
  body: Buffer,
): AvbHashtreeDescriptor => {
  if (body.length < AVB_HASHTREE_FIXED_SIZE)
    avbFormatError(
      `hashtree descriptor is ${body.length} bytes, expected at least ${AVB_HASHTREE_FIXED_SIZE}`,
    );
  const partitionNameLength = be32(body, 88);
  const saltLength = be32(body, 92);
  const rootDigestLength = be32(body, 96);
  const fixed = AVB_HASHTREE_FIXED_SIZE;
  if (
    partitionNameLength > body.length - fixed ||
    saltLength > body.length - fixed - partitionNameLength ||
    rootDigestLength > body.length - fixed - partitionNameLength - saltLength
  )
    avbFormatError(
      "hashtree descriptor partition name, salt, or root digest overruns its descriptor",
    );
  const partitionName = readDescriptorText(
    body,
    fixed,
    partitionNameLength,
    "hashtree partition name",
  );
  const salt = readDescriptorBytes(
    body,
    fixed + partitionNameLength,
    saltLength,
    "hashtree salt",
  );
  const rootDigest = readDescriptorBytes(
    body,
    fixed + partitionNameLength + saltLength,
    rootDigestLength,
    "hashtree root digest",
  );
  const algorithm = decodeField(
    body.subarray(56, 56 + AVB_HASH_ALGORITHM_SIZE),
  );
  return {
    ...base,
    kind: "hashtree",
    dmVerityVersion: be32(body, 0),
    imageSize: u64be(body, 4, "hashtree image size"),
    treeOffset: u64be(body, 12, "hashtree tree offset"),
    treeSize: u64be(body, 20, "hashtree tree size"),
    dataBlockSize: be32(body, 28),
    hashBlockSize: be32(body, 32),
    fecNumRoots: be32(body, 36),
    fecOffset: u64be(body, 40, "hashtree fec offset"),
    fecSize: u64be(body, 48, "hashtree fec size"),
    hashAlgorithm: algorithm.text,
    hashAlgorithmBytesHex: algorithm.hex,
    partitionName: partitionName.text,
    partitionNameBytesHex: partitionName.hex,
    saltHex: salt.toString("hex"),
    rootDigestHex: rootDigest.toString("hex"),
    flags: be32(body, 100),
  };
};

const parseHashDescriptor = (
  base: AvbDescriptorBase,
  body: Buffer,
): AvbHashDescriptor => {
  if (body.length < AVB_HASH_FIXED_SIZE)
    avbFormatError(
      `hash descriptor is ${body.length} bytes, expected at least ${AVB_HASH_FIXED_SIZE}`,
    );
  const partitionNameLength = be32(body, 40);
  const saltLength = be32(body, 44);
  const digestLength = be32(body, 48);
  const fixed = AVB_HASH_FIXED_SIZE;
  if (
    partitionNameLength > body.length - fixed ||
    saltLength > body.length - fixed - partitionNameLength ||
    digestLength > body.length - fixed - partitionNameLength - saltLength
  )
    avbFormatError(
      "hash descriptor partition name, salt, or digest overruns its descriptor",
    );
  const partitionName = readDescriptorText(
    body,
    fixed,
    partitionNameLength,
    "hash partition name",
  );
  const salt = readDescriptorBytes(
    body,
    fixed + partitionNameLength,
    saltLength,
    "hash salt",
  );
  const digest = readDescriptorBytes(
    body,
    fixed + partitionNameLength + saltLength,
    digestLength,
    "hash digest",
  );
  const algorithm = decodeField(body.subarray(8, 8 + AVB_HASH_ALGORITHM_SIZE));
  return {
    ...base,
    kind: "hash",
    imageSize: u64be(body, 0, "hash image size"),
    hashAlgorithm: algorithm.text,
    hashAlgorithmBytesHex: algorithm.hex,
    partitionName: partitionName.text,
    partitionNameBytesHex: partitionName.hex,
    saltHex: salt.toString("hex"),
    digestHex: digest.toString("hex"),
    flags: be32(body, 52),
  };
};

const parseKernelCmdlineDescriptor = (
  base: AvbDescriptorBase,
  body: Buffer,
): AvbKernelCmdlineDescriptor => {
  if (body.length < 8)
    avbFormatError("kernel cmdline descriptor is shorter than its sizes");
  const cmdlineSize = be32(body, 4);
  if (cmdlineSize > body.length - 8)
    avbFormatError("kernel cmdline overruns its descriptor");
  const cmdline = readDescriptorText(body, 8, cmdlineSize, "kernel cmdline");
  return {
    ...base,
    kind: "kernel-cmdline",
    flags: be32(body, 0),
    cmdline: cmdline.text,
    cmdlineBytesHex: cmdline.hex,
  };
};

const parseChainPartitionDescriptor = (
  base: AvbDescriptorBase,
  body: Buffer,
): AvbChainPartitionDescriptor => {
  if (body.length < AVB_CHAIN_PARTITION_FIXED_SIZE)
    avbFormatError(
      `chain partition descriptor is ${body.length} bytes, expected at least ${AVB_CHAIN_PARTITION_FIXED_SIZE}`,
    );
  const partitionNameLength = be32(body, 4);
  const publicKeyLength = be32(body, 8);
  const fixed = AVB_CHAIN_PARTITION_FIXED_SIZE;
  if (
    partitionNameLength > body.length - fixed ||
    publicKeyLength > body.length - fixed - partitionNameLength
  )
    avbFormatError(
      "chain partition descriptor partition name or public key overruns its descriptor",
    );
  const partitionName = readDescriptorText(
    body,
    fixed,
    partitionNameLength,
    "chain partition name",
  );
  const publicKey = readDescriptorBytes(
    body,
    fixed + partitionNameLength,
    publicKeyLength,
    "chain partition public key",
  );
  return {
    ...base,
    kind: "chain-partition",
    rollbackIndexLocation: be32(body, 0),
    partitionName: partitionName.text,
    partitionNameBytesHex: partitionName.hex,
    publicKeySize: publicKeyLength,
    publicKeyHex: publicKey.toString("hex"),
    flags: be32(body, 12),
  };
};

const parseDescriptor = (
  index: number,
  tag: number,
  offset: number,
  numBytesFollowing: number,
  body: Buffer,
): AvbDescriptor => {
  const base = descriptorBase(index, tag, offset, numBytesFollowing);
  if (tag === 0) return parsePropertyDescriptor(base, body);
  if (tag === 1) return parseHashtreeDescriptor(base, body);
  if (tag === 2) return parseHashDescriptor(base, body);
  if (tag === 3) return parseKernelCmdlineDescriptor(base, body);
  if (tag === 4) return parseChainPartitionDescriptor(base, body);
  return { ...base, kind: "unknown" };
};

const readAvbVbmetaImage = (
  bytes: Buffer,
  fileSize: number,
): AvbVbmetaParse => {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0)
    avbFormatError("file size is not a safe nonnegative integer");
  if (bytes.length !== fileSize)
    avbFormatError("vbmeta bytes do not cover the whole file");
  requireBytes(bytes, AVB_VBMETA_HEADER_SIZE, "vbmeta header");
  if (!bytes.subarray(0, 4).equals(AVB_VBMETA_MAGIC_BYTES))
    avbFormatError("magic is not AVB0");
  const requiredMajor = be32(bytes, 4);
  const requiredMinor = be32(bytes, 8);
  if (requiredMajor !== 1)
    throw unsupportedInput(
      AVB_VBMETA_FORMAT,
      `required libavb version ${requiredMajor}.${requiredMinor} is unsupported; only v1.x headers are decoded`,
      {
        offset: 4,
        field: "required_libavb_version_major",
        undecodedContent: true,
      },
    );
  const authSize = u64be(bytes, 12, "authentication data block size");
  const auxSize = u64be(bytes, 20, "auxiliary data block size");
  if (authSize % 64 !== 0)
    avbFormatError(
      `authentication data block size ${authSize} is not a multiple of 64`,
    );
  if (auxSize % 64 !== 0)
    avbFormatError(
      `auxiliary data block size ${auxSize} is not a multiple of 64`,
    );
  const imageSize = endOf(AVB_VBMETA_HEADER_SIZE + authSize, auxSize);
  if (imageSize > fileSize)
    throw truncatedInput(
      AVB_VBMETA_FORMAT,
      `vbmeta image is truncated: declared ${imageSize} bytes but the file is ${fileSize} bytes`,
      { offset: fileSize, field: "vbmeta image" },
    );
  const algorithmType = be32(bytes, 28);
  const hash = {
    offset: u64be(bytes, 32, "hash offset"),
    size: u64be(bytes, 40, "hash size"),
  };
  const signature = {
    offset: u64be(bytes, 48, "signature offset"),
    size: u64be(bytes, 56, "signature size"),
  };
  const publicKey = {
    offset: u64be(bytes, 64, "public key offset"),
    size: u64be(bytes, 72, "public key size"),
  };
  const publicKeyMetadata = {
    offset: u64be(bytes, 80, "public key metadata offset"),
    size: u64be(bytes, 88, "public key metadata size"),
  };
  const descriptors = {
    offset: u64be(bytes, 96, "descriptors offset"),
    size: u64be(bytes, 104, "descriptors size"),
  };
  const authBlock = { offset: AVB_VBMETA_HEADER_SIZE, size: authSize };
  const auxBlock = {
    offset: AVB_VBMETA_HEADER_SIZE + authSize,
    size: auxSize,
  };
  requireBlockRange(authBlock, hash, "hash");
  requireBlockRange(authBlock, signature, "signature");
  requireNoOverlap(hash, signature, "hash and signature");
  requireBlockRange(auxBlock, publicKey, "public key");
  requireBlockRange(auxBlock, publicKeyMetadata, "public key metadata");
  requireBlockRange(auxBlock, descriptors, "descriptors");
  requireNoOverlap(publicKey, publicKeyMetadata, "public key and its metadata");
  requireNoOverlap(publicKey, descriptors, "public key and descriptors");
  requireNoOverlap(
    publicKeyMetadata,
    descriptors,
    "public key metadata and descriptors",
  );
  const rollbackIndex = u64be(bytes, 112, "rollback index");
  const flags = be32(bytes, 120);
  const rollbackIndexLocation = be32(bytes, 124);
  const release = decodeField(
    bytes.subarray(128, 128 + AVB_RELEASE_STRING_SIZE),
  );
  const limitations: string[] = [
    "The vbmeta hash and signature are recorded and not verified; descriptors are target-derived and untrusted.",
    "Authentication and auxiliary block contents other than the descriptor table are recorded as offsets and sizes; the public key and signature bytes are not decoded.",
  ];
  const algorithmTypeName = AVB_ALGORITHM_NAMES[algorithmType] ?? "unknown";
  if (algorithmTypeName === "unknown")
    limitations.push(
      `Algorithm type ${algorithmType} is not a known AvbAlgorithmType; the hash and signature layout was not interpreted.`,
    );
  const unknownFlagBits = flags & ~0b11;
  if (unknownFlagBits !== 0)
    limitations.push(
      `Flags carry unrecognized bits 0x${unknownFlagBits.toString(16)}; only hashtree-disabled and verification-disabled are decoded.`,
    );
  const tableStart = auxBlock.offset + descriptors.offset;
  const tableEnd = endOf(tableStart, descriptors.size);
  if (descriptors.size % 8 !== 0)
    avbFormatError(
      `descriptors size ${descriptors.size} is not a multiple of 8`,
    );
  const parsedDescriptors: AvbDescriptor[] = [];
  let cursor = tableStart;
  while (cursor < tableEnd) {
    if (tableEnd - cursor < AVB_DESCRIPTOR_HEADER_SIZE)
      throw truncatedInput(
        AVB_VBMETA_FORMAT,
        `descriptor ${parsedDescriptors.length} header is truncated: ${tableEnd - cursor} bytes remain in the descriptor table`,
        { offset: cursor, field: "descriptor header" },
      );
    const tag = u64be(bytes, cursor, "descriptor tag");
    const numBytesFollowing = u64be(
      bytes,
      cursor + 8,
      "descriptor num_bytes_following",
    );
    if (numBytesFollowing % 8 !== 0)
      avbFormatError(
        `descriptor ${parsedDescriptors.length} num_bytes_following ${numBytesFollowing} is not a multiple of 8`,
      );
    const total = endOf(AVB_DESCRIPTOR_HEADER_SIZE, numBytesFollowing);
    if (total > tableEnd - cursor)
      throw truncatedInput(
        AVB_VBMETA_FORMAT,
        `descriptor ${parsedDescriptors.length} of ${total} bytes overruns the ${descriptors.size}-byte descriptor table`,
        { offset: cursor, field: "descriptor" },
      );
    if (parsedDescriptors.length >= MAX_AVB_DESCRIPTORS)
      capacityError(
        `descriptor table declares more than ${MAX_AVB_DESCRIPTORS} descriptors`,
        AVB_DESCRIPTOR_COUNT_LIMIT,
      );
    const index = parsedDescriptors.length;
    const body = bytes.subarray(
      cursor + AVB_DESCRIPTOR_HEADER_SIZE,
      cursor + total,
    );
    const descriptor = parseDescriptor(
      index,
      tag,
      cursor,
      numBytesFollowing,
      body,
    );
    if (descriptor.kind === "unknown")
      limitations.push(
        `Descriptor ${index} has unrecognized tag ${tag} and was not decoded; its ${total} stored bytes are exposed as-is.`,
      );
    parsedDescriptors.push(descriptor);
    cursor += total;
  }
  const trailingBytes = fileSize - imageSize;
  if (trailingBytes > 0) {
    const footer =
      trailingBytes >= 4 &&
      bytes.subarray(imageSize, imageSize + 4).equals(AVB_FOOTER_MAGIC_BYTES);
    limitations.push(
      footer
        ? `${trailingBytes} trailing bytes follow the vbmeta image and start with an AVBf footer; the footer was not decoded as part of this image.`
        : `${trailingBytes} trailing bytes follow the vbmeta image and were not decoded.`,
    );
  }
  return {
    magic: AVB_VBMETA_MAGIC,
    requiredLibavbVersionMajor: requiredMajor,
    requiredLibavbVersionMinor: requiredMinor,
    authenticationDataBlockSize: authSize,
    auxiliaryDataBlockSize: auxSize,
    algorithmType,
    algorithmTypeName,
    hashOffset: hash.offset,
    hashSize: hash.size,
    signatureOffset: signature.offset,
    signatureSize: signature.size,
    publicKeyOffset: publicKey.offset,
    publicKeySize: publicKey.size,
    publicKeyMetadataOffset: publicKeyMetadata.offset,
    publicKeyMetadataSize: publicKeyMetadata.size,
    descriptorsOffset: descriptors.offset,
    descriptorsSize: descriptors.size,
    rollbackIndex,
    flags,
    flagNames: avbFlagNames(flags),
    rollbackIndexLocation,
    releaseString: release.text,
    releaseStringBytesHex: release.hex,
    descriptors: parsedDescriptors,
    imageSize,
    trailingBytes,
    limitations,
  };
};

/**
 * Decode a standalone `AVB0` vbmeta image: the v1.x header, the
 * authentication/auxiliary block bounds, and the descriptor table (property,
 * hashtree, hash, kernel cmdline, chain partition). `bytes` must hold the
 * whole file. The hash and signature are recorded, never verified.
 */
export const parseAvbVbmetaImage = (
  bytes: Buffer,
  fileSize: number,
): Result<AvbVbmetaParse, ParseFailureError> =>
  parsed(() => readAvbVbmetaImage(bytes, fileSize));
