import { BinaryReader } from "../binaryContainer.js";
import { ZIP_EXTRA_FIELD } from "./zipExtraFields.js";
import {
  ZIP_LOCAL_HEADER_BYTES,
  zipLocalDataOffset,
} from "./zipLocalHeader.js";
import {
  apkSigningPairEnd,
  APK_SIGNING_BLOCK_MAX_PAIRS,
} from "../apkSignature/apkSigningBlock.js";

/** One central-directory record's claim on the member region before the directory. */
export interface ZipLocalRecord {
  /** Offset of the record's local file header. */
  readonly offset: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** Undefined when the directory reader reports none, as for AES entries. */
  readonly crc32: number | undefined;
  readonly zip64: boolean;
  /** The general-purpose flag that places a data descriptor after the data. */
  readonly dataDescriptor: boolean;
}

/** What the central directory's records leave unexplained before the directory. */
export interface ZipMemberRegionAccount {
  readonly unaccountedBytes: number;
  readonly unaccountedRanges: number;
  readonly firstUnaccountedOffset: number | undefined;
  /** Records whose local file header could not be located. */
  readonly unlocatedHeaders: number;
  /** Extents not corroborated by their local header or required descriptor. */
  readonly unverifiedExtents: number;
}

const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const DATA_DESCRIPTOR_FLAG = 0x8;
const ZIP64_SIZE_SENTINEL = 0xffffffff;
/** The APK Signature Scheme v2+ block sits between the last member and the directory. */
const APK_SIGNING_BLOCK_MAGIC = "APK Sig Block 42";
const APK_SIGNING_BLOCK_FOOTER_BYTES = 24;
/**
 * apksigner zero-pads the member region so the signing block starts on a
 * 4 KiB boundary (Android source, ApkSigningBlockUtils `ANDROID_COMMON_PAGE_ALIGNMENT_BYTES`).
 */
const APK_SIGNING_BLOCK_ALIGNMENT_BYTES = 4096;
/** Adjacent small members share one read; a large member costs one read. */
const READ_WINDOW_BYTES = 64 * 1024;

/**
 * Account for every byte before the central directory with the local records
 * the directory lists. Unaccounted bytes may hold local entries the central
 * directory omits, so a listing built from it cannot claim them.
 */
export const accountZipMemberRegion = async (
  records: readonly ZipLocalRecord[],
  directoryOffset: number,
  read: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<ZipMemberRegionAccount> => {
  let window:
    | { readonly start: number; readonly bytes: Uint8Array }
    | undefined;
  const view = async (offset: number, length: number) => {
    if (
      window === undefined ||
      offset < window.start ||
      offset + length > window.start + window.bytes.length
    )
      window = {
        start: offset,
        bytes: await read(
          offset,
          Math.max(
            length,
            Math.min(READ_WINDOW_BYTES, directoryOffset - offset),
          ),
        ),
      };
    const at = offset - window.start;
    return new BinaryReader(
      Buffer.from(window.bytes.buffer, window.bytes.byteOffset + at, length),
      true,
      "zip",
    );
  };
  let unaccountedBytes = 0;
  let unaccountedRanges = 0;
  let firstUnaccountedOffset: number | undefined;
  let unlocatedHeaders = 0;
  let unverifiedExtents = 0;
  let localSizeOffset: number | undefined;
  let localSize: bigint | undefined;
  // Distinct well-formed local headers have disjoint extra fields. Bound the
  // field-walk work even when malformed references overlap those source bytes.
  let localExtraBytesRemaining = directoryOffset;
  const localExtra = async (offset: number, length: number) => {
    if (length > localExtraBytesRemaining) return undefined;
    localExtraBytesRemaining -= length;
    return view(offset, length);
  };
  // Contained payloads can end far from their headers. Exact descriptor reads
  // leave the header window intact instead of reloading it for every alias.
  const descriptorView = async (offset: number, length: number) =>
    new BinaryReader(Buffer.from(await read(offset, length)), true, "zip");
  let cursor = 0;
  let descriptor: ZipLocalRecord | undefined;
  const gap = async (end: number, signingBlockPadding = false) => {
    if (end < cursor) return;
    if (descriptor !== undefined) {
      const at = cursor;
      const bytes = await dataDescriptorBytes(
        descriptor,
        at,
        end,
        view,
        // A layout followed only by signing-block padding also ends the gap.
        signingBlockPadding
          ? (bytes) => isSigningBlockPadding(at + bytes, end, view)
          : undefined,
      );
      if (bytes === 0) unverifiedExtents += 1;
      cursor += bytes;
    }
    descriptor = undefined;
    const size = end - cursor;
    if (size <= 0) return;
    if (signingBlockPadding && (await isSigningBlockPadding(cursor, end, view)))
      return;
    unaccountedBytes += size;
    unaccountedRanges += 1;
    firstUnaccountedOffset ??= cursor;
  };
  for (const record of [...records].sort((a, b) => a.offset - b.offset)) {
    if (record.offset + ZIP_LOCAL_HEADER_BYTES > directoryOffset) {
      unlocatedHeaders += 1;
      continue;
    }
    const header = await view(record.offset, ZIP_LOCAL_HEADER_BYTES);
    const dataOffset = zipLocalDataOffset(header, record.offset);
    if (dataOffset === undefined) {
      unlocatedHeaders += 1;
      continue;
    }
    const end = dataOffset + record.compressedSize;
    const deferred = (header.u16(6) & DATA_DESCRIPTOR_FLAG) !== 0;
    // A directory/encrypted entry may never be opened. Do not let an unchecked
    // central size cover other local records or bytes beyond the member region.
    if (end > directoryOffset || deferred !== record.dataDescriptor) {
      unverifiedExtents += 1;
      continue;
    }
    if (!deferred) {
      // Records are sorted by offset; repeated references share one immutable
      // local header and must not repeatedly walk or charge its extra field.
      if (localSizeOffset !== record.offset) {
        localSize = await localCompressedSize(header, dataOffset, localExtra);
        localSizeOffset = record.offset;
      }
      if (localSize !== BigInt(record.compressedSize)) {
        unverifiedExtents += 1;
        continue;
      }
    }
    await gap(record.offset);
    // Overlapping records are refused when their data is read.
    if (end > cursor) {
      if (descriptor !== undefined) unverifiedExtents += 1;
      cursor = end;
      descriptor = record.dataDescriptor ? record : undefined;
    } else if (
      deferred &&
      (await dataDescriptorBytes(
        record,
        end,
        directoryOffset,
        descriptorView,
      )) === 0
    )
      unverifiedExtents += 1;
  }
  const signingBlock = await apkSigningBlockStart(
    cursor,
    directoryOffset,
    view,
  );
  await gap(signingBlock, signingBlock !== directoryOffset);
  return {
    unaccountedBytes,
    unaccountedRanges,
    firstUnaccountedOffset,
    unlocatedHeaders,
    unverifiedExtents,
  };
};

/** The local compressed size, including its conditional Zip64 extra-field slot. */
const localCompressedSize = async (
  header: BinaryReader,
  dataOffset: number,
  view: (offset: number, length: number) => Promise<BinaryReader | undefined>,
): Promise<bigint | undefined> => {
  const size = header.u32(18);
  if (size !== ZIP64_SIZE_SENTINEL) return BigInt(size);
  const length = header.u16(28);
  if (length === 0) return undefined;
  const extra = await view(dataOffset - length, length);
  if (extra === undefined) return undefined;
  let size64: bigint | undefined;
  for (let at = 0; at + 4 <= length;) {
    const bytes = extra.u16(at + 2);
    const next = at + 4 + bytes;
    if (extra.u16(at) === ZIP_EXTRA_FIELD.zip64) {
      // Fields are present only for their corresponding 32-bit sentinel.
      const compressedAt =
        at + 4 + (header.u32(22) === ZIP64_SIZE_SENTINEL ? 8 : 0);
      size64 =
        next <= length && compressedAt + 8 <= next
          ? extra.word(compressedAt, 64)
          : undefined;
    }
    at = next;
  }
  return size64;
};

/**
 * The bytes of the record's data descriptor at `at`, or 0 when none matches.
 * The descriptor signature is optional and an unsigned descriptor's CRC may
 * equal it, so both layouts are tried against the recorded CRC and sizes.
 * An entry whose directory reports no CRC (zip.js omits it for AES entries,
 * whose AE-2 CRC is zero) is matched on its sizes alone.
 * Both size widths are tried, the record's own first: MSIX and APPX packages
 * write 8-byte descriptor sizes without a ZIP64 extra field. Zero sizes match
 * a narrow prefix of a wide descriptor too, so a layout that ends exactly at
 * `end`, the next accounted byte, or that `accounts` for the rest of the
 * range, wins over the first match.
 */
const dataDescriptorBytes = async (
  record: ZipLocalRecord,
  at: number,
  end: number,
  view: (offset: number, length: number) => Promise<BinaryReader>,
  accounts?: (bytes: number) => Promise<boolean>,
): Promise<number> => {
  const signed =
    end - at >= 16 && (await view(at, 4)).u32(0) === DATA_DESCRIPTOR_SIGNATURE;
  let first = 0;
  for (const wide of record.zip64 ? [true, false] : [false, true]) {
    const body = wide ? 20 : 12;
    for (const prefix of signed ? [4, 0] : [0]) {
      if (end - at < prefix + body) continue;
      const data = await view(at + prefix, body);
      const compressed = wide ? data.word(4, 64) : BigInt(data.u32(4));
      const uncompressed = wide ? data.word(12, 64) : BigInt(data.u32(8));
      if (
        (record.crc32 === undefined || data.u32(0) === record.crc32) &&
        compressed === BigInt(record.compressedSize) &&
        uncompressed === BigInt(record.uncompressedSize)
      ) {
        if (
          at + prefix + body === end ||
          (accounts !== undefined && (await accounts(prefix + body)))
        )
          return prefix + body;
        if (first === 0) first = prefix + body;
      }
    }
  }
  return first;
};

const LATIN1_DECODER = new TextDecoder("latin1");

/**
 * Whether `start..end` is apksigner's alignment pad before a signing block at
 * `end`. A local file header needs its signature, so all-zero bytes cannot
 * hold an unlisted entry.
 */
const isSigningBlockPadding = async (
  start: number,
  end: number,
  view: (offset: number, length: number) => Promise<BinaryReader>,
): Promise<boolean> =>
  end - start < APK_SIGNING_BLOCK_ALIGNMENT_BYTES &&
  end % APK_SIGNING_BLOCK_ALIGNMENT_BYTES === 0 &&
  (await view(start, end - start))
    .range(0, end - start, "APK signing block padding")
    .every((byte) => byte === 0);

/** Where a well-formed APK signing block ending at the directory starts, else the directory. */
const apkSigningBlockStart = async (
  cursor: number,
  directoryOffset: number,
  view: (offset: number, length: number) => Promise<BinaryReader>,
): Promise<number> => {
  if (directoryOffset - cursor < APK_SIGNING_BLOCK_FOOTER_BYTES + 8)
    return directoryOffset;
  const footer = await view(
    directoryOffset - APK_SIGNING_BLOCK_FOOTER_BYTES,
    APK_SIGNING_BLOCK_FOOTER_BYTES,
  );
  const magic = LATIN1_DECODER.decode(
    footer.range(8, 16, "APK signing block magic"),
  );
  if (magic !== APK_SIGNING_BLOCK_MAGIC) return directoryOffset;
  const size = footer.word(0, 64);
  if (size < 24n) return directoryOffset;
  const start = BigInt(directoryOffset) - size - 8n;
  if (start < BigInt(cursor)) return directoryOffset;
  const header = await view(Number(start), 8);
  if (header.word(0, 64) !== size) return directoryOffset;
  let offset = Number(start) + 8;
  const pairsEnd = directoryOffset - APK_SIGNING_BLOCK_FOOTER_BYTES;
  let count = 0;
  while (offset < pairsEnd) {
    if (pairsEnd - offset < 8 || count++ >= APK_SIGNING_BLOCK_MAX_PAIRS)
      return directoryOffset;
    const length = (await view(offset, 8)).word(0, 64);
    const next = apkSigningPairEnd(length, offset, pairsEnd);
    if (next === undefined) return directoryOffset;
    offset = next;
  }
  return Number(start);
};
