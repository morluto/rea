/** One central-directory record's claim on the member region before the directory. */
export interface ZipLocalRecord {
  /** Offset of the record's local file header. */
  readonly offset: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
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
    return new DataView(
      window.bytes.buffer,
      window.bytes.byteOffset + offset - window.start,
      length,
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
    if (
      descriptor !== undefined &&
      descriptor.crc32 !== undefined &&
      end - cursor >= 12
    ) {
      const signature =
        (await view(cursor, 4)).getUint32(0, true) ===
        DATA_DESCRIPTOR_SIGNATURE;
      const size = (descriptor.zip64 ? 20 : 12) + (signature ? 4 : 0);
      if (end - cursor >= size) {
        const data = await view(cursor, size);
        const start = signature ? 4 : 0;
        const compressed = descriptor.zip64
          ? data.getBigUint64(start + 4, true)
          : BigInt(data.getUint32(start + 4, true));
        const uncompressed = descriptor.zip64
          ? data.getBigUint64(start + 12, true)
          : BigInt(data.getUint32(start + 8, true));
        if (
          data.getUint32(start, true) === descriptor.crc32 &&
          compressed === BigInt(descriptor.compressedSize) &&
          uncompressed === BigInt(descriptor.uncompressedSize)
        )
          cursor += size;
      }
    }
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
    if (header.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) {
      unlocatedHeaders += 1;
      continue;
    }
    await gap(record.offset);
    const end =
      record.offset +
      LOCAL_HEADER_BYTES +
      header.getUint16(26, true) +
      header.getUint16(28, true) +
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

/** Where a well-formed APK signing block ending at the directory starts, else the directory. */
const apkSigningBlockStart = async (
  cursor: number,
  directoryOffset: number,
  view: (offset: number, length: number) => Promise<DataView>,
): Promise<number> => {
  if (directoryOffset - cursor < APK_SIGNING_BLOCK_FOOTER_BYTES + 8)
    return directoryOffset;
  const footer = await view(
    directoryOffset - APK_SIGNING_BLOCK_FOOTER_BYTES,
    APK_SIGNING_BLOCK_FOOTER_BYTES,
  );
  const magic = new TextDecoder("latin1").decode(
    new Uint8Array(footer.buffer, footer.byteOffset + 8, 16),
  );
  if (magic !== APK_SIGNING_BLOCK_MAGIC) return directoryOffset;
  const size = footer.getBigUint64(0, true);
  if (size < 24n) return directoryOffset;
  const start = BigInt(directoryOffset) - size - 8n;
  if (start < BigInt(cursor)) return directoryOffset;
  const header = await view(Number(start), 8);
  if (header.getBigUint64(0, true) !== size) return directoryOffset;
  let offset = Number(start) + 8;
  const pairsEnd = directoryOffset - APK_SIGNING_BLOCK_FOOTER_BYTES;
  let count = 0;
  while (offset < pairsEnd) {
    if (pairsEnd - offset < 8 || count++ >= APK_SIGNING_BLOCK_MAX_PAIRS)
      return directoryOffset;
    const length = (await view(offset, 8)).getBigUint64(0, true);
    const next = apkSigningPairEnd(length, offset, pairsEnd);
    if (next === undefined) return directoryOffset;
    offset = next;
  }
  return Number(start);
};
import {
  apkSigningPairEnd,
  APK_SIGNING_BLOCK_MAX_PAIRS,
} from "../domain/apkSignature/apkSigningBlock.js";
