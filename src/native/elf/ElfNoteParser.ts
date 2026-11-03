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
import { readElfFixedHeader } from "../../domain/elfFixedHeader.js";
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
  coreNoteTypeName,
  elfObjectTypeName,
  gnuNoteTypeName,
} from "../../domain/native/elfNotes.js";
import { BinaryFormatFailure } from "../metadata/BinaryContainer.js";
import { decodeElfSectionNameTable } from "../metadata/ElfSectionNameTable.js";

const PT_NOTE = 4;
const SHT_NOTE = 7;
const SHT_STRTAB = 3;
const SHF_COMPRESSED = 0x800n;
const HEX_DESCRIPTOR_LIMIT = 64;

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
): ParsedNote[] => {
  // Alignment padding is not read when a note's aligned size equals the
  // declared table. Require the whole table first so a short file is invalid
  // input instead of a provider result the service rejects.
  reader.require(offset, size);
  const notes: ParsedNote[] = [];
  let at = 0;
  while (at + 12 <= size) {
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
      pid: pid >= 0 ? pid : 0,
      ppid: ppid >= 0 ? ppid : 0,
      pgrp: pgrp >= 0 ? pgrp : 0,
      sid: sid >= 0 ? sid : 0,
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
  if (
    countBig > BigInt(Number.MAX_SAFE_INTEGER) ||
    pageSizeBig > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return null;
  const count = Number(countBig);
  const pageSize = Number(pageSizeBig);
  if (count < 0 || count > 4096) return null;

  const entrySize = wordSize * 3;
  const tableBytes = headerSize + count * entrySize;
  if (descriptor.length < tableBytes) return null;

  const rawMappings: { start: bigint; end: bigint; offsetPages: bigint }[] = [];
  for (let i = 0; i < count; i++) {
    const entryOff = headerSize + i * entrySize;
    const start = readWord(entryOff);
    const end = readWord(entryOff + wordSize);
    const offsetPages = readWord(entryOff + wordSize * 2);
    rawMappings.push({ start, end, offsetPages });
  }

  const mappings: {
    start_address: string;
    end_address: string;
    file_offset_pages: string;
    path: string;
    path_hex: string;
  }[] = [];
  let strPos = tableBytes;
  for (let i = 0; i < count; i++) {
    if (strPos >= descriptor.length) return null;
    const nullIdx = descriptor.indexOf(0, strPos);
    if (nullIdx < 0) return null;
    const pathBuf = descriptor.subarray(strPos, nullIdx);
    const path = pathBuf.toString("latin1");
    const path_hex = pathBuf.toString("hex");
    chargeText(text, pathBuf.length);
    strPos = nullIdx + 1;
    const raw = rawMappings[i];
    if (raw === undefined) return null;
    mappings.push({
      start_address: hexWord(raw.start),
      end_address: hexWord(raw.end),
      file_offset_pages: hexWord(raw.offsetPages),
      path,
      path_hex,
    });
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
): ElfNotes["entries"][number]["core"] => {
  if (descriptor.length < 12) return null;
  const i32 = (off: number) =>
    little ? descriptor.readInt32LE(off) : descriptor.readInt32BE(off);
  const signo = i32(0);
  const errno = i32(4);
  const code = i32(8);
  return {
    prpsinfo: null,
    file: null,
    siginfo: {
      signo: signo >= 0 ? signo : 0,
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
): ElfNotes["entries"][number]["core"] => {
  const wordSize = wide ? 8 : 4;
  const entrySize = wordSize * 2;
  if (descriptor.length < entrySize || descriptor.length % entrySize !== 0)
    return null;
  const totalPairs = descriptor.length / entrySize;
  const MAX_AUXV_PAIRS = 512;
  if (totalPairs > MAX_AUXV_PAIRS) return null;

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

  const auxv: { type: number; type_name: string | null; value: string }[] = [];
  let terminated = false;
  for (let i = 0; i < totalPairs; i++) {
    const off = i * entrySize;
    const aType = Number(readWord(off));
    if (aType === 0) {
      terminated = true;
      break;
    }
    const aVal = readWord(off + wordSize);
    auxv.push({
      type: aType,
      type_name: AUXV_TYPE_NAMES[aType] ?? null,
      value: hexWord(aVal),
    });
  }

  if (!terminated) return null;

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
  text: TextBudget,
): ElfNotes["entries"][number]["core"] => {
  if (owner !== "CORE") return null;
  if (type === 3) return decodeCorePrpsinfo(descriptor, little, wide, text);
  if (type === 0x46494c45)
    return decodeCoreFile(descriptor, little, wide, text);
  if (type === 0x53494749) return decodeCoreSiginfo(descriptor, little);
  if (type === 6) return decodeCoreAuxv(descriptor, little, wide);
  return null;
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
        parsed.push(toEntry(note, "program", index, reader.little, wide, text));
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
      if ((section.flags & SHF_COMPRESSED) !== 0n)
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
        parsed.push(toEntry(note, "section", index, reader.little, wide, text));
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
    ],
  };
};

const toEntry = (
  note: ParsedNote,
  tableKind: "program" | "section",
  tableIndex: number,
  little: boolean,
  wide: boolean,
  text: TextBudget,
): Omit<ElfNotes["entries"][number], "index"> => {
  const gnuOwner = note.owner === "GNU";
  const coreOwner = note.owner === "CORE";
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
    core: decodeCore(
      note.owner,
      note.type,
      note.descriptor,
      little,
      wide,
      text,
    ),
  };
};
