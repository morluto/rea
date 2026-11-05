import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  type FileEntry,
} from "@zip.js/zip.js";

import {
  decodeZipEntryText,
  ZIP_READER_OPTIONS,
  zipEntryPath,
} from "../../artifacts/ZipArtifactReader.js";
import {
  DAMAGED_ZIP_ENTRY,
  MAX_ZIP_ENTRIES,
  UNREADABLE_ZIP,
  unreadZipEntry,
  zipEntry,
  zipEntryRefusal,
  zipView,
  type ZipEntryHeader,
} from "../../domain/desktop/zipView.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";

/** An entry's view, its bytes checked against its CRC-32 and declared size, which bounds them. */
const readEntry = async (
  entry: FileEntry,
  header: ZipEntryHeader,
  signal: AbortSignal | undefined,
): Promise<JsonValue> => {
  let bytes: Uint8Array;
  try {
    bytes = await entry.getData(new Uint8ArrayWriter(), {
      checkSignature: true,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    signal?.throwIfAborted();
    return unreadZipEntry(header, DAMAGED_ZIP_ENTRY);
  }
  return zipEntry(header, bytes);
};

/**
 * A zip archive's view, read from the digest-checked bytes in memory rather
 * than reopened from disk: file entries in archive order up to the listing
 * limit, each read by the state view's own readers within the entry and
 * archive budgets. Nothing is extracted and no archive inside is opened.
 */
export const readZipView = async (
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<Result<JsonValue, string>> => {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), ZIP_READER_OPTIONS);
  const entries: JsonValue[] = [];
  let count = 0;
  let spent = 0;
  try {
    for await (const entry of reader.getEntriesGenerator({
      decodeText: decodeZipEntryText,
    })) {
      signal?.throwIfAborted();
      const name = zipEntryPath(entry);
      if (entry.directory || name.endsWith("/")) continue;
      count += 1;
      if (entries.length >= MAX_ZIP_ENTRIES) continue;
      const header: ZipEntryHeader = {
        name,
        size: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        method: entry.compressionMethod,
        encrypted: entry.encrypted,
      };
      const refusal = zipEntryRefusal(header, spent);
      if (refusal === undefined) spent += header.size;
      entries.push(
        refusal === undefined
          ? await readEntry(entry, header, signal)
          : unreadZipEntry(header, refusal),
      );
    }
  } catch {
    signal?.throwIfAborted();
    return err(UNREADABLE_ZIP);
  } finally {
    await reader.close();
  }
  return ok(zipView(entries, count));
};
