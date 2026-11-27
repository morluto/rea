import type {
  BfltMetadata,
  BfltSegmentMetadata,
} from "./formatMetadata/firmwareMetadata.js";
import { artifactExpansionBudgetBytes } from "./artifactExpansionBudget.js";
import { gunzip } from "./desktop/gzipDocument.js";
import { err, ok, type Result } from "./result.js";
import type {
  RegionDecodeFailure,
  RegionDecoder,
} from "./firmware/regionDecoder.js";

/**
 * uClinux flat executable header (`include/uapi/linux/flat.h` and elf2flt's
 * `flat.h`): 64 bytes, every field big-endian, every offset measured from the
 * start of the file as the loader sees it, header included.
 */
export const BFLT_HEADER_SIZE = 64;
const BFLT_MAGIC = [0x62, 0x46, 0x4c, 0x54];
/** OLD_FLAT_VERSION and FLAT_VERSION. */
const OLD_FLAT_VERSION = 2;
const KNOWN_REVISIONS = new Set([OLD_FLAT_VERSION, 4]);
const RELOCATION_BYTES = 4;

const FLAG_NAMES: readonly (readonly [number, string])[] = [
  [0x01, "ram"],
  [0x02, "gotpic"],
  [0x04, "gzip"],
  [0x08, "gzdata"],
  [0x10, "ktrace"],
  [0x20, "l1stk"],
];
const KNOWN_FLAGS = FLAG_NAMES.reduce((mask, [bit]) => mask | bit, 0);
const FLAG_GZIP = 0x04;
const FLAG_GZDATA = 0x08;

/**
 * Fixed whole-file ceiling, as for DfuSe and Intel HEX; configurable
 * ceilings are tracked in #6176. The decoder holds the file once.
 */
export const BFLT_MAX_FILE_BYTES = 128 * 1024 * 1024;
/**
 * Fixed in-memory ceiling for inflating a gzip or gzdata body. Keeps
 * synchronous working memory bounded even when the aggregate
 * `artifact_limits.expanded_bytes` budget is larger (such as the 500x default
 * on a multi-megabyte file); bodies past this ceiling fall back to exposing
 * `compressed-body.gz`.
 */
export const BFLT_MAX_INFLATED_BYTES = 128 * 1024 * 1024;
/**
 * Relocation offsets listed inline in the header metadata. This is a delivery
 * budget, not an admission limit: every entry is still bounds-checked and the
 * complete table is extractable as relocations.bin.
 */
export const BFLT_LISTED_RELOCATIONS = 64;

export interface BfltSegment {
  readonly path: string;
  /** The file offset when the bytes are stored uncompressed, otherwise null. */
  readonly fileOffset: number | null;
  readonly metadata: BfltSegmentMetadata;
  readonly bytes: Uint8Array;
}

export interface BfltExecutable {
  readonly metadata: BfltMetadata;
  readonly segments: readonly BfltSegment[];
  readonly limitations: readonly string[];
  /** False when a header range or the compressed body could not be served. */
  readonly complete: boolean;
}

/** Whether the leading bytes carry the `bFLT` magic. */
export const hasBfltMagic = (prefix: Uint8Array): boolean =>
  BFLT_MAGIC.every((byte, index) => prefix[index] === byte);

const u32 = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)) >>>
  0;

const hex = (value: number): string => `0x${value.toString(16)}`;

/**
 * Start a decoder that retains the admitted file and parses it on finish.
 * `expandedBytes` is the caller's `artifact_limits.expanded_bytes`; when it is
 * omitted, the shared expansion budget for this file size applies.
 */
export const createBfltDecoder = (
  fileBytes: number,
  expandedBytes?: number,
): Result<RegionDecoder<BfltExecutable>, RegionDecodeFailure> =>
  Number.isSafeInteger(fileBytes) &&
  fileBytes >= 0 &&
  fileBytes <= BFLT_MAX_FILE_BYTES
    ? ok(
        new RetainingBfltDecoder(
          fileBytes,
          expandedBytes ?? artifactExpansionBudgetBytes(fileBytes),
        ),
      )
    : err({
        kind: "limit",
        boundary: "file-size",
        message: `file is ${String(fileBytes)} bytes, exceeding the fixed ${String(BFLT_MAX_FILE_BYTES)}-byte (128 MiB) ceiling`,
      });

class RetainingBfltDecoder implements RegionDecoder<BfltExecutable> {
  readonly #bytes: Uint8Array;
  readonly #expandedBytes: number;
  #length = 0;

  constructor(fileBytes: number, expandedBytes: number) {
    this.#bytes = new Uint8Array(fileBytes);
    this.#expandedBytes = expandedBytes;
  }

  write(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    if (this.#length + chunk.length > this.#bytes.length)
      return err({
        kind: "limit",
        boundary: "file-size",
        message: "file grew beyond its admitted size while being read",
      });
    this.#bytes.set(chunk, this.#length);
    this.#length += chunk.length;
    return ok(undefined);
  }

  finish(): Result<BfltExecutable, RegionDecodeFailure> {
    return parseBflt(
      this.#bytes.subarray(0, this.#length),
      this.#expandedBytes,
    );
  }
}

/** The loader's view of the file: stored bytes, then any inflated body. */
interface LoaderImage {
  readonly length: number;
  range(from: number, to: number): Uint8Array;
}

const storedImage = (bytes: Uint8Array): LoaderImage => ({
  length: bytes.length,
  range: (from, to) => bytes.subarray(from, to),
});

/**
 * Serve the stored prefix and the inflated body as one image without joining
 * them. Only a range that spans both, such as gzip text with its header, is
 * copied.
 */
const inflatedImage = (
  bytes: Uint8Array,
  compressedFrom: number,
  inflated: Uint8Array,
): LoaderImage => ({
  length: compressedFrom + inflated.length,
  range: (from, to) => {
    if (to <= compressedFrom) return bytes.subarray(from, to);
    if (from >= compressedFrom)
      return inflated.subarray(from - compressedFrom, to - compressedFrom);
    const joined = new Uint8Array(to - from);
    joined.set(bytes.subarray(from, compressedFrom), 0);
    joined.set(
      inflated.subarray(0, to - compressedFrom),
      compressedFrom - from,
    );
    return joined;
  },
});

interface Inflation {
  readonly image: LoaderImage | null;
  readonly inflatedBytes: number | null;
  readonly limitation?: string;
}

/**
 * Inflate the gzip body under the stricter of the caller's expansion budget
 * and the fixed in-memory inflation ceiling.
 */
const inflateBody = (
  bytes: Uint8Array,
  compressedFrom: number,
  expandedBytes: number,
  maxInflatedBytes: number,
): Inflation => {
  if (compressedFrom < BFLT_HEADER_SIZE)
    return {
      image: null,
      inflatedBytes: null,
      limitation: `The compressed body is declared to start at byte ${String(compressedFrom)}, inside the ${String(BFLT_HEADER_SIZE)}-byte header; it was not inflated.`,
    };
  if (compressedFrom > bytes.length)
    return {
      image: null,
      inflatedBytes: null,
      limitation: `The compressed body is declared to start at byte ${String(compressedFrom)}, past the ${String(bytes.length)}-byte file; it was not inflated.`,
    };
  const callerBound = expandedBytes < maxInflatedBytes;
  const effectiveLimit = Math.max(
    0,
    callerBound ? expandedBytes : maxInflatedBytes,
  );
  const inflated = gunzip(bytes.subarray(compressedFrom), effectiveLimit);
  if (inflated.ok)
    return {
      image: inflatedImage(bytes, compressedFrom, inflated.value),
      inflatedBytes: inflated.value.length,
    };
  return {
    image: null,
    inflatedBytes: null,
    limitation:
      inflated.error === "too_large"
        ? callerBound
          ? `The gzip body inflates past the ${String(effectiveLimit)}-byte artifact_limits.expanded_bytes budget; only the stored compressed bytes are exposed. Raise artifact_limits.expanded_bytes (up to ${String(maxInflatedBytes)} bytes) to inflate it.`
          : `The gzip body inflates past the fixed ${String(maxInflatedBytes)}-byte in-memory inflation ceiling; only the stored compressed bytes are exposed. Extract compressed-body.gz to decompress it externally.`
        : "The gzip body is not a readable gzip stream; only the stored compressed bytes are exposed.",
  };
};

/**
 * Parse a bFLT file. Only a missing magic or a truncated header refuses the
 * file; inconsistent offsets, unknown revisions and an uninflatable body are
 * reported as limitations beside whatever the header still establishes.
 */
export const parseBflt = (
  bytes: Uint8Array,
  expandedBytes = artifactExpansionBudgetBytes(bytes.length),
  maxInflatedBytes = BFLT_MAX_INFLATED_BYTES,
): Result<BfltExecutable, RegionDecodeFailure> => {
  if (bytes.length < BFLT_HEADER_SIZE || !hasBfltMagic(bytes))
    return err({
      kind: "malformed",
      message:
        bytes.length < BFLT_HEADER_SIZE
          ? `bFLT header is truncated: ${String(bytes.length)} bytes, expected ${String(BFLT_HEADER_SIZE)}`
          : "the file does not begin with the bFLT magic",
    });
  const revision = u32(bytes, 4);
  const entry = u32(bytes, 8);
  const dataStart = u32(bytes, 12);
  const dataEnd = u32(bytes, 16);
  const bssEnd = u32(bytes, 20);
  const stackSize = u32(bytes, 24);
  const relocStart = u32(bytes, 28);
  const relocCount = u32(bytes, 32);
  const flags = u32(bytes, 36);
  const buildDate = u32(bytes, 40);
  const limitations: string[] = [];
  let complete = true;

  if (!KNOWN_REVISIONS.has(revision))
    limitations.push(
      `Revision ${String(revision)} is not a known bFLT revision (2 or 4); header fields are reported using the revision 4 layout.`,
    );
  const oldFormat = revision === OLD_FLAT_VERSION;
  if (oldFormat)
    limitations.push(
      "Revision 2 loaders ignore the stored flags, so the body is read as stored. Old-format relocation entries pack a segment type beside an offset whose bit order and base segment depend on the target CPU; entries are listed as stored and not range-checked.",
    );
  const unknownFlags = (flags & ~KNOWN_FLAGS) >>> 0;
  if (unknownFlags !== 0)
    limitations.push(
      `Flag bits ${hex(unknownFlags)} are not defined by flat.h; they are reported in unknown_flags.`,
    );

  const compression = oldFormat
    ? "none"
    : (flags & FLAG_GZIP) !== 0
      ? "gzip"
      : (flags & FLAG_GZDATA) !== 0
        ? "gzdata"
        : "none";
  const compressedFrom =
    compression === "gzip"
      ? BFLT_HEADER_SIZE
      : compression === "gzdata"
        ? dataStart
        : undefined;
  let image: LoaderImage | null = storedImage(bytes);
  let inflatedBytes: number | null = null;
  if (compressedFrom !== undefined) {
    const inflation = inflateBody(
      bytes,
      compressedFrom,
      expandedBytes,
      maxInflatedBytes,
    );
    image = inflation.image;
    inflatedBytes = inflation.inflatedBytes;
    if (inflation.limitation !== undefined) {
      limitations.push(inflation.limitation);
      complete = false;
    }
  }

  const segmentsConsistent =
    dataStart >= BFLT_HEADER_SIZE && dataEnd >= dataStart;
  if (!segmentsConsistent) {
    limitations.push(
      `Header segment offsets are inconsistent: data_start ${hex(dataStart)} and data_end ${hex(dataEnd)} must satisfy ${hex(BFLT_HEADER_SIZE)} <= data_start <= data_end; text and data are not served.`,
    );
    complete = false;
  }
  if (bssEnd < dataEnd)
    limitations.push(
      `bss_end ${hex(bssEnd)} precedes data_end ${hex(dataEnd)}; the bss size is unknown.`,
    );
  if (segmentsConsistent && (entry < BFLT_HEADER_SIZE || entry >= dataStart))
    limitations.push(
      `The entry point ${hex(entry)} lies outside the text segment [${hex(BFLT_HEADER_SIZE)}, ${hex(dataStart)}).`,
    );

  const segments: BfltSegment[] = [];
  const addSegment = (
    segment: "text" | "data" | "relocations",
    path: string,
    from: number,
    to: number,
  ): void => {
    if (image === null || to <= from) return;
    segments.push({
      path,
      // Bytes at or past the compressed start exist only after inflation.
      fileOffset:
        compressedFrom === undefined || to <= compressedFrom ? from : null,
      metadata: {
        kind: "bflt-segment",
        segment,
        image_offset: from,
        length: to - from,
      },
      bytes: image.range(from, to),
    });
  };

  if (image !== null && segmentsConsistent) {
    if (dataEnd > image.length) {
      limitations.push(
        `The data segment ends at ${hex(dataEnd)}, past the ${String(image.length)}-byte ${compressedFrom === undefined ? "file" : "inflated image"}; text and data are not served.`,
      );
      complete = false;
    } else {
      addSegment("text", "text.bin", 0, dataStart);
      addSegment("data", "data.bin", dataStart, dataEnd);
    }
  }
  if (image === null && compressedFrom !== undefined) {
    if (
      compression === "gzdata" &&
      segmentsConsistent &&
      dataStart <= bytes.length
    )
      segments.push({
        path: "text.bin",
        fileOffset: 0,
        metadata: {
          kind: "bflt-segment",
          segment: "text",
          image_offset: 0,
          length: dataStart,
        },
        bytes: bytes.subarray(0, dataStart),
      });
    if (compressedFrom >= BFLT_HEADER_SIZE && compressedFrom < bytes.length)
      segments.push({
        path: "compressed-body.gz",
        fileOffset: compressedFrom,
        metadata: {
          kind: "bflt-segment",
          segment: "compressed-body",
          image_offset: null,
          length: bytes.length - compressedFrom,
        },
        bytes: bytes.subarray(compressedFrom),
      });
  }

  // Revision 4 entries are offsets from the first byte after the header
  // (start_code). calc_reloc accepts an entry through start_brk, the end of
  // bss. text_len there excludes the header, so the bound is bss_end minus
  // the header size, and only when those lengths do not wrap. Revision 2
  // entries cannot be decoded without the target CPU, so they stay unchecked.
  const relocLimit =
    !oldFormat &&
    dataStart >= BFLT_HEADER_SIZE &&
    dataEnd >= dataStart &&
    bssEnd >= dataEnd
      ? bssEnd - BFLT_HEADER_SIZE
      : null;
  const relocations: number[] = [];
  let outOfRange: number | null = null;
  const relocEnd = relocStart + relocCount * RELOCATION_BYTES;
  if (image !== null && relocCount > 0) {
    if (relocEnd > image.length) {
      limitations.push(
        `The relocation table [${hex(relocStart)}, ${hex(relocEnd)}) runs past the ${String(image.length)}-byte ${compressedFrom === undefined ? "file" : "inflated image"}; relocations are not listed.`,
      );
      complete = false;
    } else {
      const table = image.range(relocStart, relocEnd);
      outOfRange = relocLimit === null ? null : 0;
      for (let index = 0; index < relocCount; index += 1) {
        const value = u32(table, index * RELOCATION_BYTES);
        if (index < BFLT_LISTED_RELOCATIONS) relocations.push(value);
        if (outOfRange !== null && relocLimit !== null && value > relocLimit)
          outOfRange += 1;
      }
      addSegment("relocations", "relocations.bin", relocStart, relocEnd);
      if (outOfRange !== null && relocLimit !== null && outOfRange > 0)
        limitations.push(
          `${String(outOfRange)} of ${String(relocCount)} relocation entries point past the end of bss (offset ${hex(relocLimit)} from the byte after the header).`,
        );
    }
  } else if (relocCount === 0 && !oldFormat) {
    outOfRange = 0;
  }
  const tableRead = image !== null && relocEnd <= image.length;
  const truncated = relocations.length < relocCount && tableRead;
  if (truncated)
    limitations.push(
      `${String(relocCount)} relocations are present; the first ${String(BFLT_LISTED_RELOCATIONS)} are listed inline and relocations.bin holds the complete table.`,
    );

  return ok({
    metadata: {
      kind: "bflt",
      revision,
      entry,
      data_start: dataStart,
      data_end: dataEnd,
      bss_end: bssEnd,
      stack_size: stackSize,
      reloc_start: relocStart,
      reloc_count: relocCount,
      flags,
      flag_names: FLAG_NAMES.filter(([bit]) => (flags & bit) !== 0).map(
        ([, name]) => name,
      ),
      unknown_flags: unknownFlags,
      // Revision 2 headers end in padding where revision 4 keeps build_date.
      build_date: oldFormat || buildDate === 0 ? null : buildDate,
      build_date_iso:
        oldFormat || buildDate === 0
          ? null
          : new Date(buildDate * 1000).toISOString(),
      compression,
      text_size: segmentsConsistent ? dataStart : null,
      data_size: segmentsConsistent ? dataEnd - dataStart : null,
      bss_size: bssEnd >= dataEnd ? bssEnd - dataEnd : null,
      inflated_bytes: inflatedBytes,
      relocations,
      relocations_truncated: truncated,
      out_of_range_relocation_count: outOfRange,
    },
    segments,
    limitations,
    complete,
  });
};
