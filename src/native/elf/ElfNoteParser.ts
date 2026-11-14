import {
  observeElfStringTableEntry,
  elfStringTableText,
} from "../../domain/elfStringTable.js";
import { readElfSectionHeader } from "../../domain/elfSectionHeader.js";
import { readElfProgramHeader } from "../../domain/elfProgramHeader.js";
import { validateElfSectionTablePresence } from "../../domain/elfDeclaredRanges.js";
import { readElfRawTableDeclarations } from "../../domain/elfRawTableDeclarations.js";
import { createHash } from "node:crypto";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";
import {
  readElfFixedHeader,
  type ElfFixedHeader,
} from "../../domain/elfFixedHeader.js";
import {
  elfNoteAlignment as noteAlignment,
  elfNoteLayout,
  readElfNoteHeader,
} from "../../domain/native/elfNoteLayout.js";
import type {
  ElfNotes,
  InspectElfNotesInput,
} from "../../domain/native/elfNotes.js";
import {
  androidNoteTypeName,
  coreNoteTypeName,
  elfObjectTypeName,
  gnuNoteTypeName,
} from "../../domain/native/elfNotes.js";
import { BinaryFormatFailure } from "../metadata/BinaryContainer.js";
import { decodeElfSectionNameTable } from "../metadata/ElfSectionNameTable.js";

const PT_NOTE = 4;
const SHT_NOTE = 7;
const SHT_STRTAB = 3;
const HEX_DESCRIPTOR_LIMIT = 64;

/** The existing Linux note layouts do not establish another declared ABI. */
const isLinuxCoreProfile = (header: ElfFixedHeader): boolean =>
  (header.osAbi === 0 || header.osAbi === 3) && header.abiVersion === 0;

interface TextBudget {
  limit: number;
  used: number;
  hashed: number;
  scanned: number;
  readonly hashes: Map<string, string>;
  readonly scans: Map<string, number>;
}

/** Caller can raise max_file_bytes to admit the decoded section-name table. */
export class ElfNoteSectionNameBudgetFailure extends Error {
  readonly _tag = "ElfNoteSectionNameBudgetFailure";

  constructor(
    readonly minimumMaxFileBytes: bigint,
    readonly selectedMaxFileBytes: number,
  ) {
    super(
      `ELF source and decoded section names require ${String(minimumMaxFileBytes)} bytes, above the selected max_file_bytes (${String(selectedMaxFileBytes)}).`,
    );
    this.name = "ElfNoteSectionNameBudgetFailure";
  }
}

const fail = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};

const chargeText = (
  budget: TextBudget,
  bytes: number,
  field: "used" | "hashed" | "scanned" = "used",
): void => {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > budget.limit - budget[field]
  )
    throw new ArtifactReaderFailure(
      "limit",
      `ELF note text exceeds the ${String(budget.limit)}-byte budget.`,
      { boundary: "memory" },
    );
  budget[field] += bytes;
};

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const GNU_OS_NAMES: Readonly<Record<number, string>> = {
  0: "linux",
  1: "hurd",
  2: "solaris",
  3: "freebsd",
  4: "netbsd",
  5: "syllable",
  6: "nacl",
};

const LIMITATIONS = [
  "This workflow does not execute the image, resolve runtime notes, or verify GNU build-id uniqueness against package catalogs.",
  "PT_NOTE and SHT_NOTE are examined independently; the same file range may appear twice when both tables declare it.",
] as const;

const ABSENT_LIMITATIONS = [
  "No PT_NOTE program header or SHT_NOTE section was declared. That is not proof the image never carried notes in another container or overlay.",
  "This workflow does not execute the image, resolve runtime notes, or verify GNU build-id uniqueness against package catalogs.",
] as const;

class ElfReader {
  constructor(
    readonly bytes: Buffer,
    readonly little: boolean,
  ) {}

  require(offset: number, length: number): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > this.bytes.length - length
    )
      fail(
        `ELF range ${String(offset)} + ${String(length)} leaves the artifact.`,
      );
  }

  slice(offset: number, length: number): Buffer {
    this.require(offset, length);
    return this.bytes.subarray(offset, offset + length);
  }

  cString(
    table: Buffer,
    offset: number,
    text: TextBudget,
  ): { name: string | null; limitation: string | null } {
    const observed = observeElfStringTableEntry(
      table,
      offset,
      text.limit - text.used + 1,
    );
    if (observed.state === "outside")
      return {
        name: null,
        limitation:
          "ELF section names are incomplete because a name offset is outside its string table.",
      };
    chargeText(text, observed.contentBytes);
    return {
      name: elfStringTableText(observed),
      limitation:
        observed.state === "truncated"
          ? "ELF section names are incomplete because a name is not NUL-terminated."
          : null,
    };
  }
}

interface ParsedNote {
  readonly location: { offset: number; bytes: number };
  readonly namesz: number;
  readonly descsz: number;
  readonly type: number;
  readonly owner: string;
  readonly owner_bytes_hex: string;
  readonly descriptor: Buffer;
  readonly descriptor_offset: number;
}

const parseNoteStream = (
  reader: ElfReader,
  offset: number,
  size: number,
  alignment: number,
  maxEntries: number,
  examined: { count: number },
  text: TextBudget,
  signal?: AbortSignal,
): ParsedNote[] => {
  // Alignment padding is not read when a note's aligned size equals the
  // declared table. Require the whole table first so a short file is invalid
  // input instead of a provider result the service rejects.
  reader.require(offset, size);
  const notes: ParsedNote[] = [];
  let at = 0;
  while (at + 12 <= size) {
    assertArtifactReadActive(signal);
    examined.count += 1;
    if (examined.count > maxEntries)
      throw new ArtifactReaderFailure(
        "limit",
        `ELF note tables exceed the ${String(maxEntries)}-entry budget.`,
        { boundary: "capacity" },
      );
    const header = offset + at;
    const parsedHeader = readElfNoteHeader(
      reader.slice(header, 12),
      reader.little,
    );
    if (!parsedHeader.ok) return fail(parsedHeader.error.message);
    const { namesz, descsz, type } = parsedHeader.value;
    // Align offsets from the start of this note. Independently rounding
    // namesz/descsz disagrees with binutils when alignment is 8 because the
    // 12-byte note header is not 8-aligned (GNU property namesz=4 then starts
    // its descriptor at 16, not 20).
    const { descriptor: descRel, next: nextRel } = elfNoteLayout(
      namesz,
      descsz,
      alignment,
    );
    const next = at + nextRel;
    if (next > size) fail("ELF note entry exceeds its table.");
    if (next <= at) fail("ELF note alignment did not advance.");
    const nameBytes = reader.slice(header + 12, namesz);
    const descriptor = reader.slice(header + descRel, descsz);
    const ownerEnd = nameBytes.indexOf(0);
    const ownerBytes = ownerEnd < 0 ? namesz : ownerEnd;
    chargeText(text, ownerBytes + namesz * 2);
    notes.push({
      location: { offset: header, bytes: next - at },
      namesz,
      descsz,
      type,
      owner:
        ownerEnd < 0
          ? nameBytes.toString("latin1")
          : nameBytes.subarray(0, ownerEnd).toString("latin1"),
      owner_bytes_hex: nameBytes.toString("hex"),
      descriptor,
      descriptor_offset: header + descRel,
    });
    at = next;
  }
  if (
    at < size &&
    reader.slice(offset + at, size - at).some((byte) => byte !== 0)
  )
    fail("ELF note table has trailing non-zero bytes.");
  return notes;
};

const decodeGnu = (
  owner: string,
  type: number,
  descriptor: Buffer,
  little: boolean,
  text: TextBudget,
): ElfNotes["entries"][number]["gnu"] => {
  if (owner !== "GNU") return null;
  if (type === 3 && descriptor.length > 0) {
    chargeText(text, descriptor.length * 2);
    return {
      build_id_hex: descriptor.toString("hex"),
      abi_tag: null,
      gold_version: null,
    };
  }
  if (type === 1 && descriptor.length === 16) {
    const read = (offset: number) =>
      little
        ? descriptor.readUInt32LE(offset)
        : descriptor.readUInt32BE(offset);
    const os = read(0);
    return {
      build_id_hex: null,
      abi_tag: {
        os,
        os_name: GNU_OS_NAMES[os] ?? null,
        major: read(4),
        minor: read(8),
        subminor: read(12),
      },
      gold_version: null,
    };
  }
  if (type === 4) {
    const range = `${String(descriptor.byteOffset)}:${String(descriptor.length)}`;
    let end = text.scans.get(range);
    if (end === undefined) {
      chargeText(text, descriptor.length, "scanned");
      end = descriptor.length;
      while (end > 0 && descriptor[end - 1] === 0) end -= 1;
      text.scans.set(range, end);
    }
    chargeText(text, end);
    return {
      build_id_hex: null,
      abi_tag: null,
      gold_version: descriptor.toString("latin1", 0, end),
    };
  }
  return {
    build_id_hex: null,
    abi_tag: null,
    gold_version: null,
  };
};

const AUXV_TYPE_NAMES: Readonly<Record<number, string>> = {
  0: "AT_NULL",
  1: "AT_IGNORE",
  2: "AT_EXECFD",
  3: "AT_PHDR",
  4: "AT_PHENT",
  5: "AT_PHNUM",
  6: "AT_PAGESZ",
  7: "AT_BASE",
  8: "AT_FLAGS",
  9: "AT_ENTRY",
  11: "AT_UID",
  12: "AT_EUID",
  13: "AT_GID",
  14: "AT_EGID",
  15: "AT_PLATFORM",
  16: "AT_HWCAP",
  17: "AT_CLKTCK",
  23: "AT_SECURE",
  25: "AT_RANDOM",
  26: "AT_HWCAP2",
  31: "AT_EXECFN",
  33: "AT_SYSINFO_EHDR",
};

const hexWord = (val: bigint | number): string => `0x${val.toString(16)}`;

const decodeCorePrpsinfo = (
  descriptor: Buffer,
  little: boolean,
  wide: boolean,
  text: TextBudget,
): ElfNotes["entries"][number]["core"] => {
  const minLen = wide ? 136 : 124;
  if (descriptor.length < minLen) return null;
  const u8 = (off: number) => descriptor.readUInt8(off);
  const u16 = (off: number) =>
    little ? descriptor.readUInt16LE(off) : descriptor.readUInt16BE(off);
  const u32 = (off: number) =>
    little ? descriptor.readUInt32LE(off) : descriptor.readUInt32BE(off);
  const i32 = (off: number) =>
    little ? descriptor.readInt32LE(off) : descriptor.readInt32BE(off);

  const state = u8(0);
  const uid = wide ? u32(16) : u16(8);
  const gid = wide ? u32(20) : u16(10);
  const pid = wide ? i32(24) : i32(12);
  const ppid = wide ? i32(28) : i32(16);
  const pgrp = wide ? i32(32) : i32(20);
  const sid = wide ? i32(36) : i32(24);

  const fnameOff = wide ? 40 : 28;
  const fnameBytes = descriptor.subarray(fnameOff, fnameOff + 16);
  const fnameEnd = fnameBytes.indexOf(0);
  const fname = (
    fnameEnd < 0 ? fnameBytes : fnameBytes.subarray(0, fnameEnd)
  ).toString("latin1");
  chargeText(text, fname.length);

  const psargsOff = wide ? 56 : 44;
  const psargsBytes = descriptor.subarray(psargsOff, psargsOff + 80);
  const psargsEnd = psargsBytes.indexOf(0);
  const psargs = (
    psargsEnd < 0 ? psargsBytes : psargsBytes.subarray(0, psargsEnd)
  ).toString("latin1");
  chargeText(text, psargs.length);

  return {
    prpsinfo: {
      state,
      pid,
      ppid,
      pgrp,
      sid,
      uid,
      gid,
      filename: fname,
      psargs,
    },
    file: null,
    siginfo: null,
    auxv: null,
  };
};

const decodeCoreFile = (
  descriptor: Buffer,
  little: boolean,
  wide: boolean,
  text: TextBudget,
): ElfNotes["entries"][number]["core"] => {
  const wordSize = wide ? 8 : 4;
  const headerSize = wordSize * 2;
  if (descriptor.length < headerSize) return null;

  const readWord = (off: number): bigint => {
    if (wide) {
      return little
        ? descriptor.readBigUInt64LE(off)
        : descriptor.readBigUInt64BE(off);
    }
    const val = little
      ? descriptor.readUInt32LE(off)
      : descriptor.readUInt32BE(off);
    return BigInt(val);
  };

  const countBig = readWord(0);
  const pageSizeBig = readWord(wordSize);
  if (countBig > 0xffffffffn || pageSizeBig > 0xffffffffn || pageSizeBig === 0n)
    return null;
  const count = Number(countBig);
  const pageSize = Number(pageSizeBig);

  const entrySize = wordSize * 3;
  const neededBytes = BigInt(headerSize) + countBig * BigInt(entrySize);
  if (BigInt(descriptor.length) < neededBytes) return null;
  const tableBytes = Number(neededBytes);

  const rowBytes = count * (wide ? 54 : 30);
  if (rowBytes > text.limit - text.used) {
    throw new ArtifactReaderFailure(
      "limit",
      `ELF note text exceeds the ${String(text.limit)}-byte budget.`,
      { boundary: "memory" },
    );
  }

  const scanKey = `file:${String(descriptor.byteOffset)}:${String(descriptor.length)}`;
  const cachedScan = text.scans.get(scanKey);
  if (cachedScan === -1) return null;
  if (cachedScan === undefined) {
    chargeText(text, descriptor.length - tableBytes, "scanned");
  }

  let strPos = tableBytes;
  let totalPathBytes = 0;
  for (let i = 0; i < count; i++) {
    if (strPos >= descriptor.length) {
      text.scans.set(scanKey, -1);
      return null;
    }
    const nullIdx = descriptor.indexOf(0, strPos);
    if (nullIdx < 0) {
      text.scans.set(scanKey, -1);
      return null;
    }
    totalPathBytes += nullIdx - strPos;
    strPos = nullIdx + 1;
  }
  if (
    cachedScan === undefined &&
    descriptor.subarray(strPos).some((byte) => byte !== 0)
  ) {
    text.scans.set(scanKey, -1);
    return null;
  }
  text.scans.set(scanKey, count);

  const pathBytes = totalPathBytes * 3;
  chargeText(text, rowBytes + pathBytes);

  const mappings: {
    start_address: string;
    end_address: string;
    file_offset_pages: string;
    path: string;
    path_hex: string;
  }[] = new Array(count);

  strPos = tableBytes;
  for (let i = 0; i < count; i++) {
    const entryOff = headerSize + i * entrySize;
    const start = readWord(entryOff);
    const end = readWord(entryOff + wordSize);
    const offsetPages = readWord(entryOff + wordSize * 2);
    const nullIdx = descriptor.indexOf(0, strPos);
    const pathBuf = descriptor.subarray(strPos, nullIdx);
    strPos = nullIdx + 1;
    mappings[i] = {
      start_address: hexWord(start),
      end_address: hexWord(end),
      file_offset_pages: hexWord(offsetPages),
      path: pathBuf.toString("latin1"),
      path_hex: pathBuf.toString("hex"),
    };
  }

  return {
    prpsinfo: null,
    file: {
      count,
      page_size: pageSize,
      mappings,
    },
    siginfo: null,
    auxv: null,
  };
};

const decodeCoreSiginfo = (
  descriptor: Buffer,
  little: boolean,
  machine: number,
): ElfNotes["entries"][number]["core"] => {
  if (descriptor.length < 12) return null;
  const i32 = (off: number) =>
    little ? descriptor.readInt32LE(off) : descriptor.readInt32BE(off);
  const isMips = machine === 8 || machine === 10;
  const signo = i32(0);
  const errno = isMips ? i32(8) : i32(4);
  const code = isMips ? i32(4) : i32(8);
  return {
    prpsinfo: null,
    file: null,
    siginfo: {
      signo,
      errno,
      code,
    },
    auxv: null,
  };
};

const decodeCoreAuxv = (
  descriptor: Buffer,
  little: boolean,
  wide: boolean,
  text: TextBudget,
): ElfNotes["entries"][number]["core"] => {
  const wordSize = wide ? 8 : 4;
  const entrySize = wordSize * 2;
  if (descriptor.length < entrySize || descriptor.length % entrySize !== 0)
    return null;
  const totalPairs = descriptor.length / entrySize;

  const scanKey = `auxv:${String(descriptor.byteOffset)}:${String(descriptor.length)}`;
  let nullIndex = text.scans.get(scanKey);
  if (nullIndex === -1) return null;

  const readWord = (off: number): bigint => {
    if (wide) {
      return little
        ? descriptor.readBigUInt64LE(off)
        : descriptor.readBigUInt64BE(off);
    }
    return BigInt(
      little ? descriptor.readUInt32LE(off) : descriptor.readUInt32BE(off),
    );
  };

  if (nullIndex === undefined) {
    chargeText(text, descriptor.length, "scanned");
    let found = false;
    for (let i = 0; i < totalPairs; i++) {
      const off = i * entrySize;
      const aTypeBig = readWord(off);
      if (aTypeBig > 0xffffffffn) {
        text.scans.set(scanKey, -1);
        return null;
      }
      if (aTypeBig === 0n) {
        found = true;
        nullIndex = i;
        for (let j = off + entrySize; j < descriptor.length; j++) {
          if (descriptor[j] !== 0) {
            text.scans.set(scanKey, -1);
            return null;
          }
        }
        break;
      }
    }
    if (!found || nullIndex === undefined) {
      text.scans.set(scanKey, -1);
      return null;
    }
    text.scans.set(scanKey, nullIndex);
  }

  const rowBytes = nullIndex * (wide ? 38 : 30);
  chargeText(text, rowBytes);

  const auxv: { type: number; type_name: string | null; value: string }[] =
    new Array(nullIndex);
  for (let i = 0; i < nullIndex; i++) {
    const off = i * entrySize;
    const aType = Number(readWord(off));
    const aVal = readWord(off + wordSize);
    auxv[i] = {
      type: aType,
      type_name: AUXV_TYPE_NAMES[aType] ?? null,
      value: hexWord(aVal),
    };
  }

  return {
    prpsinfo: null,
    file: null,
    siginfo: null,
    auxv,
  };
};

const decodeCore = (
  owner: string,
  type: number,
  descriptor: Buffer,
  little: boolean,
  wide: boolean,
  machine: number,
  text: TextBudget,
): ElfNotes["entries"][number]["core"] => {
  if (owner !== "CORE") return null;
  if (type === 3) return decodeCorePrpsinfo(descriptor, little, wide, text);
  if (type === 0x46494c45)
    return decodeCoreFile(descriptor, little, wide, text);
  if (type === 0x53494749)
    return decodeCoreSiginfo(descriptor, little, machine);
  if (type === 6) return decodeCoreAuxv(descriptor, little, wide, text);
  return null;
};

const ANDROID_IDENT_SLOT_BYTES = 64;
const ANDROID_IDENT_MODERN_MIN_BYTES = 4 + ANDROID_IDENT_SLOT_BYTES * 2;

const scanAndroidIdentSlot = (descriptor: Buffer, start: number): number => {
  const end = start + ANDROID_IDENT_SLOT_BYTES;
  for (let i = start; i < end; i += 1) {
    const byte = descriptor[i]!;
    if (byte === 0) {
      const length = i - start;
      for (let j = i + 1; j < end; j += 1) {
        if (descriptor[j] !== 0) return -1;
      }
      return length;
    }
    if (byte < 0x20 || byte > 0x7e) return -1;
  }
  return -1;
};

const decodeAndroid = (
  owner: string,
  type: number,
  descriptor: Buffer,
  little: boolean,
  text: TextBudget,
): ElfNotes["entries"][number]["android"] => {
  if (owner !== "Android" || type !== 1) return null;
  const readUInt32 = (offset: number): number =>
    little ? descriptor.readUInt32LE(offset) : descriptor.readUInt32BE(offset);
  if (descriptor.length === 4) {
    return {
      android_api: readUInt32(0),
      ndk_version: null,
      ndk_build_number: null,
    };
  }
  if (descriptor.length < ANDROID_IDENT_MODERN_MIN_BYTES) return null;

  const scanKey = `android:${String(descriptor.byteOffset)}:${String(descriptor.length)}`;
  let packedLengths = text.scans.get(scanKey);
  if (packedLengths === -1) return null;
  if (packedLengths === undefined) {
    chargeText(text, ANDROID_IDENT_SLOT_BYTES * 2, "scanned");
    const versionLen = scanAndroidIdentSlot(descriptor, 4);
    const buildLen =
      versionLen < 0
        ? -1
        : scanAndroidIdentSlot(descriptor, 4 + ANDROID_IDENT_SLOT_BYTES);
    if (versionLen < 0 || buildLen < 0) {
      text.scans.set(scanKey, -1);
      return null;
    }
    packedLengths = (versionLen << 8) | buildLen;
    text.scans.set(scanKey, packedLengths);
  }

  const versionLen = packedLengths >> 8;
  const buildLen = packedLengths & 0xff;
  chargeText(text, versionLen + buildLen);

  return {
    android_api: readUInt32(0),
    ndk_version: descriptor.toString("latin1", 4, 4 + versionLen),
    ndk_build_number: descriptor.toString(
      "latin1",
      4 + ANDROID_IDENT_SLOT_BYTES,
      4 + ANDROID_IDENT_SLOT_BYTES + buildLen,
    ),
  };
};

/** Decode PT_NOTE and SHT_NOTE tables from one in-memory ELF image. */
export const parseElfNotes = (
  bytes: Buffer,
  artifact: ElfNotes["artifact"],
  input: InspectElfNotesInput,
): ElfNotes => {
  const fixed = readElfFixedHeader(bytes);
  if (!fixed.ok) return fail(fixed.error);
  const header = fixed.value;
  const reader = new ElfReader(bytes, header.byteOrder === "little");
  const wide = header.elfClass === 64;
  const type = header.type;
  const raw = readElfRawTableDeclarations(bytes, header);
  if (!raw.ok) return fail(raw.error.message);
  const { programs, sections } = raw.value;
  if (
    programs.offset > BigInt(Number.MAX_SAFE_INTEGER) ||
    sections.offset > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return fail("ELF offset or size exceeds a safe integer.");
  const presence = validateElfSectionTablePresence(raw.value);
  if (!presence.ok) return fail(presence.error);
  const phoff = Number(programs.offset);
  const shoff = Number(sections.offset);
  const phentsize = programs.width;
  const phnum = programs.count;
  const shentsize = sections.width;
  const shnum = sections.count;
  const shstrndx = sections.namesIndex;
  if (
    phnum === 0xffff ||
    shnum === 0xffff ||
    shstrndx === 0xffff ||
    (shoff !== 0 && shnum === 0)
  )
    throw new BinaryFormatFailure(
      "unsupported",
      "ELF extended numbering is unsupported.",
    );
  if (phnum !== 0) {
    if (phentsize < (wide ? 56 : 32))
      return fail("ELF program header width is invalid.");
    reader.require(phoff, phnum * phentsize);
  }
  if (shnum !== 0) {
    if (shentsize < (wide ? 64 : 40))
      return fail("ELF section header width is invalid.");
    reader.require(shoff, shnum * shentsize);
  }
  const text: TextBudget = {
    limit: Math.min(bytes.length, input.max_file_bytes),
    used: 0,
    hashed: 0,
    scanned: 0,
    hashes: new Map(),
    scans: new Map(),
  };
  let shstrtab: Buffer | null = null;
  const sectionNameLimitations = new Set<string>();
  if (shnum !== 0 && shstrndx !== 0) {
    if (shstrndx >= shnum)
      return fail("ELF section name index is out of range.");
    const namesHeader = shoff + shstrndx * shentsize;
    const parsedNames = readElfSectionHeader(
      bytes.subarray(namesHeader, namesHeader + shentsize),
      header.elfClass,
      reader.little,
    );
    if (!parsedNames.ok) return fail(parsedNames.error.message);
    const namesSection = parsedNames.value;
    if (namesSection.type !== SHT_STRTAB)
      return fail("ELF section name table is not a string table.");
    if (
      namesSection.offset > BigInt(Number.MAX_SAFE_INTEGER) ||
      namesSection.size > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return fail("ELF offset or size exceeds a safe integer.");
    const rawNames = reader.slice(
      Number(namesSection.offset),
      Number(namesSection.size),
    );
    const flags = namesSection.flags;
    const decoded = decodeElfSectionNameTable(
      rawNames,
      flags,
      header.elfClass,
      reader.little,
      input.max_file_bytes - bytes.length,
    );
    if (decoded.state === "malformed") return fail(decoded.message);
    if (decoded.state === "limit")
      throw new ElfNoteSectionNameBudgetFailure(
        BigInt(bytes.length) + decoded.requiredBytes,
        input.max_file_bytes,
      );
    if (decoded.state === "unsupported") {
      shstrtab = null;
      sectionNameLimitations.add(
        `ELF section names are unavailable because compression type ${String(decoded.compressionType)} is unsupported.`,
      );
    } else {
      shstrtab = decoded.bytes;
      if (decoded.compressed) text.limit = bytes.length + shstrtab.length;
    }
  } else if (shnum !== 0) {
    sectionNameLimitations.add(
      "ELF section names are unavailable because no section-name string table is declared.",
    );
  }
  const tables: ElfNotes["tables"] = [];
  const parsed: ReturnType<typeof toEntry>[] = [];
  const examined = { count: 0 };
  if (phnum !== 0) {
    if (phoff < header.headerSize)
      return fail("ELF program header table overlaps the native header.");
    for (let index = 0; index < phnum; index += 1) {
      const at = phoff + index * phentsize;
      const parsedProgram = readElfProgramHeader(
        bytes.subarray(at, at + phentsize),
        header.elfClass,
        reader.little,
      );
      if (!parsedProgram.ok) return fail(parsedProgram.error.message);
      const program = parsedProgram.value;
      if (program.type !== PT_NOTE) continue;
      if (
        program.offset > BigInt(Number.MAX_SAFE_INTEGER) ||
        program.fileSize > BigInt(Number.MAX_SAFE_INTEGER) ||
        program.alignment > BigInt(Number.MAX_SAFE_INTEGER)
      )
        return fail("ELF offset or size exceeds a safe integer.");
      const fileOffset = Number(program.offset);
      const fileSize = Number(program.fileSize);
      const alignment = noteAlignment(Number(program.alignment));
      tables.push({
        kind: "program",
        index,
        name: null,
        location: { offset: fileOffset, bytes: fileSize },
        alignment,
      });
      for (const note of parseNoteStream(
        reader,
        fileOffset,
        fileSize,
        alignment,
        input.max_entries,
        examined,
        text,
      ))
        parsed.push(toEntry(note, "program", index, header, text));
    }
  }
  if (shnum !== 0) {
    if (shoff < header.headerSize)
      return fail("ELF section header table overlaps the native header.");
    for (let index = 0; index < shnum; index += 1) {
      const at = shoff + index * shentsize;
      const parsedSection = readElfSectionHeader(
        bytes.subarray(at, at + shentsize),
        header.elfClass,
        reader.little,
      );
      if (!parsedSection.ok) return fail(parsedSection.error.message);
      const section = parsedSection.value;
      if (section.type !== SHT_NOTE) continue;
      const nameOffset = section.nameOffset;
      if (
        section.offset > BigInt(Number.MAX_SAFE_INTEGER) ||
        section.size > BigInt(Number.MAX_SAFE_INTEGER)
      )
        return fail("ELF offset or size exceeds a safe integer.");
      const fileOffset = Number(section.offset);
      const fileSize = Number(section.size);
      reader.require(fileOffset, fileSize);
      if (section.compressed)
        throw new BinaryFormatFailure(
          "unsupported",
          "Compressed ELF note sections are unsupported; descriptor file offsets require uncompressed note storage.",
        );
      if (section.alignment > BigInt(Number.MAX_SAFE_INTEGER))
        return fail("ELF offset or size exceeds a safe integer.");
      const alignment = noteAlignment(Number(section.alignment));
      const sectionName =
        shstrtab === null
          ? { name: null, limitation: null }
          : reader.cString(shstrtab, nameOffset, text);
      if (sectionName.limitation !== null)
        sectionNameLimitations.add(sectionName.limitation);
      tables.push({
        kind: "section",
        index,
        name: sectionName.name,
        location: { offset: fileOffset, bytes: fileSize },
        alignment,
      });
      for (const note of parseNoteStream(
        reader,
        fileOffset,
        fileSize,
        alignment,
        input.max_entries,
        examined,
        text,
      ))
        parsed.push(toEntry(note, "section", index, header, text));
    }
  }
  const absent = tables.length === 0;
  return {
    artifact,
    format: wide ? "elf64" : "elf32",
    byte_order: reader.little ? "little" : "big",
    machine: header.machine,
    type,
    type_name: elfObjectTypeName(type),
    tables,
    entries: parsed.map((entry, index) => ({ ...entry, index })),
    coverage: {
      status: "complete",
      examined_tables: tables.length,
      examined_entries: examined.count,
    },
    limitations: [
      ...(absent ? ABSENT_LIMITATIONS : LIMITATIONS),
      ...sectionNameLimitations,
      ...(parsed.some(({ owner }) => owner === "CORE")
        ? [
            isLinuxCoreProfile(header)
              ? "Linux CORE decoding assumes System V/unspecified or GNU/Linux OSABI with ABI version zero; an unspecified OSABI alone does not establish operating-system origin."
              : `Linux CORE note payloads were not interpreted for ELF OSABI ${String(header.osAbi)}, ABI version ${String(header.abiVersion)}; raw note identities, descriptor ranges and hashes remain available.`,
          ]
        : []),
    ],
  };
};

const toEntry = (
  note: ParsedNote,
  tableKind: "program" | "section",
  tableIndex: number,
  header: ElfFixedHeader,
  text: TextBudget,
): Omit<ElfNotes["entries"][number], "index"> => {
  const little = header.byteOrder === "little";
  const gnuOwner = note.owner === "GNU";
  const coreOwner = note.owner === "CORE" && isLinuxCoreProfile(header);
  const androidOwner = note.owner === "Android";
  const range = `${String(note.descriptor_offset)}:${String(note.descsz)}`;
  let digest = text.hashes.get(range);
  if (digest === undefined) {
    chargeText(text, note.descriptor.length, "hashed");
    digest = sha256(note.descriptor);
    text.hashes.set(range, digest);
  }
  return {
    table_kind: tableKind,
    table_index: tableIndex,
    location: note.location,
    namesz: note.namesz,
    descsz: note.descsz,
    type: note.type,
    type_name: gnuOwner
      ? gnuNoteTypeName(note.type)
      : coreOwner
        ? coreNoteTypeName(note.type)
        : androidOwner
          ? androidNoteTypeName(note.type)
          : "unknown",
    owner: note.owner,
    owner_bytes_hex: note.owner_bytes_hex,
    descriptor: {
      location: { offset: note.descriptor_offset, bytes: note.descsz },
      bytes: note.descsz,
      sha256: digest,
      hex:
        note.descsz <= HEX_DESCRIPTOR_LIMIT
          ? note.descriptor.toString("hex")
          : null,
    },
    gnu: decodeGnu(note.owner, note.type, note.descriptor, little, text),
    core: coreOwner
      ? decodeCore(
          note.owner,
          note.type,
          note.descriptor,
          little,
          header.elfClass === 64,
          header.machine,
          text,
        )
      : null,
    android: decodeAndroid(
      note.owner,
      note.type,
      note.descriptor,
      little,
      text,
    ),
  };
};

const NT_GNU_PROPERTY_TYPE_0 = 5;
const GNU_PROPERTY_AARCH64_FEATURE_1_AND = 0xc0000000;
const GNU_PROPERTY_X86_FEATURE_1_AND = 0xc0000002;

/** One note table. `alignment` is the declared `sh_addralign` or `p_align`. */
export interface ElfNoteTableWalk {
  readonly offset: number;
  readonly size: number;
  readonly alignment: number | bigint;
}

export interface ElfWalkedNote {
  readonly owner: string;
  readonly type: number;
  readonly descriptor: Buffer;
  readonly descriptorOffset: number;
}

export interface GnuPropertyWord {
  readonly value: number;
  readonly offset: number;
  readonly conflict: boolean;
}

/** Walk note tables with the owner's alignment, entry budget, and cancellation. */
export const walkElfNoteTables = (
  bytes: Buffer,
  little: boolean,
  tables: readonly ElfNoteTableWalk[],
  maxEntries: number,
  signal?: AbortSignal,
): ElfWalkedNote[] => {
  const reader = new ElfReader(bytes, little);
  const text: TextBudget = {
    limit: Math.max(bytes.length, 1),
    used: 0,
    hashed: 0,
    scanned: 0,
    hashes: new Map(),
    scans: new Map(),
  };
  const examined = { count: 0 };
  const notes: ElfWalkedNote[] = [];
  for (const table of tables) {
    assertArtifactReadActive(signal);
    for (const note of parseNoteStream(
      reader,
      table.offset,
      table.size,
      noteAlignment(table.alignment),
      maxEntries,
      examined,
      text,
      signal,
    ))
      notes.push({
        owner: note.owner,
        type: note.type,
        descriptor: note.descriptor,
        descriptorOffset: note.descriptor_offset,
      });
  }
  return notes;
};

/** GNU property feature words from notes the owner already walked. */
export const readGnuPropertyWords = (
  notes: readonly ElfWalkedNote[],
  little: boolean,
  propertyAlign: number,
): Map<number, GnuPropertyWord> => {
  const found = new Map<number, GnuPropertyWord>();
  for (const note of notes) {
    if (note.owner !== "GNU" || note.type !== NT_GNU_PROPERTY_TYPE_0) continue;
    const descriptor = note.descriptor;
    let cursor = 0;
    while (cursor < descriptor.length) {
      if (descriptor.length - cursor < 8)
        fail("ELF GNU property record is truncated.");
      const type = little
        ? descriptor.readUInt32LE(cursor)
        : descriptor.readUInt32BE(cursor);
      const dataSize = little
        ? descriptor.readUInt32LE(cursor + 4)
        : descriptor.readUInt32BE(cursor + 4);
      if (dataSize > descriptor.length - cursor - 8)
        fail("ELF GNU property data extends outside the note descriptor.");
      const step = Math.ceil((8 + dataSize) / propertyAlign) * propertyAlign;
      if (!Number.isSafeInteger(step) || cursor + step > descriptor.length)
        fail("ELF GNU property record is truncated.");
      if (
        type === GNU_PROPERTY_X86_FEATURE_1_AND ||
        type === GNU_PROPERTY_AARCH64_FEATURE_1_AND
      ) {
        if (dataSize !== 4)
          fail("ELF GNU feature property is not a 4-byte word.");
        const value = little
          ? descriptor.readUInt32LE(cursor + 8)
          : descriptor.readUInt32BE(cursor + 8);
        const previous = found.get(type);
        found.set(type, {
          value: previous === undefined ? value : previous.value,
          offset: previous?.offset ?? note.descriptorOffset + cursor + 8,
          conflict:
            previous !== undefined &&
            (previous.conflict || previous.value !== value),
        });
      }
      cursor += step;
    }
  }
  return found;
};
