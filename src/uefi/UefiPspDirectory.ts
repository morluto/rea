import { Buffer } from "node:buffer";
import { BinaryReader } from "../domain/binaryContainer.js";

const PSP_MAGICS = ["$PSP", "$PL2"] as const;

interface PspEntryRecord {
  readonly type: number;
  readonly declaredLocation: number | null;
  readonly declaredLocationRaw: string;
  readonly addressMode: number;
  readonly declaredSize: number;
  readonly imageOffset: number | null;
  readonly sha256: string | null;
  readonly locationBasis: "declared-unverified";
}

export interface PspTableRecord {
  readonly offset: number;
  readonly length: number;
  readonly tableMagic: "$PSP" | "$PL2";
  readonly totalEntries: number;
  readonly entries: readonly PspEntryRecord[];
  readonly entryStrideBasis: "psp-16";
}

export interface PspCandidateRecord {
  readonly offset: number;
  readonly magic: string;
  readonly reason: string;
}

/** The PSP checksum covers the count, additional info and directory entries. */
function directoryChecksum(
  reader: BinaryReader,
  start: number,
  end: number,
): number {
  let low = 0xffff;
  let high = 0xffff;
  for (let offset = start; offset < end; offset += 2) {
    low += reader.u16(offset);
    low = (low & 0xffff) + (low >>> 16);
    high += low;
    high = (high & 0xffff) + (high >>> 16);
  }
  return ((high << 16) | low) >>> 0;
}

export const scanPspDirectories = (
  image: Buffer,
  reserve: (count?: number) => boolean,
): { tables: PspTableRecord[]; candidates: PspCandidateRecord[] } => {
  const tables: PspTableRecord[] = [];
  const candidates: PspCandidateRecord[] = [];
  const reader = new BinaryReader(image, true, "AMD PSP directory");
  const headerLength = 16;
  const entryLength = 16;
  for (const magic of PSP_MAGICS) {
    let searchFrom = 0;
    while (searchFrom < image.length) {
      const hit = image.indexOf(magic, searchFrom, "ascii");
      if (hit < 0 || !reserve()) break;
      searchFrom = hit + magic.length;
      const totalEntries =
        hit + headerLength <= image.length ? reader.u32(hit + 8) : 0;
      const tableLength = headerLength + totalEntries * entryLength;
      if (
        totalEntries === 0 ||
        totalEntries > 255 ||
        hit + tableLength > image.length
      ) {
        candidates.push({
          offset: hit,
          magic,
          reason: "implausible-entry-count",
        });
        continue;
      }
      if (!reserve(totalEntries)) return { tables, candidates };
      if (
        reader.u32(hit + 4) !==
        directoryChecksum(reader, hit + 8, hit + tableLength)
      ) {
        candidates.push({ offset: hit, magic, reason: "checksum-mismatch" });
        continue;
      }
      const entries: PspEntryRecord[] = [];
      for (let index = 0; index < totalEntries; index += 1) {
        const start = hit + headerLength + index * entryLength;
        const raw = reader.word(start + 8, 64);
        const location = raw & ((1n << 62n) - 1n);
        entries.push({
          type: reader.u8(start),
          declaredLocation:
            location <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(location)
              : null,
          declaredLocationRaw: `0x${raw.toString(16).padStart(16, "0")}`,
          addressMode: Number(raw >> 62n),
          declaredSize: reader.u32(start + 4),
          imageOffset: null,
          sha256: null,
          locationBasis: "declared-unverified",
        });
      }
      tables.push({
        offset: hit,
        length: tableLength,
        tableMagic: magic,
        totalEntries,
        entries,
        entryStrideBasis: "psp-16",
      });
    }
  }
  return { tables, candidates };
};
