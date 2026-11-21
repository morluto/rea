import { Buffer } from "node:buffer";
import { BinaryReader } from "../domain/binaryContainer.js";

const PSP_MAGICS = ["$PSP", "$PL2"] as const;
const PSP_HEADER_LENGTH = 16;
const PSP_ENTRY_LENGTH = 16;
const PSP_MAX_ENTRIES = 0xff;
const PSP_FUSE_CHAIN = 0x0b;

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

/** Merge the two signature scans by source offset without retaining all hits. */
function* directoryCandidates(
  image: Buffer,
): Iterable<{ offset: number; magic: (typeof PSP_MAGICS)[number] }> {
  const [primaryMagic, secondaryMagic] = PSP_MAGICS;
  let primary = image.indexOf(primaryMagic, 0, "ascii");
  let secondary = image.indexOf(secondaryMagic, 0, "ascii");
  while (primary >= 0 || secondary >= 0) {
    if (secondary < 0 || (primary >= 0 && primary < secondary)) {
      yield { offset: primary, magic: primaryMagic };
      primary = image.indexOf(
        primaryMagic,
        primary + primaryMagic.length,
        "ascii",
      );
    } else {
      yield { offset: secondary, magic: secondaryMagic };
      secondary = image.indexOf(
        secondaryMagic,
        secondary + secondaryMagic.length,
        "ascii",
      );
    }
  }
}

export const scanPspDirectories = (
  image: Buffer,
  reserve: (count?: number) => boolean,
): { tables: PspTableRecord[]; candidates: PspCandidateRecord[] } => {
  const tables: PspTableRecord[] = [];
  const candidates: PspCandidateRecord[] = [];
  const reader = new BinaryReader(image, true, "AMD PSP directory");
  for (const { offset, magic } of directoryCandidates(image)) {
    if (!reserve()) break;
    if (offset + PSP_HEADER_LENGTH > image.length) {
      candidates.push({ offset, magic, reason: "truncated-header" });
      continue;
    }
    const totalEntries = reader.u32(offset + 8);
    if (totalEntries === 0 || totalEntries > PSP_MAX_ENTRIES) {
      candidates.push({ offset, magic, reason: "implausible-entry-count" });
      continue;
    }
    const length = PSP_HEADER_LENGTH + totalEntries * PSP_ENTRY_LENGTH;
    if (offset + length > image.length) {
      candidates.push({ offset, magic, reason: "truncated-entries" });
      continue;
    }

    // Only a confirmed table reserves retained entry records. The count cap
    // also bounds the checksum work for every admitted signature candidate.
    if (
      reader.u32(offset + 4) !==
      directoryChecksum(reader, offset + 8, offset + length)
    ) {
      candidates.push({ offset, magic, reason: "checksum-mismatch" });
      continue;
    }
    if (!reserve(totalEntries)) break;

    const entries: PspEntryRecord[] = [];
    for (let index = 0; index < totalEntries; index += 1) {
      const start = offset + PSP_HEADER_LENGTH + index * PSP_ENTRY_LENGTH;
      const type = reader.u8(start);
      const raw = reader.word(start + 8, 64);
      const location = raw & ((1n << 62n) - 1n);
      entries.push({
        type,
        // The fuse-chain entry uses this wire field as a scalar value.
        declaredLocation:
          type !== PSP_FUSE_CHAIN && location <= BigInt(Number.MAX_SAFE_INTEGER)
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
      offset,
      length,
      tableMagic: magic,
      totalEntries,
      entries,
      entryStrideBasis: "psp-16",
    });
  }
  return { tables, candidates };
};
