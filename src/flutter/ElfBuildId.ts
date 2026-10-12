import type { FileHandle } from "node:fs/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  readElfHeader,
  ELF_HEADER_MAX_BYTES,
  type ElfParseFailure,
} from "./DartElf.js";

const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_BUILD_IDS = 64;

export interface ElfBuildIds {
  readonly candidates: readonly string[];
  readonly failures: readonly ElfParseFailure[];
}

/** Read only ELF-declared PT_NOTE/SHT_NOTE ranges from one owned engine image. */
export const readElfBuildIds = async (
  file: FileHandle,
  totalBytes: number,
  signal: AbortSignal | undefined,
): Promise<ElfBuildIds> => {
  const candidates = new Set<string>();
  const failure = (reason: string): ElfBuildIds => ({
    candidates: [...candidates],
    failures: [{ reason }],
  });
  let examined = 0;
  const read = async (offset: number, size: number): Promise<Buffer | null> => {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      size > totalBytes - offset ||
      size > MAX_METADATA_BYTES - examined
    )
      return null;
    examined += size;
    const bytes = Buffer.alloc(size);
    let copied = 0;
    while (copied < size) {
      const result = await file.read(
        bytes,
        copied,
        size - copied,
        offset + copied,
      );
      signal?.throwIfAborted();
      if (result.bytesRead === 0) return null;
      copied += result.bytesRead;
    }
    return bytes;
  };
  const prefix = await read(0, Math.min(totalBytes, ELF_HEADER_MAX_BYTES));
  if (prefix === null) return failure("ELF header could not be read");
  const parsed = readElfHeader(prefix, totalBytes);
  if (parsed.failure !== undefined) return failure(parsed.failure.reason);
  const h = parsed.header;
  const ranges = new Map<string, { offset: number; size: number }>();
  for (const table of [
    {
      offset: h.e_phoff,
      width: h.e_phentsize,
      count: h.e_phnum,
      program: true,
    },
    {
      offset: h.e_shoff,
      width: h.e_shentsize,
      count: h.e_shnum,
      program: false,
    },
  ]) {
    const bytes = await read(table.offset, table.width * table.count);
    if (bytes === null)
      return failure(
        "ELF note tables exceed the 8 MiB metadata budget or are truncated",
      );
    for (let index = 0; index < table.count; index += 1) {
      if (index % 4096 === 0) {
        await yieldToEventLoop();
        signal?.throwIfAborted();
      }
      const base = index * table.width;
      if (
        bytes.readUInt32LE(base + (table.program ? 0 : 4)) !==
        (table.program ? 4 : 7)
      )
        continue;
      const offsetAt =
        base + (table.program ? (h.is64 ? 8 : 4) : h.is64 ? 0x18 : 0x10);
      const sizeAt =
        base + (table.program ? (h.is64 ? 0x20 : 0x10) : h.is64 ? 0x20 : 0x14);
      const offset = h.is64
        ? Number(bytes.readBigUInt64LE(offsetAt))
        : bytes.readUInt32LE(offsetAt);
      const size = h.is64
        ? Number(bytes.readBigUInt64LE(sizeAt))
        : bytes.readUInt32LE(sizeAt);
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(size) ||
        size > totalBytes - offset
      )
        return failure("ELF note range is not file-backed");
      ranges.set(`${offset}:${size}`, { offset, size });
    }
  }
  const align4 = (value: number): number => Math.ceil(value / 4) * 4;
  for (const range of ranges.values()) {
    const notes = await read(range.offset, range.size);
    if (notes === null)
      return failure(
        "ELF notes exceed the 8 MiB metadata budget or are truncated",
      );
    let yieldedAt = 0;
    for (let at = 0; at < notes.length;) {
      if (at - yieldedAt >= 64 * 1024) {
        await yieldToEventLoop();
        signal?.throwIfAborted();
        yieldedAt = at;
      }
      if (notes.length - at < 12) {
        if (notes.subarray(at).some((byte) => byte !== 0))
          return failure("ELF note header is truncated");
        break;
      }
      const namesz = notes.readUInt32LE(at);
      const descsz = notes.readUInt32LE(at + 4);
      const type = notes.readUInt32LE(at + 8);
      const descriptor = at + 12 + align4(namesz);
      const end = descriptor + descsz;
      if (end > notes.length)
        return failure("ELF note descriptor exceeds its declared note range");
      if (
        namesz === 4 &&
        type === 3 &&
        notes.subarray(at + 12, at + 16).equals(Buffer.from("GNU\0"))
      ) {
        if (descsz < 4 || descsz > 64)
          return failure(
            "GNU build-id descriptor exceeds the 4–64 byte projection",
          );
        const candidate = notes.subarray(descriptor, end).toString("hex");
        if (!candidates.has(candidate) && candidates.size === MAX_BUILD_IDS)
          return failure(
            "ELF build-id candidates exceed the 64-value evidence budget",
          );
        candidates.add(candidate);
      }
      at = align4(end);
    }
  }
  signal?.throwIfAborted();
  return { candidates: [...candidates], failures: [] };
};
