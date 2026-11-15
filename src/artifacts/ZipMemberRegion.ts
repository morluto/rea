import { BinaryReader } from "../domain/binaryContainer.js";
import {
  apkSigningPairEnd,
  APK_SIGNING_BLOCK_MAX_PAIRS,
} from "../domain/apkSignature/apkSigningBlock.js";

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
}

const LOCAL_HEADER_BYTES = 30;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
/** The APK Signature Scheme v2+ block sits between the last member and the directory. */
const APK_SIGNING_BLOCK_MAGIC = "APK Sig Block 42";
const APK_SIGNING_BLOCK_FOOTER_BYTES = 24;
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
  let cursor = 0;
  let descriptor: ZipLocalRecord | undefined;
  const gap = async (end: number) => {
    if (end <= cursor) return;
    if (descriptor !== undefined)
      cursor += await dataDescriptorBytes(descriptor, cursor, end, view);
    descriptor = undefined;
    const size = end - cursor;
    if (size <= 0) return;
    unaccountedBytes += size;
    unaccountedRanges += 1;
    firstUnaccountedOffset ??= cursor;
  };
  for (const record of [...records].sort((a, b) => a.offset - b.offset)) {
    if (record.offset + LOCAL_HEADER_BYTES > directoryOffset) {
      unlocatedHeaders += 1;
      continue;
    }
    const header = await view(record.offset, LOCAL_HEADER_BYTES);
    if (header.u32(0) !== LOCAL_HEADER_SIGNATURE) {
      unlocatedHeaders += 1;
      continue;
    }
    await gap(record.offset);
    const end =
      record.offset +
      LOCAL_HEADER_BYTES +
      header.u16(26) +
      header.u16(28) +
      record.compressedSize;
    // Overlapping records are refused when their data is read.
    if (end > cursor) {
      cursor = end;
      descriptor = record.dataDescriptor ? record : undefined;
    }
  }
  await gap(await apkSigningBlockStart(cursor, directoryOffset, view));
  return {
    unaccountedBytes,
    unaccountedRanges,
    firstUnaccountedOffset,
    unlocatedHeaders,
  };
};

/**
 * The bytes of the record's data descriptor at `at`, or 0 when none matches.
 * The descriptor signature is optional and an unsigned descriptor's CRC may
 * equal it, so both layouts are tried against the recorded CRC and sizes.
 * An entry whose directory reports no CRC (zip.js omits it for AES entries,
 * whose AE-2 CRC is zero) is matched on its sizes alone.
 */
const dataDescriptorBytes = async (
  record: ZipLocalRecord,
  at: number,
  end: number,
  view: (offset: number, length: number) => Promise<BinaryReader>,
): Promise<number> => {
  const body = record.zip64 ? 20 : 12;
  const signed =
    end - at >= body + 4 &&
    (await view(at, 4)).u32(0) === DATA_DESCRIPTOR_SIGNATURE;
  for (const prefix of signed ? [4, 0] : [0]) {
    if (end - at < prefix + body) continue;
    const data = await view(at + prefix, body);
    const compressed = record.zip64 ? data.word(4, 64) : BigInt(data.u32(4));
    const uncompressed = record.zip64 ? data.word(12, 64) : BigInt(data.u32(8));
    if (
      (record.crc32 === undefined || data.u32(0) === record.crc32) &&
      compressed === BigInt(record.compressedSize) &&
      uncompressed === BigInt(record.uncompressedSize)
    )
      return prefix + body;
  }
  return 0;
};

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
  const magic = new TextDecoder("latin1").decode(
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
