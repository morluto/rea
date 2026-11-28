import { crc32 } from "node:zlib";

import { BinaryReader } from "../domain/binaryContainer.js";
import {
  MAX_CANDIDATE_RECORDS,
  scanZipDirectoryResult,
} from "../domain/desktop/zipDirectory.js";
import { scanZipDirectory } from "../domain/desktop/zipDirectory.js";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { decodeZipCp437 } from "../domain/zip/zipEntryText.js";
import {
  ZIP_EXTRA_FIELD,
  lastZipExtraField,
} from "../domain/zip/zipExtraFields.js";

const UTF8_NAME = 0x08_00;
const ENCRYPTED = 0x00_01;
const ZIP64_SIZE = 0xffff_ffff;
const ZIP64_EXTRA = 0x00_01;
const CENTRAL_FIXED_BYTES = 46;
const ZIP64_FIELD_BYTES = 8;
/** Representation allowance: member objects and names this reader materializes. */
export const MAX_PROGRAM_TREE_MEMBERS = 4096;
/** Aggregate recorded name bytes one listing may materialize. */
export const MAX_PROGRAM_TREE_NAME_BYTES = 4 * 1024 * 1024;

export interface LabviewProgramTreeMember {
  /** Path exactly as the central directory records it. */
  readonly name: string;
  /** Uncompressed bytes the central directory declares. */
  readonly bytes: number;
  /** Stored bytes the central directory declares. */
  readonly storedBytes: number;
  /** ZIP compression method, preserved as declared. */
  readonly method: number;
  /** Whether the entry declares ZIP encryption. */
  readonly encrypted: boolean;
  /** Recorded name bytes when the legacy mapping was a fallback; null otherwise. */
  readonly rawNameHex: string | null;
}

export interface LabviewProgramTree {
  /** File members in the archive; directory entries are omitted. */
  readonly entryCount: number;
  /** Sum of the members' declared uncompressed sizes. */
  readonly totalBytes: number;
  readonly members: readonly LabviewProgramTreeMember[];
}

export type ProgramTreeFailureKind =
  | "ambiguous"
  | "damaged"
  | "limit"
  | "name"
  | "size";

export type ProgramTreeScan =
  | { readonly ok: true; readonly value: LabviewProgramTree }
  | {
      readonly ok: false;
      readonly kind: ProgramTreeFailureKind;
      readonly reason: string;
    };

/** A positional reader over one central-directory record kept by the shared reader. */
const recordReader = (record: Uint8Array): BinaryReader =>
  new BinaryReader(
    Buffer.from(record.buffer, record.byteOffset, record.byteLength),
    true,
    "zip",
  );

/**
 * The recorded name: the UTF-8 flag, then the Info-ZIP Unicode Path extra field
 * (0x7075) when its CRC32 matches, then the legacy CP437 mapping the shared ZIP
 * reader uses. A name that must be UTF-8 but is not is unreadable.
 */
const memberName = (
  reader: BinaryReader,
  name: Uint8Array,
  extraStart: number,
  extraEnd: number,
  flags: number,
): {
  readonly name: string;
  readonly rawHex: string | null;
  readonly representationBytes: number;
} | undefined => {
  if ((flags & UTF8_NAME) !== 0) {
    try {
      return {
        name: decodeStrictUtf8(name, "preserve"),
        rawHex: null,
        representationBytes: name.length,
      };
    } catch {
      return undefined;
    }
  }
  const selected = lastZipExtraField(
    reader,
    extraStart,
    extraEnd,
    ZIP_EXTRA_FIELD.unicodePath,
  );
  if (selected.ok && selected.value !== undefined) {
    const { start, end } = selected.value;
    // The field is authoritative only when its version and name CRC agree.
    if (
      end - start >= 5 &&
      reader.bytes[start] === 1 &&
      reader.u32(start + 1) === crc32(name)
    ) {
      try {
        return {
          name: decodeStrictUtf8(
            reader.bytes.subarray(start + 5, end),
            "preserve",
          ),
          rawHex: null,
          representationBytes: end - start - 5,
        };
      } catch {
        return undefined;
      }
    }
  }
  // CP437 is a fallback for an undeclared encoding: keep the recorded bytes
  // whenever the name is not plain ASCII, so the report does not claim a
  // decoded string is exact.
  return {
    name: decodeZipCp437(name),
    rawHex: name.some((byte) => byte >= 0x80)
      ? Buffer.from(name).toString("hex")
      : null,
    representationBytes: name.length,
  };
};

/** Read the two sizes, resolving the Zip64 extra field for saturated ones. */
const memberSizes = (
  reader: BinaryReader,
  extraStart: number,
  extraEnd: number,
): { readonly bytes: number; readonly storedBytes: number } | undefined => {
  let bytes = reader.u32(24);
  let storedBytes = reader.u32(20);
  if (bytes !== ZIP64_SIZE && storedBytes !== ZIP64_SIZE)
    return { bytes, storedBytes };
  const selected = lastZipExtraField(reader, extraStart, extraEnd, ZIP64_EXTRA);
  if (!selected.ok || selected.value === undefined) return undefined;
  let at = selected.value.start;
  const field = (): number | undefined => {
    if (at + ZIP64_FIELD_BYTES > selected.value!.end) return undefined;
    const value = Number(reader.word(at, 64));
    at += ZIP64_FIELD_BYTES;
    return Number.isSafeInteger(value) ? value : undefined;
  };
  // The Zip64 field holds only the saturated values, in this order.
  if (bytes === ZIP64_SIZE) {
    const value = field();
    if (value === undefined) return undefined;
    bytes = value;
  }
  if (storedBytes === ZIP64_SIZE) {
    const value = field();
    if (value === undefined) return undefined;
    storedBytes = value;
  }
  return { bytes, storedBytes };
};

/**
 * Read the member inventory of the ZIP archive a LabVIEW embedded program tree
 * (`LVzp`) carries. The shared directory reader owns end-record selection,
 * Zip64 resolution, single-volume checks and full-directory consumption; this
 * module interprets each admitted record's name and sizes only. No member is
 * extracted, inflated, or written.
 */
export const parseProgramTreeZip = (bytes: Uint8Array): ProgramTreeScan => {
  // The shared reader resolves end records (classic and Zip64), admits each
  // against its own directory extent, and reports true ambiguity.
  const scan = scanZipDirectoryResult(bytes, MAX_PROGRAM_TREE_MEMBERS);
  if (!scan.ok)
    return scan.reason === "ambiguous"
      ? {
          ok: false,
          kind: "ambiguous",
          reason: "its ZIP end-of-central-directory record is ambiguous",
        }
      : {
          ok: false,
          kind: "damaged",
          reason:
            "its ZIP central directory is damaged or spans multiple disks",
        };
  const directory = scan.directory;
  if (directory.count > MAX_PROGRAM_TREE_MEMBERS)
    return {
      ok: false,
      kind: "limit",
      reason: `it declares ${String(directory.count)} file members, above the ${String(MAX_PROGRAM_TREE_MEMBERS)} this reader lists; use another ZIP inventory for the complete member list, because this release has no override`,
    };
  const members: LabviewProgramTreeMember[] = [];
  let totalBytes = 0;
  let nameBytesTotal = 0;
  for (const record of directory.records) {
    const reader = recordReader(record);
    const flags = reader.u16(8);
    const method = reader.u16(10);
    const nameBytes = reader.u16(28);
    const extraBytes = reader.u16(30);
    const extraAt = CENTRAL_FIXED_BYTES + nameBytes;
    const extraEnd = extraAt + extraBytes;
    const decodedName = memberName(
      reader,
      reader.bytes.subarray(CENTRAL_FIXED_BYTES, extraAt),
      extraAt,
      extraEnd,
      flags,
    );
    if (decodedName === undefined)
      return {
        ok: false,
        kind: "name",
        reason: "a member name is not valid UTF-8",
      };
    if (
      nameBytesTotal + decodedName.representationBytes >
      MAX_PROGRAM_TREE_NAME_BYTES
    )
      return {
        ok: false,
        kind: "limit",
        reason: `its member names total more than the ${String(MAX_PROGRAM_TREE_NAME_BYTES)} bytes this reader materializes; use another ZIP inventory for the complete member list, because this release has no override`,
      };
    nameBytesTotal += decodedName.representationBytes;
    const sizes = memberSizes(reader, extraAt, extraEnd);
    if (sizes === undefined)
      return {
        ok: false,
        kind: "size",
        reason: "a member size is out of range",
      };
    if (!Number.isSafeInteger(totalBytes + sizes.bytes))
      return {
        ok: false,
        kind: "size",
        reason: "its member sizes exceed the supported integer range",
      };
    members.push({
      name: decodedName.name,
      bytes: sizes.bytes,
      storedBytes: sizes.storedBytes,
      method,
      encrypted: (flags & ENCRYPTED) !== 0,
      rawNameHex: decodedName.rawHex,
    });
    totalBytes += sizes.bytes;
  }
  return {
    ok: true,
    value: { entryCount: directory.count, totalBytes, members },
  };
};
