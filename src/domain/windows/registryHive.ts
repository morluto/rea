import { err, ok, type Result } from "../result.js";
import type {
  RegionDecodeFailure,
  RegionFileAdmissionLimit,
  RegionDecoder,
} from "../firmware/regionDecoder.js";

/** REGF base block: `regf`, a 4-byte sequence pair, then fixed offsets. */
export const REGF_MAGIC = "regf";
export const REGF_BASE_BLOCK_BYTES = 4096;
export const REGF_HBIN_MAGIC = "hbin";

/**
 * The `regf` base-block magic at file offset 0. A hive's first hive bin follows
 * the base block, so the magic alone is the recognition fact; whether the rest
 * of the file parses is the reader's question, not classification's.
 */
export const hasRegfHiveSignature = (prefix: Uint8Array): boolean =>
  prefix.length >= 4 && text(prefix.subarray(0, 4)) === REGF_MAGIC;
/** Every hive bin begins on this boundary, so its span covers both cells. */
export const REGF_HBIN_ALIGNMENT = 4096;
/** One cell's stored size is a signed 32-bit count of 8-byte units. */
const REGF_CELL_ALIGNMENT = 8;
/**
 * Whole-file ceiling used when `REA_REGF_HIVE_MAX_FILE_BYTES` is unset.
 * Bins and cell spans are validated without value decoding, so the default
 * stays below a large hive until an operator raises it.
 */
export const REGF_HIVE_MAX_FILE_SETTING = "REA_REGF_HIVE_MAX_FILE_BYTES";
/** Runtime id accepted by `update_analysis_settings`. The environment name seeds it. */
export const REGF_HIVE_MAX_FILE_SETTING_ID =
  "regf.hive_max_file_bytes" as const;
export const DEFAULT_REGF_MAX_FILE_BYTES = 512 * 1024 * 1024;
/** A lower ceiling cannot admit one base block. */
export const MINIMUM_REGF_MAX_FILE_BYTES = REGF_BASE_BLOCK_BYTES;
/**
 * Largest configurable whole-file admission. The reader copies the admitted
 * file into one buffer. 8 GiB is an REA policy ceiling, not a measurement of
 * host memory.
 */
export const MAXIMUM_REGF_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;

/** Effective whole-file ceiling and where that value came from. */
export interface RegfHiveFileAdmission {
  readonly maximumBytes: number;
  readonly source: "default" | "setting" | "runtime";
}

export const REGF_HIVE_FILE_LIMIT_CODE = "regf_hive_file_size";

/** Structured refusal when a hive is outside the effective whole-file ceiling. */
export interface RegfHiveFileLimit extends RegionFileAdmissionLimit {
  readonly code: typeof REGF_HIVE_FILE_LIMIT_CODE;
  readonly setting: typeof REGF_HIVE_MAX_FILE_SETTING_ID;
}

export const regfHiveFileLimit = (
  fileBytes: number,
  admission: RegfHiveFileAdmission,
): RegfHiveFileLimit => ({
  code: REGF_HIVE_FILE_LIMIT_CODE,
  setting: REGF_HIVE_MAX_FILE_SETTING_ID,
  fileBytes: Number.isSafeInteger(fileBytes) ? fileBytes : null,
  maximumBytes: admission.maximumBytes,
  source: admission.source,
  defaultBytes: DEFAULT_REGF_MAX_FILE_BYTES,
  floorBytes: MINIMUM_REGF_MAX_FILE_BYTES,
  maximumSettingBytes: MAXIMUM_REGF_MAX_FILE_BYTES,
  reaRestartRequired: false,
});

/** Name the effective ceiling, its source, the allowed range, and the runtime update. */
export const regfHiveFileLimitMessage = (limit: RegfHiveFileLimit): string =>
  [
    `The effective ${limit.setting} value is ${String(limit.maximumBytes)} bytes (source ${limit.source}; default ${String(limit.defaultBytes)} bytes, floor ${String(limit.floorBytes)} bytes, maximum ${String(limit.maximumSettingBytes)} bytes).`,
    limit.fileBytes === null
      ? "The supplied length is not a safe integer."
      : `The file is ${String(limit.fileBytes)} bytes.`,
    `On MCP, call update_analysis_settings with setting ${limit.setting}, action set, and a value in bytes from ${String(limit.floorBytes)} to ${String(limit.maximumSettingBytes)}, then retry the original request. It applies to the next operation without restarting REA. For CLI or future REA processes, set ${REGF_HIVE_MAX_FILE_SETTING} in the launch environment.`,
  ].join(" ");
/** Header fields retained from the base block; offsets are from the file start. */
const REGF_HEADER = {
  primarySequence: 4,
  secondarySequence: 8,
  majorVersion: 20,
  minorVersion: 24,
  rootCellOffset: 36,
  hiveBinsDataSize: 40,
  checksum: 508,
} as const;
const REGF_HEADER_END = 512;

export interface RegfHeader {
  /** The primary sequence number from the base block. */
  readonly primarySequence: number;
  /** The secondary sequence number; a mismatch means the hive was not cleanly closed. */
  readonly secondarySequence: number;
  readonly majorVersion: number;
  readonly minorVersion: number;
  /** File offset of the root key node cell, relative to the first hive bin. */
  readonly rootCellOffset: number;
  /** Declared byte length of the hive-bin region. */
  readonly hiveBinsDataSize: number;
  /** The stored checksum, and whether it matches the base block's XOR. */
  readonly checksum: { readonly stored: number; readonly matches: boolean };
  readonly dirty: boolean;
}

export interface RegfHiveBin {
  /** File offset of the `hbin` signature. */
  readonly fileOffset: number;
  /** Declared span of the bin, which must be a multiple of 4096. */
  readonly declaredSize: number;
  /** The offset of this bin from the first hive bin, as the bin records it. */
  readonly binOffset: number;
  /** Zero-based ordinal of this bin in file order. */
  readonly index: number;
}

export interface RegfCell {
  /** File offset of the cell's 4-byte size field. */
  readonly fileOffset: number;
  /** Absolute value of the stored size; negative marks an allocated cell. */
  readonly storedSize: number;
  readonly allocated: boolean;
  readonly payloadBytes: number;
}

export interface RegfImage {
  readonly metadata: RegfMetadata;
  readonly header: RegfHeader;
  readonly bins: readonly RegfHiveBin[];
  /** Every cell found in the bins, in file order. */
  readonly cells: readonly RegfCell[];
  readonly limitations: readonly string[];
}

export interface RegfMetadata {
  readonly kind: "regf-hive";
  readonly major_version: number;
  readonly minor_version: number;
  readonly primary_sequence: number;
  readonly secondary_sequence: number;
  readonly dirty: boolean;
  readonly checksum_matches: boolean;
  readonly hive_bin_count: number;
  readonly hive_bins_data_size: number;
  readonly cell_count: number;
  readonly allocated_cell_count: number;
}

const text = (ascii: Uint8Array): string =>
  Buffer.from(ascii).toString("latin1");

/** The stored checksum is the XOR of the first 127 base-block dwords. */
const baseChecksum = (base: Uint8Array): number => {
  const view = new DataView(base.buffer, base.byteOffset, base.byteLength);
  let xor = 0;
  for (let offset = 0; offset < REGF_HEADER.checksum; offset += 4)
    xor ^= view.getUint32(offset, true);
  return xor >>> 0;
};

const failure = (
  message: string,
  boundary?: RegionDecodeFailure["boundary"],
): RegionDecodeFailure => ({
  kind: "format",
  message,
  ...(boundary === undefined ? {} : { boundary }),
});

const limit = (
  message: string,
  boundary?: RegionDecodeFailure["boundary"],
  fileAdmission?: RegionDecodeFailure["fileAdmission"],
): RegionDecodeFailure => ({
  kind: "limit",
  message,
  ...(boundary === undefined ? {} : { boundary }),
  ...(fileAdmission === undefined ? {} : { fileAdmission }),
});

/**
 * Parse the base block, hive bins and cell spans from the admitted bytes.
 *
 * Only structure is established: key nodes, values, transaction logs and any
 * decoding of cell payloads are left to later steps. A bin or cell whose span
 * disagrees with the file is reported as a limitation and parsing stops there,
 * so a malformed tail never yields facts for bytes that were not examined.
 */
export const parseRegfHive = (
  bytes: Uint8Array,
): Result<RegfImage, RegionDecodeFailure> => {
  if (bytes.length < REGF_HEADER_END)
    return err(
      failure(
        `file is ${String(bytes.length)} bytes, shorter than the ${String(REGF_HEADER_END)}-byte base block`,
      ),
    );
  const base = bytes.subarray(0, REGF_HEADER_END);
  if (text(base.subarray(0, 4)) !== REGF_MAGIC)
    return err(failure("base block does not begin with the regf signature"));

  const view = new DataView(base.buffer, base.byteOffset, base.byteLength);
  const primarySequence = view.getUint32(REGF_HEADER.primarySequence, true);
  const secondarySequence = view.getUint32(REGF_HEADER.secondarySequence, true);
  const majorVersion = view.getUint32(REGF_HEADER.majorVersion, true);
  const minorVersion = view.getUint32(REGF_HEADER.minorVersion, true);
  const rootCellOffset = view.getUint32(REGF_HEADER.rootCellOffset, true);
  const hiveBinsDataSize = view.getUint32(REGF_HEADER.hiveBinsDataSize, true);
  const storedChecksum = view.getUint32(REGF_HEADER.checksum, true);
  const computed = baseChecksum(base);

  const header: RegfHeader = {
    primarySequence,
    secondarySequence,
    majorVersion,
    minorVersion,
    rootCellOffset,
    hiveBinsDataSize,
    checksum: { stored: storedChecksum, matches: storedChecksum === computed },
    dirty: primarySequence !== secondarySequence,
  };

  const limitations: string[] = [];
  if (majorVersion !== 1)
    limitations.push(
      `major version ${String(majorVersion)} is not the supported major version 1; later regions are unverified`,
    );
  if (header.dirty)
    limitations.push(
      `primary sequence ${String(primarySequence)} does not match secondary sequence ${String(secondarySequence)}; the hive was not cleanly closed`,
    );
  if (!header.checksum.matches)
    limitations.push(
      `base-block checksum ${String(storedChecksum)} does not match the computed ${String(computed)}`,
    );

  const firstBinOffset = REGF_BASE_BLOCK_BYTES;
  const declaredEnd = firstBinOffset + hiveBinsDataSize;
  const availableEnd = Math.min(declaredEnd, bytes.length);
  if (declaredEnd > bytes.length)
    limitations.push(
      `base block declares ${String(hiveBinsDataSize)} bytes of hive bins, but the file holds only ${String(Math.max(0, bytes.length - firstBinOffset))}`,
    );

  const bins: RegfHiveBin[] = [];
  const cells: RegfCell[] = [];
  let offset = firstBinOffset;
  let binIndex = 0;
  while (offset + REGF_HBIN_ALIGNMENT <= availableEnd) {
    if (text(bytes.subarray(offset, offset + 4)) !== REGF_HBIN_MAGIC) {
      limitations.push(
        `offset ${String(offset)} does not begin with the hbin signature; ${String(bins.length)} bin(s) were examined`,
      );
      break;
    }
    const binView = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset,
      availableEnd - offset,
    );
    const binOffset = binView.getUint32(4, true);
    const declaredSize = binView.getUint32(8, true);
    if (
      declaredSize < REGF_HBIN_ALIGNMENT ||
      declaredSize % REGF_HBIN_ALIGNMENT !== 0 ||
      offset + declaredSize > availableEnd
    ) {
      limitations.push(
        `hive bin at ${String(offset)} declares a span of ${String(declaredSize)} bytes, which does not fit ${String(Math.max(0, availableEnd - offset))} remaining`,
      );
      break;
    }
    bins.push({ fileOffset: offset, declaredSize, binOffset, index: binIndex });

    // A bin's span begins after its `hbin` header; cells fill the rest of the
    // span at 8-byte granularity, and a zero size ends the examined run.
    let cellOffset = offset + 32;
    const binEnd = offset + declaredSize;
    while (cellOffset + REGF_CELL_ALIGNMENT <= binEnd) {
      const size = new DataView(
        bytes.buffer,
        bytes.byteOffset + cellOffset,
        4,
      ).getInt32(0, true);
      if (size === 0) break;
      const magnitude = Math.abs(size);
      if (
        magnitude < REGF_CELL_ALIGNMENT ||
        magnitude % REGF_CELL_ALIGNMENT !== 0
      ) {
        limitations.push(
          `cell at ${String(cellOffset)} declares a size of ${String(size)} bytes, which is not a positive multiple of ${String(REGF_CELL_ALIGNMENT)}`,
        );
        break;
      }
      if (cellOffset + magnitude > binEnd) {
        limitations.push(
          `cell at ${String(cellOffset)} declares a span of ${String(magnitude)} bytes, crossing the hive bin that ends at ${String(binEnd)}`,
        );
        break;
      }
      cells.push({
        fileOffset: cellOffset,
        storedSize: size,
        allocated: size < 0,
        payloadBytes: magnitude - 4,
      });
      cellOffset += magnitude;
    }
    offset = binEnd;
    binIndex += 1;
  }

  if (offset < availableEnd)
    limitations.push(
      `${String(availableEnd - offset)} byte(s) after the last examined hive bin were not parsed`,
    );

  const metadata: RegfMetadata = {
    kind: "regf-hive",
    major_version: majorVersion,
    minor_version: minorVersion,
    primary_sequence: primarySequence,
    secondary_sequence: secondarySequence,
    dirty: header.dirty,
    checksum_matches: header.checksum.matches,
    hive_bin_count: bins.length,
    hive_bins_data_size: hiveBinsDataSize,
    cell_count: cells.length,
    allocated_cell_count: cells.filter((cell) => cell.allocated).length,
  };

  return ok({ metadata, header, bins, cells, limitations });
};

/** Streaming form of the same parse: the whole admitted file is buffered once. */
class StreamingRegfDecoder implements RegionDecoder<RegfImage> {
  readonly #chunks: Uint8Array[] = [];
  #length = 0;

  constructor(readonly fileBytes: number) {}

  write(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    return ok(undefined);
  }

  finish(): Result<RegfImage, RegionDecodeFailure> {
    const bytes = new Uint8Array(this.#length);
    let written = 0;
    for (const chunk of this.#chunks) {
      bytes.set(chunk, written);
      written += chunk.length;
    }
    return parseRegfHive(bytes);
  }
}

export const createRegfDecoder = (
  fileBytes: number,
  admission: RegfHiveFileAdmission = {
    maximumBytes: DEFAULT_REGF_MAX_FILE_BYTES,
    source: "default",
  },
): Result<RegionDecoder<RegfImage>, RegionDecodeFailure> => {
  if (
    Number.isSafeInteger(fileBytes) &&
    fileBytes >= 0 &&
    fileBytes <= admission.maximumBytes
  )
    return ok(new StreamingRegfDecoder(fileBytes));
  const fileLimit = regfHiveFileLimit(fileBytes, admission);
  return err(
    limit(regfHiveFileLimitMessage(fileLimit), "file-size", fileLimit),
  );
};
