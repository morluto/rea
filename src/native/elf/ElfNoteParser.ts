import {
  observeElfStringTableEntry,
  elfStringTableText,
} from "../../domain/elfStringTable.js";
import { readElfSectionHeader } from "../../domain/elfSectionHeader.js";
import { readElfProgramHeader } from "../../domain/elfProgramHeader.js";
import { validateElfSectionTableFields } from "../../domain/elfDeclaredRanges.js";
import { readElfRawTableDeclarations } from "../../domain/elfRawTableDeclarations.js";
import { assertArtifactReadActive } from "../../resources/index.js";
import {
  readElfFixedHeader,
  type ElfFixedHeader,
} from "../../domain/elfFixedHeader.js";
import {
  ELF_NOTE_HEADER_BYTES,
  elfNoteAlignment as noteAlignment,
  elfNoteSectionStorage,
  elfNoteSpanOverlapIndex,
  isElfNotePadding,
  readElfNoteFrame,
  type ElfNoteAlignment,
  type ElfNoteSpan,
} from "../../domain/native/elfNoteLayout.js";
import type {
  ElfNotes,
  InspectElfNotesInput,
} from "../../domain/native/elfNotes.js";
import {
  elfNoteTypeName,
  elfObjectTypeName,
} from "../../domain/native/elfNotes.js";
import {
  BinaryFormatFailure,
  BinaryReader,
} from "../../domain/binaryContainer.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
  truncatedInput,
} from "../../domain/parseFailure.js";
import {
  decodeElfSectionNameRequest,
  decodeElfSectionNameRequestCooperative,
  elfSectionNameBudgetFailure,
  type CooperativeElfSectionNameDecoder,
  type ElfSectionNameDecodeRequest,
} from "../../domain/native/elfSectionNameTable.js";
import type { ElfCompressedSectionResult } from "../../domain/native/elfCompressedSection.js";
import type { ZstandardFramePause } from "../../domain/compression/zstandardExactFrame.js";
import { ZstandardFrameAllowanceError } from "../../domain/compression/zstandardFrameAllowance.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import { decodeFdoNote, type FdoDecodeBudget } from "./ElfFdoNote.js";
import type { PrefixedByteSource } from "../../domain/byteSource.js";

const PT_NOTE = 4;
const SHT_STRTAB = 3;
const HEX_DESCRIPTOR_LIMIT = 64;

/** The existing Linux note layouts do not establish another declared ABI. */
const isLinuxCoreProfile = (header: ElfFixedHeader): boolean =>
  (header.osAbi === 0 || header.osAbi === 3) && header.abiVersion === 0;

/**
 * The note text, hash, and scan ceiling. It equals the admitted image length
 * plus decoded section names, so host memory cannot raise it.
 */
export const ELF_NOTE_TEXT_ALLOWANCE =
  "The ELF note text, hash, and scan allowance (derived from the image length and section names)";

const noteTextLimit = (budget: TextBudget): ParseFailureError<"limit"> =>
  decodeLimit(
    "elf-notes",
    `ELF note text exceeds the ${String(budget.limit)}-byte budget.`,
    { name: "note_text_bytes", maximum: budget.limit },
  );

interface TextBudget {
  limit: number;
  used: number;
  hashed: number;
  scanned: number;
  readonly hashes: Map<string, string>;
  readonly scans: Map<string, number>;
}

// The image's bytes, not the request, violate the format: a target refusal.
const fail = (message: string): never => {
  throw malformedInput("elf", message);
};

const failTruncated = (message: string): never => {
  throw truncatedInput("elf", message);
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
    throw noteTextLimit(budget);
  budget[field] += bytes;
};

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

const requireElfRange = (
  fileSize: number,
  offset: number,
  length: number,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > fileSize - length
  )
    fail(
      `ELF range ${String(offset)} + ${String(length)} leaves the artifact.`,
    );
};

const readElfSectionName = (
  table: Buffer,
  offset: number,
  text: TextBudget,
): { name: string | null; limitation: string | null } => {
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
};

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

const parseNoteStreamFromTable = (
  table: Buffer,
  offset: number,
  little: boolean,
  alignment: ElfNoteAlignment,
  maxEntries: number,
  examined: { count: number },
  text: TextBudget,
  signal?: AbortSignal,
): ParsedNote[] => {
  const notes: ParsedNote[] = [];
  let at = 0;
  while (at + ELF_NOTE_HEADER_BYTES <= table.length) {
    assertArtifactReadActive(signal);
    const nameStart = at + ELF_NOTE_HEADER_BYTES;
    const frame = readElfNoteFrame(
      table,
      little,
      alignment,
      table.length - at,
      at,
    );
    if (!frame.ok) return fail(frame.error.message);
    const {
      namesz,
      descsz,
      type,
      descriptor: descRel,
      next,
      framing,
    } = frame.value;
    if (framing !== "complete") fail("ELF note entry exceeds its table.");
    examined.count += 1;
    if (examined.count > maxEntries)
      throw decodeLimit(
        "elf-notes",
        `ELF note tables exceed the ${String(maxEntries)}-entry budget.`,
        { name: "max_entries", maximum: maxEntries, required: examined.count },
      );
    const descStart = at + descRel;
    const nameBytes = table.subarray(nameStart, nameStart + namesz);
    const descriptor = table.subarray(descStart, descStart + descsz);
    const ownerEnd = nameBytes.indexOf(0);
    const ownerBytes = ownerEnd < 0 ? namesz : ownerEnd;
    chargeText(text, ownerBytes + namesz * 2);
    notes.push({
      location: { offset: offset + at, bytes: next },
      namesz,
      descsz,
      type,
      owner:
        ownerEnd < 0
          ? nameBytes.toString("latin1")
          : nameBytes.subarray(0, ownerEnd).toString("latin1"),
      owner_bytes_hex: nameBytes.toString("hex"),
      descriptor,
      descriptor_offset: offset + descStart,
    });
    at += next;
  }
  if (at < table.length && !isElfNotePadding(table.subarray(at)))
    fail("ELF note table has trailing non-zero bytes.");
  return notes;
};

const decodeGnu = (
  owner: string,
  type: number,
  descriptor: Buffer,
  descriptorOffset: number,
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
    const reader = new BinaryReader(descriptor, little, "elf-notes");
    const os = reader.u32(0);
    return {
      build_id_hex: null,
      abi_tag: {
        os,
        os_name: GNU_OS_NAMES[os] ?? null,
        major: reader.u32(4),
        minor: reader.u32(8),
        subminor: reader.u32(12),
      },
      gold_version: null,
    };
  }
  if (type === 4) {
    const range = `${String(descriptorOffset)}:${String(descriptor.length)}`;
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

// Linux v7.3 include/uapi/linux/auxvec.h, plus the arch-wide AT_SYSINFO_EHDR.
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
  10: "AT_NOTELF",
  11: "AT_UID",
  12: "AT_EUID",
  13: "AT_GID",
  14: "AT_EGID",
  15: "AT_PLATFORM",
  16: "AT_HWCAP",
  17: "AT_CLKTCK",
  23: "AT_SECURE",
  24: "AT_BASE_PLATFORM",
  25: "AT_RANDOM",
  26: "AT_HWCAP2",
  27: "AT_RSEQ_FEATURE_SIZE",
  28: "AT_RSEQ_ALIGN",
  29: "AT_HWCAP3",
  30: "AT_HWCAP4",
  31: "AT_EXECFN",
  33: "AT_SYSINFO_EHDR",
  51: "AT_MINSIGSTKSZ",
};

const hexWord = (val: bigint | number): string => `0x${val.toString(16)}`;

// Linux ELF32 core-writer ABIs with established NT_PRPSINFO UID/GID widths.
// The native and compatibility writers store sizeof(elf_prpsinfo).
const LINUX_ELF32_PRPSINFO_ID_WIDTH: Readonly<Partial<Record<number, 2 | 4>>> =
  {
    2: 2, // EM_SPARC
    3: 2, // EM_386
    4: 2, // EM_68K
    8: 4, // EM_MIPS
    15: 4, // EM_PARISC
    20: 4, // EM_PPC
    22: 2, // EM_S390 (31-bit compatibility)
    40: 2, // EM_ARM
    42: 2, // EM_SH
    62: 2, // EM_X86_64 (x32 compatibility)
    92: 4, // EM_OPENRISC
    93: 4, // EM_ARCOMPACT
    94: 4, // EM_XTENSA
    106: 4, // EM_BLACKFIN
    110: 4, // EM_UNICORE
    113: 4, // EM_ALTERA_NIOS2
    140: 4, // EM_TI_C6000
    164: 4, // EM_HEXAGON
    167: 4, // EM_NDS32
    174: 4, // EM_METAG
    188: 4, // EM_TILEPRO
    189: 4, // EM_MICROBLAZE
    191: 4, // EM_TILEGX (ELF32 compatibility)
    195: 4, // EM_ARCV2
    243: 4, // EM_RISCV
    252: 4, // EM_CSKY
    0x8472: 4, // EM_OR32 (older Linux OpenRISC cores)
  };

const decodeCorePrpsinfo = (
  descriptor: Buffer,
  little: boolean,
  wide: boolean,
  machine: number,
  text: TextBudget,
): ElfNotes["entries"][number]["core"] => {
  const idWidth = wide ? 4 : LINUX_ELF32_PRPSINFO_ID_WIDTH[machine];
  if (idWidth === undefined) return null;
  const uidOff = wide ? 16 : 8;
  const gidOff = uidOff + idWidth;
  const pidOff = gidOff + idWidth;
  const fnameOff = pidOff + 16;
  const psargsOff = fnameOff + 16;
  const expectedBytes = psargsOff + 80;
  if (
    wide
      ? descriptor.length < expectedBytes
      : descriptor.length !== expectedBytes
  )
    return null;

  const reader = new BinaryReader(descriptor, little, "elf-notes");
  const state = reader.u8(0);
  const uid = idWidth === 4 ? reader.u32(uidOff) : reader.u16(uidOff);
  const gid = idWidth === 4 ? reader.u32(gidOff) : reader.u16(gidOff);
  const pid = reader.i32(pidOff);
  const ppid = reader.i32(pidOff + 4);
  const pgrp = reader.i32(pidOff + 8);
  const sid = reader.i32(pidOff + 12);

  const fnameBytes = descriptor.subarray(fnameOff, fnameOff + 16);
  const fnameEnd = fnameBytes.indexOf(0);
  const fname = (
    fnameEnd < 0 ? fnameBytes : fnameBytes.subarray(0, fnameEnd)
  ).toString("latin1");
  chargeText(text, fname.length);

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
  descriptorOffset: number,
  little: boolean,
  bits: 32 | 64,
  text: TextBudget,
): ElfNotes["entries"][number]["core"] => {
  const wordSize = bits / 8;
  const headerSize = wordSize * 2;
  if (descriptor.length < headerSize) return null;

  const reader = new BinaryReader(descriptor, little, "elf-notes");

  const countBig = reader.word(0, bits);
  const pageSizeBig = reader.word(wordSize, bits);
  if (countBig > 0xffffffffn || pageSizeBig > 0xffffffffn || pageSizeBig === 0n)
    return null;
  const count = Number(countBig);
  const pageSize = Number(pageSizeBig);

  const entrySize = wordSize * 3;
  const neededBytes = BigInt(headerSize) + countBig * BigInt(entrySize);
  if (BigInt(descriptor.length) < neededBytes) return null;
  const tableBytes = Number(neededBytes);

  const scanKey = `file:${String(descriptorOffset)}:${String(descriptor.length)}`;
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

  // Charge retained rows only after every pathname is framed.
  const rowBytes = count * (bits === 64 ? 54 : 30);
  chargeText(text, rowBytes + totalPathBytes * 3);

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
    const start = reader.word(entryOff, bits);
    const end = reader.word(entryOff + wordSize, bits);
    const offsetPages = reader.word(entryOff + wordSize * 2, bits);
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
  const reader = new BinaryReader(descriptor, little, "elf-notes");
  const isMips = machine === 8 || machine === 10;
  const signo = reader.i32(0);
  const errno = reader.i32(isMips ? 8 : 4);
  const code = reader.i32(isMips ? 4 : 8);
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
  descriptorOffset: number,
  little: boolean,
  bits: 32 | 64,
  text: TextBudget,
): ElfNotes["entries"][number]["core"] => {
  const wordSize = bits / 8;
  const entrySize = wordSize * 2;
  if (descriptor.length < entrySize || descriptor.length % entrySize !== 0)
    return null;
  const totalPairs = descriptor.length / entrySize;

  const scanKey = `auxv:${String(descriptorOffset)}:${String(descriptor.length)}`;
  let nullIndex = text.scans.get(scanKey);
  if (nullIndex === -1) return null;

  const reader = new BinaryReader(descriptor, little, "elf-notes");

  if (nullIndex === undefined) {
    chargeText(text, descriptor.length, "scanned");
    let found = false;
    for (let i = 0; i < totalPairs; i++) {
      const off = i * entrySize;
      const aTypeBig = reader.word(off, bits);
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

  const rowBytes = nullIndex * (bits === 64 ? 38 : 30);
  chargeText(text, rowBytes);

  const auxv: { type: number; type_name: string | null; value: string }[] =
    new Array(nullIndex);
  for (let i = 0; i < nullIndex; i++) {
    const off = i * entrySize;
    const aType = Number(reader.word(off, bits));
    const aVal = reader.word(off + wordSize, bits);
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
  descriptorOffset: number,
  little: boolean,
  bits: 32 | 64,
  machine: number,
  text: TextBudget,
): ElfNotes["entries"][number]["core"] => {
  if (owner !== "CORE") return null;
  if (type === 3)
    return decodeCorePrpsinfo(descriptor, little, bits === 64, machine, text);
  if (type === 0x46494c45)
    return decodeCoreFile(descriptor, descriptorOffset, little, bits, text);
  if (type === 0x53494749)
    return decodeCoreSiginfo(descriptor, little, machine);
  if (type === 6)
    return decodeCoreAuxv(descriptor, descriptorOffset, little, bits, text);
  return null;
};

type ElfNoteEntry = Omit<ElfNotes["entries"][number], "index">;
type ElfNoteTable = ElfNotes["tables"][number];
type ElfNoteScanInput = Pick<
  InspectElfNotesInput,
  "max_entries" | "max_file_bytes"
>;
type ElfNoteStep =
  | {
      readonly kind: "read" | "note-table";
      readonly offset: number;
      readonly length: number;
    }
  | {
      readonly kind: "decode-section-names";
      readonly request: ElfSectionNameDecodeRequest;
    };
type ElfNoteStepResult = Buffer | ElfCompressedSectionResult;
type ElfNoteSteps<T> = Generator<ElfNoteStep, T, ElfNoteStepResult>;

const readElfStep = function* (
  fileSize: number,
  offset: number,
  length: number,
  kind: "read" | "note-table" = "read",
): ElfNoteSteps<Buffer> {
  requireElfRange(fileSize, offset, length);
  return (yield { kind, offset, length }) as Buffer;
};

const decodeSectionNamesStep = function* (
  request: ElfSectionNameDecodeRequest,
): ElfNoteSteps<ElfCompressedSectionResult> {
  return (yield {
    kind: "decode-section-names",
    request,
  }) as ElfCompressedSectionResult;
};

type VisitElfNote = (
  note: ParsedNote,
  table: ElfNoteTable,
  header: ElfFixedHeader,
  text: TextBudget,
) => void;

interface ElfNoteTableScan {
  readonly header: ElfFixedHeader;
  readonly tables: ElfNotes["tables"];
  readonly examinedEntries: number;
  readonly sectionNameLimitations: ReadonlySet<string>;
  readonly unreadCompressedNotes: boolean;
}

const COMPRESSED_NOTE_MESSAGE =
  "Compressed ELF note sections are unsupported; descriptor file offsets require uncompressed note storage.";

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
  descriptorOffset: number,
  little: boolean,
  text: TextBudget,
): ElfNotes["entries"][number]["android"] => {
  if (owner !== "Android" || type !== 1) return null;
  const reader = new BinaryReader(descriptor, little, "elf-notes");
  if (descriptor.length === 4) {
    return {
      android_api: reader.u32(0),
      ndk_version: null,
      ndk_build_number: null,
    };
  }
  if (descriptor.length < ANDROID_IDENT_MODERN_MIN_BYTES) return null;

  const scanKey = `android:${String(descriptorOffset)}:${String(descriptor.length)}`;
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
    android_api: reader.u32(0),
    ndk_version: descriptor.toString("latin1", 4, 4 + versionLen),
    ndk_build_number: descriptor.toString(
      "latin1",
      4 + ANDROID_IDENT_SLOT_BYTES,
      4 + ANDROID_IDENT_SLOT_BYTES + buildLen,
    ),
  };
};

/** Frame every admitted declaration before projecting the notes a consumer needs. */
const parseElfNoteSteps = function* (
  fileSize: number,
  input: ElfNoteScanInput,
  options: { readonly retainReadableNotes: boolean },
  visitNote: VisitElfNote,
): ElfNoteSteps<ElfNoteTableScan> {
  const headerBytes = yield* readElfStep(fileSize, 0, Math.min(fileSize, 64));
  const fixed = readElfFixedHeader(headerBytes, fileSize);
  if (!fixed.ok) return fail(fixed.error);
  const header = fixed.value;
  const little = header.byteOrder === "little";
  const wide = header.elfClass === 64;
  const raw = readElfRawTableDeclarations(headerBytes, header);
  if (!raw.ok) return fail(raw.error.message);
  const { programs, sections } = raw.value;
  if (
    programs.offset > BigInt(Number.MAX_SAFE_INTEGER) ||
    sections.offset > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return fail("ELF offset or size exceeds a safe integer.");
  const sectionTable = validateElfSectionTableFields(raw.value);
  if (!sectionTable.ok) return fail(sectionTable.error);
  const phoff = Number(programs.offset);
  const shoff = Number(sections.offset);
  const phentsize = programs.width;
  const phnum = programs.count;
  const shentsize = sections.width;
  const shnum = sections.count;
  const shstrndx = sections.namesIndex;
  if (phnum === 0xffff || shstrndx === 0xffff || (shoff !== 0 && shnum === 0))
    throw new BinaryFormatFailure(
      "unsupported",
      "ELF extended numbering is unsupported.",
    );
  if (phnum !== 0) {
    if (phentsize < (wide ? 56 : 32))
      return fail("ELF program header width is invalid.");
    requireElfRange(fileSize, phoff, phnum * phentsize);
  }
  if (shnum !== 0) {
    if (shentsize < (wide ? 64 : 40))
      return fail("ELF section header width is invalid.");
    requireElfRange(fileSize, shoff, shnum * shentsize);
  }
  const text: TextBudget = {
    limit: Math.min(fileSize, input.max_file_bytes),
    used: 0,
    hashed: 0,
    scanned: 0,
    hashes: new Map(),
    scans: new Map(),
  };
  const sectionTableOverlapsHeader = shnum !== 0 && shoff < header.headerSize;
  const sectionHeadersBytes =
    shnum !== 0 && !sectionTableOverlapsHeader
      ? yield* readElfStep(fileSize, shoff, shnum * shentsize)
      : null;
  let shstrtab: Buffer | null = null;
  const sectionNameLimitations = new Set<string>();
  if (shnum !== 0 && shstrndx !== 0) {
    if (shstrndx >= shnum)
      return fail("ELF section name index is out of range.");
    const namesHeaderBytes =
      sectionHeadersBytes !== null
        ? sectionHeadersBytes.subarray(
            shstrndx * shentsize,
            (shstrndx + 1) * shentsize,
          )
        : yield* readElfStep(fileSize, shoff + shstrndx * shentsize, shentsize);
    const parsedNames = readElfSectionHeader(
      namesHeaderBytes,
      header.elfClass,
      little,
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
    const rawNames = yield* readElfStep(
      fileSize,
      Number(namesSection.offset),
      Number(namesSection.size),
    );
    const flags = namesSection.flags;
    const decoded = yield* decodeSectionNamesStep({
      fileOffset: Number(namesSection.offset),
      raw: rawNames,
      flags,
      bits: header.elfClass,
      little,
      maximumDecodedBytes: input.max_file_bytes - fileSize,
    });
    if (decoded.state === "malformed") return fail(decoded.message);
    if (decoded.state === "configuration") throw decoded.error;
    if (decoded.state === "work_limit")
      throw new ZstandardFrameAllowanceError(
        { maxFrames: decoded.value, source: decoded.source },
        decoded.offset,
      );
    if (decoded.state === "limit")
      throw elfSectionNameBudgetFailure(
        BigInt(fileSize) + decoded.requiredBytes,
        input.max_file_bytes,
      );
    if (decoded.state === "unsupported") {
      shstrtab = null;
      sectionNameLimitations.add(
        `ELF section names are unavailable because compression type ${String(decoded.compressionType)} is unsupported.`,
      );
    } else {
      shstrtab = decoded.bytes;
      if (decoded.compressed) text.limit = fileSize + shstrtab.length;
    }
  } else if (shnum !== 0) {
    sectionNameLimitations.add(
      "ELF section names are unavailable because no section-name string table is declared.",
    );
  }
  const tables: ElfNotes["tables"] = [];
  let unreadCompressedNotes = false;
  const examined = { count: 0 };
  const noteSections = [];
  const compressedNoteSpans: ElfNoteSpan[] = [];
  const fileEnd = BigInt(fileSize);
  if (sectionHeadersBytes !== null) {
    for (let index = 0; index < shnum; index += 1) {
      const at = index * shentsize;
      const declaration = readElfSectionHeader(
        sectionHeadersBytes.subarray(at, at + shentsize),
        header.elfClass,
        little,
      );
      if (!declaration.ok) return fail(declaration.error.message);
      const section = declaration.value;
      const storage = elfNoteSectionStorage(section);
      if (storage === "not-note") continue;
      const { nameOffset, offset, size, alignment } = section;
      noteSections.push({
        index,
        nameOffset,
        offset,
        size,
        alignment,
        storage,
      });
      if (
        storage === "compressed" &&
        offset <= fileEnd &&
        size <= fileEnd - offset
      )
        compressedNoteSpans.push({
          offset: Number(offset),
          size: Number(size),
        });
    }
  }
  const compressedOverlap =
    compressedNoteSpans.length > 0
      ? elfNoteSpanOverlapIndex(compressedNoteSpans)
      : undefined;
  if (phnum !== 0) {
    if (phoff < header.headerSize)
      return fail("ELF program header table overlaps the native header.");
    const programHeadersBytes = yield* readElfStep(
      fileSize,
      phoff,
      phnum * phentsize,
    );
    for (let index = 0; index < phnum; index += 1) {
      const at = index * phentsize;
      const parsedProgram = readElfProgramHeader(
        programHeadersBytes.subarray(at, at + phentsize),
        header.elfClass,
        little,
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
      const tableSize = Number(program.fileSize);
      // A program header cannot make compressed bytes a raw note stream.
      // Validate its full extent and let the section own the unsupported outcome.
      if (
        compressedOverlap !== undefined &&
        compressedOverlap({ offset: fileOffset, size: tableSize }) !== "none"
      ) {
        requireElfRange(fileSize, fileOffset, tableSize);
        continue;
      }
      const alignment = noteAlignment(Number(program.alignment));
      const table: ElfNoteTable = {
        kind: "program",
        index,
        name: null,
        location: { offset: fileOffset, bytes: tableSize },
        alignment,
      };
      tables.push(table);
      const noteTableBytes = yield* readElfStep(
        fileSize,
        fileOffset,
        tableSize,
        "note-table",
      );
      for (const note of parseNoteStreamFromTable(
        noteTableBytes,
        fileOffset,
        little,
        alignment,
        input.max_entries,
        examined,
        text,
      ))
        visitNote(note, table, header, text);
    }
  }
  if (sectionTableOverlapsHeader)
    return fail("ELF section header table overlaps the native header.");
  for (const {
    index,
    nameOffset,
    offset,
    size,
    alignment: declaredAlignment,
    storage,
  } of noteSections) {
    if (
      offset > BigInt(Number.MAX_SAFE_INTEGER) ||
      size > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return fail("ELF offset or size exceeds a safe integer.");
    const fileOffset = Number(offset);
    const tableSize = Number(size);
    requireElfRange(fileSize, fileOffset, tableSize);
    if (storage === "compressed") {
      if (options.retainReadableNotes !== true)
        throw new BinaryFormatFailure("unsupported", COMPRESSED_NOTE_MESSAGE);
      unreadCompressedNotes = true;
      continue;
    }
    if (
      compressedOverlap !== undefined &&
      compressedOverlap({ offset: fileOffset, size: tableSize }) !== "none"
    )
      continue;
    if (declaredAlignment > BigInt(Number.MAX_SAFE_INTEGER))
      return fail("ELF offset or size exceeds a safe integer.");
    const alignment = noteAlignment(Number(declaredAlignment));
    const sectionName =
      shstrtab === null
        ? { name: null, limitation: null }
        : readElfSectionName(shstrtab, nameOffset, text);
    if (sectionName.limitation !== null)
      sectionNameLimitations.add(sectionName.limitation);
    const table: ElfNoteTable = {
      kind: "section",
      index,
      name: sectionName.name,
      location: { offset: fileOffset, bytes: tableSize },
      alignment,
    };
    tables.push(table);
    const noteTableBytes = yield* readElfStep(
      fileSize,
      fileOffset,
      tableSize,
      "note-table",
    );
    for (const note of parseNoteStreamFromTable(
      noteTableBytes,
      fileOffset,
      little,
      alignment,
      input.max_entries,
      examined,
      text,
    ))
      visitNote(note, table, header, text);
  }
  return {
    header,
    tables,
    examinedEntries: examined.count,
    sectionNameLimitations,
    unreadCompressedNotes,
  };
};

const projectElfNoteSteps = function* (
  fileSize: number,
  artifact: ElfNotes["artifact"],
  input: ElfNoteScanInput,
): ElfNoteSteps<ElfNotes> {
  const fdo: FdoDecodeBudget = {
    decoded: 0,
    retained: 0,
    descriptors: new Map(),
  };
  const entries: ElfNotes["entries"] = [];
  const { header, tables, examinedEntries, sectionNameLimitations } =
    yield* parseElfNoteSteps(
      fileSize,
      input,
      { retainReadableNotes: false },
      (note, table, header, text) =>
        entries.push({
          ...toEntry(note, table.kind, table.index, header, text, fdo),
          index: entries.length,
        }),
    );
  const { type } = header;
  return {
    artifact,
    format: header.elfClass === 64 ? "elf64" : "elf32",
    byte_order: header.byteOrder,
    machine: header.machine,
    type,
    type_name: elfObjectTypeName(type),
    tables,
    entries,
    coverage: {
      status: "complete",
      examined_tables: tables.length,
      examined_entries: examinedEntries,
    },
    limitations: [
      ...(tables.length === 0 ? ABSENT_LIMITATIONS : LIMITATIONS),
      ...sectionNameLimitations,
      ...(entries.some(
        ({ fdo: note }) => note !== null && note.metadata !== null,
      )
        ? [
            "FDO packaging and dlopen metadata are unverified producer declarations.",
          ]
        : []),
      ...(entries.some(({ owner }) => owner === "CORE")
        ? [
            isLinuxCoreProfile(header)
              ? "Linux CORE decoding assumes System V/unspecified or GNU/Linux OSABI with ABI version zero; an unspecified OSABI alone does not establish operating-system origin."
              : `Linux CORE note payloads were not interpreted for ELF OSABI ${String(header.osAbi)}, ABI version ${String(header.abiVersion)}; raw note identities, descriptor ranges and hashes remain available.`,
          ]
        : []),
    ],
  };
};

const decodeElfNoteSteps = <T>(bytes: Buffer, steps: ElfNoteSteps<T>): T => {
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    next = steps.next(
      step.kind !== "decode-section-names"
        ? bytes.subarray(step.offset, step.offset + step.length)
        : decodeElfSectionNameRequest(step.request),
    );
  }
  return next.value;
};

const decodeElfNoteStepsCooperative = async <T>(
  bytes: Buffer,
  steps: ElfNoteSteps<T>,
  decode: CooperativeElfSectionNameDecoder,
): Promise<T> => {
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    next = steps.next(
      step.kind !== "decode-section-names"
        ? bytes.subarray(step.offset, step.offset + step.length)
        : await decode(step.request),
    );
  }
  return next.value;
};

const decodeElfNoteStepsFromSource = async <T>(
  source: PrefixedByteSource,
  steps: ElfNoteSteps<T>,
  decode: CooperativeElfSectionNameDecoder,
): Promise<T> => {
  // Adjacent note declarations commonly alias one table, including a
  // PT_NOTE followed by its SHT_NOTE. Retain at most one table and project
  // each declaration independently.
  let recentTable:
    | { readonly offset: number; readonly bytes: Buffer }
    | undefined;
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    if (step.kind === "decode-section-names") {
      next = steps.next(await decode(step.request));
      continue;
    }
    if (
      step.length === 0 ||
      step.offset + step.length <= source.prefix.length
    ) {
      next = steps.next(
        source.prefix.subarray(step.offset, step.offset + step.length),
      );
      continue;
    }
    if (
      step.kind === "note-table" &&
      recentTable?.offset === step.offset &&
      recentTable.bytes.length === step.length
    ) {
      next = steps.next(recentTable.bytes);
      continue;
    }
    if (step.kind === "note-table") recentTable = undefined;
    const bytes = await source.readRange(step.offset, step.length);
    if (step.kind === "note-table")
      recentTable = { offset: step.offset, bytes };
    next = steps.next(bytes);
  }
  return next.value;
};

/** Decode PT_NOTE and SHT_NOTE tables positionally over a bounded file handle. */
export const parseElfNotesFromHandle = (
  source: PrefixedByteSource,
  artifact: ElfNotes["artifact"],
  input: InspectElfNotesInput,
  pause: ZstandardFramePause,
): Promise<ElfNotes> =>
  decodeElfNoteStepsFromSource(
    source,
    projectElfNoteSteps(source.size, artifact, input),
    (request) => decodeElfSectionNameRequestCooperative(request, pause),
  );

interface ElfGnuBuildIdNotes {
  readonly sources: {
    readonly hex: string;
    readonly table_kind: ElfNoteTable["kind"];
    readonly table_index: number;
    readonly note: ParsedNote["location"];
    readonly descriptor: ParsedNote["location"];
  }[];
  readonly oversized: boolean;
  readonly unreadableStorage: string | null;
}

const readElfBuildIdSteps = function* (
  fileSize: number,
  input: ElfNoteScanInput,
  maximumBuildIdBytes: number,
): ElfNoteSteps<ElfGnuBuildIdNotes> {
  const sources: ElfGnuBuildIdNotes["sources"] = [];
  let oversized = false;
  const { unreadCompressedNotes } = yield* parseElfNoteSteps(
    fileSize,
    input,
    { retainReadableNotes: true },
    (note, table, _header, text) => {
      if (note.owner !== "GNU" || note.type !== 3 || note.descsz === 0) return;
      if (note.descsz > maximumBuildIdBytes) {
        oversized = true;
        return;
      }
      chargeText(text, note.descsz * 2);
      sources.push({
        hex: note.descriptor.toString("hex"),
        table_kind: table.kind,
        table_index: table.index,
        note: note.location,
        descriptor: { offset: note.descriptor_offset, bytes: note.descsz },
      });
    },
  );
  return {
    sources,
    oversized,
    unreadableStorage: unreadCompressedNotes ? COMPRESSED_NOTE_MESSAGE : null,
  };
};

/** Read GNU build IDs with the same framing and entry allowance as full note inspection. */
export const readElfBuildIds = (
  bytes: Buffer,
  input: ElfNoteScanInput,
  maximumBuildIdBytes: number,
): ElfGnuBuildIdNotes =>
  decodeElfNoteSteps(
    bytes,
    readElfBuildIdSteps(bytes.length, input, maximumBuildIdBytes),
  );

export const readElfBuildIdsCooperative = (
  bytes: Buffer,
  input: ElfNoteScanInput,
  maximumBuildIdBytes: number,
  decode: CooperativeElfSectionNameDecoder,
): Promise<ElfGnuBuildIdNotes> =>
  decodeElfNoteStepsCooperative(
    bytes,
    readElfBuildIdSteps(bytes.length, input, maximumBuildIdBytes),
    decode,
  );

/** Read GNU build IDs positionally over a bounded file handle. */
export const readElfBuildIdsFromHandle = (
  source: PrefixedByteSource,
  input: ElfNoteScanInput,
  maximumBuildIdBytes: number,
  decode: CooperativeElfSectionNameDecoder,
): Promise<ElfGnuBuildIdNotes> =>
  decodeElfNoteStepsFromSource(
    source,
    readElfBuildIdSteps(source.size, input, maximumBuildIdBytes),
    decode,
  );

const toEntry = (
  note: ParsedNote,
  tableKind: "program" | "section",
  tableIndex: number,
  header: ElfFixedHeader,
  text: TextBudget,
  fdo: FdoDecodeBudget,
): ElfNoteEntry => {
  const little = header.byteOrder === "little";
  const linuxCore = isLinuxCoreProfile(header);
  const typeName = elfNoteTypeName(note.owner, note.type, linuxCore);
  const coreOwner = note.owner === "CORE" && linuxCore;
  const range = `${String(note.descriptor_offset)}:${String(note.descsz)}`;
  let digest = text.hashes.get(range);
  if (digest === undefined) {
    chargeText(text, note.descriptor.length, "hashed");
    digest = sha256Hex(note.descriptor);
    text.hashes.set(range, digest);
  }
  return {
    table_kind: tableKind,
    table_index: tableIndex,
    location: note.location,
    namesz: note.namesz,
    descsz: note.descsz,
    type: note.type,
    type_name: typeName,
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
    gnu: decodeGnu(
      note.owner,
      note.type,
      note.descriptor,
      note.descriptor_offset,
      little,
      text,
    ),
    core: coreOwner
      ? decodeCore(
          note.owner,
          note.type,
          note.descriptor,
          note.descriptor_offset,
          little,
          header.elfClass,
          header.machine,
          text,
        )
      : null,
    android: decodeAndroid(
      note.owner,
      note.type,
      note.descriptor,
      note.descriptor_offset,
      little,
      text,
    ),
    fdo: decodeFdoNote(typeName, range, note.descriptor, fdo),
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

export interface GnuPropertyWord {
  readonly value: number;
  readonly offset: number;
  readonly conflict: boolean;
}

type NoteRangeRead = {
  readonly kind: "read";
  readonly offset: number;
  readonly length: number;
};
const NOTE_READ_BYTES = 65536;

const readNoteWindow = function* (
  offset: number,
  length: number,
): Generator<NoteRangeRead, Buffer, Buffer> {
  const bytes = yield { kind: "read", offset, length };
  if (bytes.length !== length) failTruncated("ELF note range is truncated.");
  return bytes;
};

/** Frame all admitted notes, then decode GNU properties without retaining payloads. */
export function* readGnuPropertyWordsSteps(
  fileSize: number,
  little: boolean,
  tables: readonly ElfNoteTableWalk[],
  maxEntries: number,
  propertyAlign: number,
  signal?: AbortSignal,
): Generator<NoteRangeRead, Map<number, GnuPropertyWord>, Buffer> {
  const text: TextBudget = {
    limit: Math.max(fileSize, 1),
    used: 0,
    hashed: 0,
    scanned: 0,
    hashes: new Map(),
    scans: new Map(),
  };
  const propertyRanges: ElfNoteSpan[] = [];
  let examined = 0;
  for (const table of tables) {
    requireElfRange(fileSize, table.offset, table.size);
    const end = table.offset + table.size;
    const alignment = noteAlignment(table.alignment);
    let cursor = table.offset;
    let window = Buffer.alloc(0) as Buffer;
    let base = cursor;
    while (end - cursor >= ELF_NOTE_HEADER_BYTES) {
      assertArtifactReadActive(signal);
      if (
        cursor < base ||
        cursor + ELF_NOTE_HEADER_BYTES > base + window.length
      ) {
        base = cursor;
        window = yield* readNoteWindow(
          cursor,
          Math.min(NOTE_READ_BYTES, end - cursor),
        );
      }
      const frame = readElfNoteFrame(
        window,
        little,
        alignment,
        end - cursor,
        cursor - base,
      );
      if (!frame.ok) return fail(frame.error.message);
      if (frame.value.framing !== "complete")
        fail("ELF note entry exceeds its table.");
      if (++examined > maxEntries)
        throw decodeLimit(
          "elf-notes",
          `ELF note tables exceed the ${String(maxEntries)}-entry budget.`,
          { name: "max_entries", maximum: maxEntries, required: examined },
        );
      const { namesz, descsz, type, descriptor, next } = frame.value;
      chargeText(text, namesz * 2);
      const nameAt = cursor + ELF_NOTE_HEADER_BYTES;
      let ownerBytes = 0;
      let gnu = false;
      while (ownerBytes < namesz) {
        assertArtifactReadActive(signal);
        const at = nameAt + ownerBytes;
        const available = base + window.length - at;
        const cached = available >= Math.min(4, namesz - ownerBytes);
        const bytes = cached
          ? window.subarray(
              at - base,
              at - base + Math.min(namesz - ownerBytes, available),
            )
          : yield* readNoteWindow(
              at,
              Math.min(NOTE_READ_BYTES, namesz - ownerBytes),
            );
        const nul = bytes.indexOf(0);
        const length = nul < 0 ? bytes.length : nul;
        if (ownerBytes === 0 && length === 3 && (nul >= 0 || namesz === 3))
          gnu = bytes[0] === 0x47 && bytes[1] === 0x4e && bytes[2] === 0x55;
        chargeText(text, length);
        ownerBytes += length;
        if (nul >= 0) break;
      }
      if (gnu && type === NT_GNU_PROPERTY_TYPE_0)
        propertyRanges.push({ offset: cursor + descriptor, size: descsz });
      cursor += next;
    }
    if (
      cursor < end &&
      !isElfNotePadding(yield* readNoteWindow(cursor, end - cursor))
    )
      fail("ELF note table has trailing non-zero bytes.");
  }
  const found = new Map<number, GnuPropertyWord>();
  for (const { offset, size } of propertyRanges) {
    let cursor = 0;
    let base = 0;
    let window = new BinaryReader(Buffer.alloc(0), little, "elf-notes");
    while (cursor < size) {
      assertArtifactReadActive(signal);
      if (size - cursor < 8)
        failTruncated("ELF GNU property record is truncated.");
      if (cursor + Math.min(12, size - cursor) > base + window.bytes.length) {
        base = cursor;
        window = new BinaryReader(
          yield* readNoteWindow(
            offset + cursor,
            Math.min(NOTE_READ_BYTES, size - cursor),
          ),
          little,
          "elf-notes",
        );
      }
      const local = cursor - base;
      const type = window.u32(local);
      const dataSize = window.u32(local + 4);
      if (dataSize > size - cursor - 8)
        fail("ELF GNU property data extends outside the note descriptor.");
      const step = Math.ceil((8 + dataSize) / propertyAlign) * propertyAlign;
      if (cursor + step > size)
        failTruncated("ELF GNU property record is truncated.");
      if (
        type === GNU_PROPERTY_X86_FEATURE_1_AND ||
        type === GNU_PROPERTY_AARCH64_FEATURE_1_AND
      ) {
        if (dataSize !== 4)
          fail("ELF GNU feature property is not a 4-byte word.");
        const value = window.u32(local + 8);
        const previous = found.get(type);
        found.set(type, {
          value: previous?.value ?? value,
          offset: previous?.offset ?? offset + cursor + 8,
          conflict:
            previous !== undefined &&
            (previous.conflict || previous.value !== value),
        });
      }
      cursor += step;
    }
  }
  return found;
}
