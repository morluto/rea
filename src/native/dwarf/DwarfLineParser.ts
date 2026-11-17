import type { CoverageStatus } from "../../domain/coverage.js";
import {
  type DwarfLineAddressMatch,
  type DwarfLineDirectory,
  type DwarfLineFile,
  type DwarfLineIssue,
  type DwarfLineIssueCode,
  type DwarfLineNumberFact,
  type DwarfLineProgram,
  type DwarfLineRow,
  type DwarfLineSequence,
  type DwarfLineStringFact,
  DWARF_LINE_LIMITATIONS,
  MAX_DWARF_LINE_ADDRESS_MATCHES,
  MAX_DWARF_LINE_EXPANDED_STRING_CHARS,
  MAX_DWARF_LINE_FORMAT_COLUMNS,
  MAX_DWARF_LINE_HEADER_ENTRIES,
  MAX_DWARF_LINE_PROGRAM_ISSUES,
  MAX_DWARF_LINE_PROGRAM_STEPS,
  MAX_DWARF_LINE_PROGRAMS_WALKED,
  MAX_DWARF_LINE_SEQUENCE_ROWS,
  MAX_DWARF_LINE_SEQUENCES,
  MAX_DWARF_LINE_STANDARD_OPCODES,
  MAX_DWARF_LINE_STRING_TABLE_BYTES,
  MAX_DWARF_LINE_TOTAL_HEADER_ENTRIES,
  formatDwarfLineAddress,
} from "../../domain/native/dwarfLines.js";
import { MAX_DWARF_STRING_BYTES } from "../../domain/native/dwarfUnits.js";
import { malformedInput, truncatedInput } from "../../domain/parseFailure.js";
import { byteToHex } from "../../kernel/byteToHex.js";
import { DwarfCursor, readInitialLength } from "./DwarfReader.js";

const DW_LNCT_PATH = 1;
const DW_LNCT_DIRECTORY_INDEX = 2;
const DW_LNCT_TIMESTAMP = 3;
const DW_LNCT_SIZE = 4;
const DW_LNCT_MD5 = 5;
const DW_LNCT_LLVM_SOURCE = 0x2001;

const DW_FORM_ADDR = 0x01;
const DW_FORM_BLOCK2 = 0x03;
const DW_FORM_BLOCK4 = 0x04;
const DW_FORM_DATA2 = 0x05;
const DW_FORM_DATA4 = 0x06;
const DW_FORM_DATA8 = 0x07;
const DW_FORM_STRING = 0x08;
const DW_FORM_BLOCK = 0x09;
const DW_FORM_BLOCK1 = 0x0a;
const DW_FORM_DATA1 = 0x0b;
const DW_FORM_FLAG = 0x0c;
const DW_FORM_SDATA = 0x0d;
const DW_FORM_STRP = 0x0e;
const DW_FORM_UDATA = 0x0f;
const DW_FORM_INDIRECT = 0x16;
const DW_FORM_EXPRLOC = 0x18;
const DW_FORM_FLAG_PRESENT = 0x19;
const DW_FORM_STRX = 0x1a;
const DW_FORM_LINE_STRP = 0x1f;
const DW_FORM_DATA16 = 0x1e;
const DW_FORM_STRX1 = 0x25;
const DW_FORM_STRX2 = 0x26;
const DW_FORM_STRX3 = 0x27;
const DW_FORM_STRX4 = 0x28;

const DW_LNS_COPY = 1;
const DW_LNS_ADVANCE_PC = 2;
const DW_LNS_ADVANCE_LINE = 3;
const DW_LNS_SET_FILE = 4;
const DW_LNS_SET_COLUMN = 5;
const DW_LNS_NEGATE_STMT = 6;
const DW_LNS_SET_BASIC_BLOCK = 7;
const DW_LNS_CONST_ADD_PC = 8;
const DW_LNS_FIXED_ADVANCE_PC = 9;
const DW_LNS_SET_PROLOGUE_END = 10;
const DW_LNS_SET_EPILOGUE_BEGIN = 11;
const DW_LNS_SET_ISA = 12;

const DW_LNE_END_SEQUENCE = 1;
const DW_LNE_SET_ADDRESS = 2;
const DW_LNE_DEFINE_FILE = 3;
const DW_LNE_SET_DISCRIMINATOR = 4;

const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const MAX_INDIRECTION_DEPTH = 8;

const ABSENT_STRING: DwarfLineStringFact = { state: "absent", value: null };
const UNRESOLVED_STRING: DwarfLineStringFact = {
  state: "unresolved",
  value: null,
};
const UNKNOWN_STRING: DwarfLineStringFact = { state: "unknown", value: null };
const ABSENT_NUMBER: DwarfLineNumberFact = { state: "absent", value: null };
const UNKNOWN_NUMBER: DwarfLineNumberFact = { state: "unknown", value: null };

export interface ParseDwarfLineProgramsInput {
  readonly line: Buffer;
  readonly lineStr: Buffer | null;
  readonly str: Buffer | null;
  readonly strOffsets: Buffer | null;
  readonly lineFileOffset: number | null;
  readonly little: boolean;
  readonly defaultAddressSize: 4 | 8;
  readonly programOffset?: number;
  readonly addresses?: readonly string[];
  readonly maxPrograms: number;
  readonly maxRows: number;
  readonly unappliedLineRelocations: readonly string[];
  readonly unappliedDebugRelocations: readonly string[];
}

export interface ParsedDwarfLinePrograms {
  readonly selected_program_offset: number | null;
  readonly programs: readonly DwarfLineProgram[];
  readonly total_programs: number;
  readonly rows: readonly DwarfLineRow[];
  readonly total_rows: number;
  readonly address_matches: readonly DwarfLineAddressMatch[];
  readonly coverage: {
    readonly status: CoverageStatus;
    readonly reason: string | null;
  };
  readonly limitations: readonly string[];
}

interface StringTableState {
  readonly str: Buffer | null;
  readonly lineStr: Buffer | null;
  readonly strOffsetsTable:
    | {
        readonly state: "ready";
        readonly entrySize: 4 | 8;
        readonly entries: Buffer;
      }
    | { readonly state: "absent" | "ambiguous" | "relocated" };
  readonly little: boolean;
  readonly lineRelocated: boolean;
  readonly debugStrRelocated: boolean;
  usedStringBytes: number;
  stringBudgetHit: boolean;
}

interface SequenceRowRecord {
  readonly programIndex: number;
  readonly programOffset: number;
  readonly sequenceIndex: number;
  readonly address: bigint;
  readonly opIndex: number;
  readonly fileIndex: number;
  readonly fileName: string | null;
  readonly directory: string | null;
  readonly path: string | null;
  readonly md5Hex: string | null;
  readonly line: number;
  readonly column: number;
  readonly isStmt: boolean;
  readonly basicBlock: boolean;
  readonly endSequence: boolean;
  readonly prologueEnd: boolean;
  readonly epilogueBegin: boolean;
  readonly isa: number;
  readonly discriminator: number;
}

interface DecodedSequenceIndex {
  readonly programIndex: number;
  readonly programOffset: number;
  readonly sequenceIndex: number;
  readonly hasEndSequence: boolean;
  readonly monotonic: boolean;
  readonly rows: readonly SequenceRowRecord[];
  readonly endAddress: bigint | null;
}

interface AddressMatchTarget {
  readonly queryAddress: string;
  readonly target: bigint;
  readonly matches: DwarfLineAddressMatch["matches"][number][];
}

interface SharedBudget {
  stepsRemaining: number;
  stepBudgetHit: boolean;
  headerEntriesRemaining: number;
  headerEntryBudgetHit: boolean;
  expandedCharsRemaining: number;
  stringExpansionBudgetHit: boolean;
  sequencesRemaining: number;
  sequenceCountBudgetHit: boolean;
  addressMatchesRemaining: number;
  addressMatchBudgetHit: boolean;
  addressMatchStringBudgetHit: boolean;
  sequenceBudgetHit: boolean;
}

const addressMatchingStopped = (budget: SharedBudget): boolean =>
  budget.addressMatchBudgetHit || budget.addressMatchStringBudgetHit;

interface ProgramIssueCollector {
  readonly list: DwarfLineIssue[];
  readonly seen: Set<string>;
  push(code: DwarfLineIssueCode, detail: string): void;
}

const createIssueCollector = (): ProgramIssueCollector => {
  const list: DwarfLineIssue[] = [];
  const seen = new Set<string>();
  return {
    list,
    seen,
    push(code, detail) {
      if (list.length >= MAX_DWARF_LINE_PROGRAM_ISSUES) return;
      const key = `${code}:${detail}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ code, detail });
    },
  };
};

const toSafeInt = (value: number | bigint): number | null => {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
};

const toSignedSafeInt = (value: number | bigint): number | null => {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (
    value < BigInt(Number.MIN_SAFE_INTEGER) ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  return Number(value);
};

const consumeStep = (budget: SharedBudget): boolean => {
  if (budget.stepsRemaining <= 0) {
    budget.stepBudgetHit = true;
    return false;
  }
  budget.stepsRemaining -= 1;
  return true;
};

const consumeHeaderEntry = (
  budget: SharedBudget,
  issues: ProgramIssueCollector,
): boolean => {
  if (!consumeStep(budget)) {
    issues.push(
      "decode_budget",
      `Stopped after ${MAX_DWARF_LINE_PROGRAM_STEPS} line-program decoding steps`,
    );
    return false;
  }
  if (budget.headerEntriesRemaining <= 0) {
    budget.headerEntryBudgetHit = true;
    issues.push(
      "header_entry_budget",
      `Aggregate directory and file entries exceeded ${MAX_DWARF_LINE_TOTAL_HEADER_ENTRIES} entry cap`,
    );
    return false;
  }
  budget.headerEntriesRemaining -= 1;
  return true;
};

const tryConsumeExpandedChars = (
  budget: SharedBudget,
  chars: number,
): boolean => {
  if (chars <= 0) return true;
  if (chars > budget.expandedCharsRemaining) {
    budget.stringExpansionBudgetHit = true;
    return false;
  }
  budget.expandedCharsRemaining -= chars;
  return true;
};

const readUleb = (cursor: DwarfCursor): bigint | null => {
  const res = cursor.uleb();
  return res.ok ? res.value : null;
};

const readSleb = (cursor: DwarfCursor): bigint | null => {
  const res = cursor.sleb();
  return res.ok ? res.value : null;
};

const readRawBytes = (cursor: DwarfCursor, count: number): Buffer | null => {
  const out = Buffer.alloc(count);
  for (let i = 0; i < count; i += 1) {
    const b = cursor.u8();
    if (b === null) return null;
    out[i] = b;
  }
  return out;
};

const readOffsetBySize = (cursor: DwarfCursor, size: 4 | 8): bigint | null => {
  if (size === 4) {
    const v = cursor.u32();
    return v === null ? null : BigInt(v);
  }
  return cursor.u64();
};

const initStringOffsetsTable = (
  strOffsets: Buffer | null,
  little: boolean,
  lineRelocated: boolean,
  unappliedDebugRelocations: readonly string[],
): StringTableState["strOffsetsTable"] => {
  if (strOffsets === null || strOffsets.length === 0)
    return { state: "absent" };
  if (
    lineRelocated ||
    unappliedDebugRelocations.some(
      (name) =>
        name.endsWith(".debug_str_offsets") ||
        name.endsWith(".zdebug_str_offsets"),
    )
  ) {
    return { state: "relocated" };
  }
  const cursor = new DwarfCursor(strOffsets, little);
  const initial = readInitialLength(cursor);
  if (!initial.ok || initial.totalLength > strOffsets.length) {
    return { state: "ambiguous" };
  }
  // Single self-contained contribution without DW_AT_str_offsets_base is only unambiguous
  // when the section contains exactly that one table header + entries.
  if (initial.totalLength !== strOffsets.length) {
    return { state: "ambiguous" };
  }
  const version = cursor.u16();
  const padding = cursor.u16();
  if (version !== 5 || padding !== 0) {
    return { state: "ambiguous" };
  }
  return {
    state: "ready",
    entrySize: initial.offsetSize,
    entries: strOffsets.subarray(cursor.offset, initial.totalLength),
  };
};

const createStringTableState = (
  input: ParseDwarfLineProgramsInput,
): StringTableState => {
  const lineRelocated = input.unappliedLineRelocations.length > 0;
  const debugStrRelocated =
    lineRelocated ||
    input.unappliedDebugRelocations.some(
      (name) => name.endsWith(".debug_str") || name.endsWith(".zdebug_str"),
    );
  return {
    str: input.str,
    lineStr: input.lineStr,
    strOffsetsTable: initStringOffsetsTable(
      input.strOffsets,
      input.little,
      lineRelocated,
      input.unappliedDebugRelocations,
    ),
    little: input.little,
    lineRelocated,
    debugStrRelocated,
    usedStringBytes: 0,
    stringBudgetHit: false,
  };
};

const readCStringSlice = (
  bytes: Buffer,
  start: number,
  issues: ProgramIssueCollector,
):
  | {
      readonly ok: true;
      readonly end: number;
      readonly truncatedToLimit: boolean;
    }
  | { readonly ok: false } => {
  if (start >= bytes.length) {
    issues.push("truncated_header", "C-string reaches past buffer end");
    return { ok: false };
  }
  const scanEnd = Math.min(bytes.length, start + MAX_DWARF_STRING_BYTES + 1);
  const relNul = bytes.subarray(start, scanEnd).indexOf(0);
  if (relNul < 0) {
    if (scanEnd - start > MAX_DWARF_STRING_BYTES) {
      issues.push(
        "string_budget",
        `C-string exceeds ${MAX_DWARF_STRING_BYTES} bytes`,
      );
      return { ok: true, end: bytes.length, truncatedToLimit: true };
    }
    issues.push("truncated_header", "Unterminated DWARF string");
    return { ok: false };
  }
  return { ok: true, end: start + relNul, truncatedToLimit: false };
};

interface DecodedStringResult {
  readonly fact: DwarfLineStringFact;
  readonly nonEmpty: boolean;
}

const decodeBoundedUtf8 = (
  bytes: Buffer,
  start: number,
  end: number,
  state: StringTableState,
  issues: ProgramIssueCollector,
  retain: boolean,
): DecodedStringResult => {
  const byteLength = end - start;
  const nonEmpty = byteLength > 0;
  if (!retain) {
    return { fact: { state: "present", value: "" }, nonEmpty };
  }
  const utf8BudgetBytes = byteLength * 2;
  if (
    state.usedStringBytes + utf8BudgetBytes >
    MAX_DWARF_LINE_STRING_TABLE_BYTES
  ) {
    state.stringBudgetHit = true;
    issues.push(
      "string_budget",
      "Line-program string table exceeded 16 MiB budget",
    );
    return { fact: UNKNOWN_STRING, nonEmpty };
  }
  state.usedStringBytes += utf8BudgetBytes;
  return {
    fact: {
      state: "present",
      value: bytes.subarray(start, end).toString("utf8"),
    },
    nonEmpty,
  };
};

const readInlineStringFact = (
  cursor: DwarfCursor,
  sectionBytes: Buffer,
  state: StringTableState,
  issues: ProgramIssueCollector,
  retain: boolean,
): {
  readonly ok: boolean;
  readonly fact: DwarfLineStringFact;
  readonly nonEmpty: boolean;
} => {
  const start = cursor.offset;
  const scanned = readCStringSlice(sectionBytes, start, issues);
  if (!scanned.ok) {
    cursor.skip(cursor.remaining());
    return { ok: false, fact: UNKNOWN_STRING, nonEmpty: false };
  }
  if (scanned.truncatedToLimit) {
    cursor.skip(cursor.remaining());
    return { ok: false, fact: UNKNOWN_STRING, nonEmpty: false };
  }
  const end = scanned.end;
  cursor.skip(end - start + 1);
  if (retain && state.stringBudgetHit) {
    return { ok: true, fact: UNKNOWN_STRING, nonEmpty: end > start };
  }
  const res = decodeBoundedUtf8(
    sectionBytes,
    start,
    end,
    state,
    issues,
    retain,
  );
  return { ok: true, fact: res.fact, nonEmpty: res.nonEmpty };
};

const readExternalStringAtOffset = (
  table: Buffer | null,
  tableName: string,
  offsetBig: bigint,
  relocated: boolean,
  state: StringTableState,
  issues: ProgramIssueCollector,
  retain: boolean,
): DecodedStringResult => {
  if (relocated) {
    issues.push(
      "unapplied_relocation",
      `Unapplied ET_REL relocations leave ${tableName} references unresolved`,
    );
    return { fact: UNRESOLVED_STRING, nonEmpty: false };
  }
  if (table === null) {
    issues.push(
      "string_unresolved",
      `Missing ${tableName} section for external string reference`,
    );
    return { fact: UNRESOLVED_STRING, nonEmpty: false };
  }
  const offset = toSafeInt(offsetBig);
  if (offset === null || offset >= table.length) {
    issues.push(
      "string_unresolved",
      `${tableName} offset is outside section bounds`,
    );
    return { fact: UNRESOLVED_STRING, nonEmpty: false };
  }
  const scanEnd = Math.min(table.length, offset + MAX_DWARF_STRING_BYTES + 1);
  const relNul = table.subarray(offset, scanEnd).indexOf(0);
  if (relNul < 0) {
    if (!retain && scanEnd - offset > MAX_DWARF_STRING_BYTES) {
      return { fact: { state: "present", value: "" }, nonEmpty: true };
    }
    issues.push(
      scanEnd - offset > MAX_DWARF_STRING_BYTES
        ? "string_budget"
        : "string_unresolved",
      `Unterminated string in ${tableName}`,
    );
    return { fact: UNKNOWN_STRING, nonEmpty: false };
  }
  if (retain && state.stringBudgetHit) {
    return { fact: UNKNOWN_STRING, nonEmpty: relNul > 0 };
  }
  return decodeBoundedUtf8(
    table,
    offset,
    offset + relNul,
    state,
    issues,
    retain,
  );
};

const resolveStrxIndex = (
  indexBig: bigint,
  state: StringTableState,
  issues: ProgramIssueCollector,
  retain: boolean,
): DecodedStringResult => {
  if (state.lineRelocated) {
    issues.push(
      "unapplied_relocation",
      "Unapplied ET_REL relocations leave DW_FORM_strx references unresolved",
    );
    return { fact: UNRESOLVED_STRING, nonEmpty: false };
  }
  const table = state.strOffsetsTable;
  if (table.state !== "ready") {
    if (table.state === "absent") {
      issues.push(
        "string_unresolved",
        "Missing .debug_str_offsets section for DW_FORM_strx",
      );
    } else if (table.state === "relocated") {
      issues.push(
        "unapplied_relocation",
        "Unapplied ET_REL relocations target .debug_str_offsets",
      );
    } else {
      issues.push(
        "str_offsets_base_absent",
        "Cannot determine DW_AT_str_offsets_base across multiple .debug_str_offsets tables",
      );
    }
    return { fact: UNRESOLVED_STRING, nonEmpty: false };
  }
  const index = toSafeInt(indexBig);
  const { entrySize, entries } = table;
  if (index === null || (index + 1) * entrySize > entries.length) {
    issues.push(
      "string_unresolved",
      "DW_FORM_strx index is outside .debug_str_offsets table",
    );
    return { fact: UNRESOLVED_STRING, nonEmpty: false };
  }
  const slot = new DwarfCursor(
    entries.subarray(index * entrySize, (index + 1) * entrySize),
    state.little,
  );
  const strOffset = readOffsetBySize(slot, entrySize);
  if (strOffset === null) return { fact: UNRESOLVED_STRING, nonEmpty: false };
  return readExternalStringAtOffset(
    state.str,
    ".debug_str",
    strOffset,
    state.debugStrRelocated,
    state,
    issues,
    retain,
  );
};

const isPathSeparator = (ch: string): boolean => ch === "/" || ch === "\\";

const isAbsoluteSourcePath = (name: string): boolean =>
  isPathSeparator(name[0] ?? "") || /^[A-Za-z]:[/\\]/.test(name);

const joinDirectoryAndFile = (directory: string, name: string): string => {
  if (directory.length === 0) return name;
  const last = directory[directory.length - 1] ?? "";
  if (isPathSeparator(last)) return `${directory}${name}`;
  const sep = directory.includes("\\") && !directory.includes("/") ? "\\" : "/";
  return `${directory}${sep}${name}`;
};

const joinDirectoryAndFileLength = (
  directory: string,
  name: string,
): number => {
  if (directory.length === 0) return name.length;
  const last = directory[directory.length - 1] ?? "";
  return isPathSeparator(last)
    ? directory.length + name.length
    : directory.length + 1 + name.length;
};

const computeCombinedPath = (
  name: DwarfLineStringFact,
  _directoryIndex: number | null,
  directory: DwarfLineStringFact,
  _zeroBased: boolean,
  budget: SharedBudget,
  issues: ProgramIssueCollector,
): DwarfLineStringFact => {
  if (name.state !== "present" || name.value === null) return name;
  if (isAbsoluteSourcePath(name.value)) {
    if (!tryConsumeExpandedChars(budget, name.value.length)) {
      issues.push(
        "string_budget",
        `Expanded file path exceeded ${MAX_DWARF_LINE_EXPANDED_STRING_CHARS}-character budget`,
      );
      return UNKNOWN_STRING;
    }
    return name;
  }
  if (directory.state === "present" && directory.value !== null) {
    const joinedLength = joinDirectoryAndFileLength(
      directory.value,
      name.value,
    );
    if (!tryConsumeExpandedChars(budget, joinedLength)) {
      issues.push(
        "string_budget",
        `Expanded file path exceeded ${MAX_DWARF_LINE_EXPANDED_STRING_CHARS}-character budget`,
      );
      return UNKNOWN_STRING;
    }
    return {
      state: "present",
      value: joinDirectoryAndFile(directory.value, name.value),
    };
  }
  if (directory.state === "unresolved") return UNRESOLVED_STRING;
  if (directory.state === "unknown") return UNKNOWN_STRING;
  if (!tryConsumeExpandedChars(budget, name.value.length)) {
    issues.push(
      "string_budget",
      `Expanded file path exceeded ${MAX_DWARF_LINE_EXPANDED_STRING_CHARS}-character budget`,
    );
    return UNKNOWN_STRING;
  }
  return name;
};

type DecodedFormValue =
  | {
      readonly kind: "string";
      readonly fact: DwarfLineStringFact;
      readonly nonEmpty: boolean;
    }
  | { readonly kind: "uint"; readonly value: bigint }
  | { readonly kind: "bytes"; readonly bytes: Buffer }
  | { readonly kind: "other" };

const readIndirectForm = (
  cursor: DwarfCursor,
  issues: ProgramIssueCollector,
): number | null => {
  let form = DW_FORM_INDIRECT;
  for (let depth = 0; depth < MAX_INDIRECTION_DEPTH; depth += 1) {
    const next = readUleb(cursor);
    if (next === null) {
      issues.push("truncated_header", "Truncated DW_FORM_indirect code");
      return null;
    }
    const safe = toSafeInt(next);
    if (safe === null) {
      issues.push("unknown_form", "Out-of-range DW_FORM_indirect code");
      return null;
    }
    form = safe;
    if (form !== DW_FORM_INDIRECT) return form;
  }
  issues.push("malformed_header", "DW_FORM_indirect recursion limit exceeded");
  return null;
};

const readFixedUintForm = (
  cursor: DwarfCursor,
  form: number,
  addressSize: number,
): bigint | null => {
  if (form === DW_FORM_DATA1 || form === DW_FORM_FLAG) {
    const v = cursor.u8();
    return v === null ? null : BigInt(v);
  }
  if (form === DW_FORM_DATA2) {
    const v = cursor.u16();
    return v === null ? null : BigInt(v);
  }
  if (form === DW_FORM_DATA4) {
    const v = cursor.u32();
    return v === null ? null : BigInt(v);
  }
  if (form === DW_FORM_DATA8) {
    return cursor.u64();
  }
  if (form === DW_FORM_ADDR) {
    if (addressSize === 4) {
      const v = cursor.u32();
      return v === null ? null : BigInt(v);
    }
    if (addressSize === 8) return cursor.u64();
    if (addressSize === 2) {
      const v = cursor.u16();
      return v === null ? null : BigInt(v);
    }
  }
  return null;
};

const skipSizedBlock = (cursor: DwarfCursor, size: bigint | null): boolean => {
  if (size === null) return false;
  const count = toSafeInt(size);
  if (count === null) return false;
  return cursor.skip(count);
};

const readStrx3 = (cursor: DwarfCursor, little: boolean): bigint | null => {
  const b0 = cursor.u8();
  const b1 = cursor.u8();
  const b2 = cursor.u8();
  if (b0 === null || b1 === null || b2 === null) return null;
  return BigInt(
    little ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2,
  );
};

const decodeDwarf5Form = (
  rawForm: number,
  cursor: DwarfCursor,
  headerBytes: Buffer,
  offsetSize: 4 | 8,
  addressSize: number,
  contentType: number,
  strings: StringTableState,
  issues: ProgramIssueCollector,
): DecodedFormValue | null => {
  const form =
    rawForm === DW_FORM_INDIRECT ? readIndirectForm(cursor, issues) : rawForm;
  if (form === null) return null;

  const retainString = contentType !== DW_LNCT_LLVM_SOURCE;
  if (form === DW_FORM_STRING) {
    const res = readInlineStringFact(
      cursor,
      headerBytes,
      strings,
      issues,
      retainString,
    );
    return res.ok
      ? { kind: "string", fact: res.fact, nonEmpty: res.nonEmpty }
      : null;
  }
  if (form === DW_FORM_LINE_STRP || form === DW_FORM_STRP) {
    const strOffset = readOffsetBySize(cursor, offsetSize);
    if (strOffset === null) {
      issues.push(
        "truncated_header",
        "Truncated string offset in .debug_line header",
      );
      return null;
    }
    const isLineStr = form === DW_FORM_LINE_STRP;
    const res = readExternalStringAtOffset(
      isLineStr ? strings.lineStr : strings.str,
      isLineStr ? ".debug_line_str" : ".debug_str",
      strOffset,
      isLineStr ? strings.lineRelocated : strings.debugStrRelocated,
      strings,
      issues,
      retainString,
    );
    return {
      kind: "string",
      fact: res.fact,
      nonEmpty: res.nonEmpty,
    };
  }
  if (
    form === DW_FORM_STRX ||
    form === DW_FORM_STRX1 ||
    form === DW_FORM_STRX2 ||
    form === DW_FORM_STRX3 ||
    form === DW_FORM_STRX4
  ) {
    let idx: bigint | null = null;
    if (form === DW_FORM_STRX) idx = readUleb(cursor);
    else if (form === DW_FORM_STRX1) {
      const v = cursor.u8();
      idx = v === null ? null : BigInt(v);
    } else if (form === DW_FORM_STRX2) {
      const v = cursor.u16();
      idx = v === null ? null : BigInt(v);
    } else if (form === DW_FORM_STRX3) idx = readStrx3(cursor, strings.little);
    else {
      const v = cursor.u32();
      idx = v === null ? null : BigInt(v);
    }
    if (idx === null) {
      issues.push("truncated_header", "Truncated DW_FORM_strx index");
      return null;
    }
    const res = resolveStrxIndex(idx, strings, issues, retainString);
    return {
      kind: "string",
      fact: res.fact,
      nonEmpty: res.nonEmpty,
    };
  }
  if (form === DW_FORM_DATA16) {
    const bytes = readRawBytes(cursor, 16);
    if (bytes === null) {
      issues.push("truncated_header", "Truncated DW_FORM_data16 value");
      return null;
    }
    return { kind: "bytes", bytes };
  }
  if (form === DW_FORM_UDATA) {
    const v = readUleb(cursor);
    if (v === null) {
      issues.push("truncated_header", "Truncated DW_FORM_udata value");
      return null;
    }
    return { kind: "uint", value: v };
  }
  if (form === DW_FORM_SDATA) {
    const v = readSleb(cursor);
    if (v === null) {
      issues.push("truncated_header", "Truncated DW_FORM_sdata value");
      return null;
    }
    return { kind: "uint", value: v < 0n ? 0n : v };
  }
  if (
    form === DW_FORM_DATA1 ||
    form === DW_FORM_DATA2 ||
    form === DW_FORM_DATA4 ||
    form === DW_FORM_DATA8 ||
    form === DW_FORM_FLAG ||
    form === DW_FORM_ADDR
  ) {
    const v = readFixedUintForm(cursor, form, addressSize);
    if (v === null) {
      issues.push(
        "truncated_header",
        "Truncated scalar form in .debug_line header",
      );
      return null;
    }
    return { kind: "uint", value: v };
  }
  if (form === DW_FORM_FLAG_PRESENT) {
    return { kind: "uint", value: 1n };
  }
  if (
    form === DW_FORM_BLOCK1 ||
    form === DW_FORM_BLOCK2 ||
    form === DW_FORM_BLOCK4 ||
    form === DW_FORM_BLOCK ||
    form === DW_FORM_EXPRLOC
  ) {
    const len =
      form === DW_FORM_BLOCK1
        ? (() => {
            const v = cursor.u8();
            return v === null ? null : BigInt(v);
          })()
        : form === DW_FORM_BLOCK2
          ? (() => {
              const v = cursor.u16();
              return v === null ? null : BigInt(v);
            })()
          : form === DW_FORM_BLOCK4
            ? (() => {
                const v = cursor.u32();
                return v === null ? null : BigInt(v);
              })()
            : readUleb(cursor);
    if (!skipSizedBlock(cursor, len)) {
      issues.push(
        "truncated_header",
        "Truncated block form in .debug_line header",
      );
      return null;
    }
    return { kind: "other" };
  }
  issues.push(
    "unknown_form",
    `Unsupported DWARF 5 line header form 0x${form.toString(16)}`,
  );
  return null;
};

interface FormatPair {
  readonly contentType: number;
  readonly form: number;
}

const readV5FormatDescriptor = (
  cursor: DwarfCursor,
  budget: SharedBudget,
  issues: ProgramIssueCollector,
  label: string,
): readonly FormatPair[] | null => {
  const columnCount = cursor.u8();
  if (columnCount === null) {
    issues.push("truncated_header", `Truncated DWARF 5 ${label} format count`);
    return null;
  }
  if (columnCount > MAX_DWARF_LINE_FORMAT_COLUMNS) {
    issues.push(
      "header_entry_budget",
      `DWARF 5 ${label} format exceeds ${MAX_DWARF_LINE_FORMAT_COLUMNS} columns`,
    );
    return null;
  }
  const pairs: FormatPair[] = [];
  for (let i = 0; i < columnCount; i += 1) {
    if (!consumeStep(budget)) {
      issues.push(
        "decode_budget",
        `Stopped after ${MAX_DWARF_LINE_PROGRAM_STEPS} line-program decoding steps`,
      );
      return null;
    }
    const ct = readUleb(cursor);
    const form = readUleb(cursor);
    if (ct === null || form === null) {
      issues.push("truncated_header", `Truncated DWARF 5 ${label} format pair`);
      return null;
    }
    const contentType = toSafeInt(ct);
    const formCode = toSafeInt(form);
    if (contentType === null || formCode === null) {
      issues.push("malformed_header", `Invalid DWARF 5 ${label} format code`);
      return null;
    }
    pairs.push({ contentType, form: formCode });
  }
  return pairs;
};

const formatMd5Hex = (bytes: Buffer): string => {
  let out = "";
  for (const byte of bytes) {
    out += byteToHex(byte);
  }
  return out;
};

const buildFileEntry = (
  index: number,
  name: DwarfLineStringFact,
  directoryIndex: number | null,
  mtime: DwarfLineNumberFact,
  size: DwarfLineNumberFact,
  md5Hex: string | null,
  sourcePresent: boolean,
  definedByOpcode: boolean,
  directories: readonly DwarfLineDirectory[],
  zeroBased: boolean,
  budget: SharedBudget,
  issues: ProgramIssueCollector,
): DwarfLineFile => {
  let directory: DwarfLineStringFact = ABSENT_STRING;
  if (directoryIndex !== null) {
    if (zeroBased) {
      const entry = directories[directoryIndex];
      if (entry === undefined) {
        issues.push(
          "value_out_of_range",
          `File entry ${index} references missing directory index ${directoryIndex}`,
        );
        directory = UNKNOWN_STRING;
      } else {
        directory = entry.path;
      }
    } else if (directoryIndex > 0) {
      const entry = directories[directoryIndex - 1];
      if (entry === undefined) {
        issues.push(
          "value_out_of_range",
          `File entry ${index} references missing directory index ${directoryIndex}`,
        );
        directory = UNKNOWN_STRING;
      } else {
        directory = entry.path;
      }
    }
  }
  if (
    directory.state === "present" &&
    directory.value !== null &&
    !tryConsumeExpandedChars(budget, directory.value.length)
  ) {
    issues.push(
      "string_budget",
      `Repeated directory string exceeded ${MAX_DWARF_LINE_EXPANDED_STRING_CHARS}-character expansion budget`,
    );
    directory = UNKNOWN_STRING;
  }
  const path = computeCombinedPath(
    name,
    directoryIndex,
    directory,
    zeroBased,
    budget,
    issues,
  );
  return {
    index,
    name,
    directory_index: directoryIndex,
    directory,
    path,
    mtime,
    size,
    md5_hex: md5Hex,
    source_present: sourcePresent,
    defined_by_opcode: definedByOpcode,
  };
};

const readV5Tables = (
  cursor: DwarfCursor,
  headerBytes: Buffer,
  offsetSize: 4 | 8,
  addressSize: number,
  strings: StringTableState,
  budget: SharedBudget,
  issues: ProgramIssueCollector,
  directories: DwarfLineDirectory[],
  files: DwarfLineFile[],
): boolean => {
  const dirFormats = readV5FormatDescriptor(
    cursor,
    budget,
    issues,
    "directory",
  );
  if (dirFormats === null) return false;
  const dirCountRaw = readUleb(cursor);
  if (dirCountRaw === null) {
    issues.push("truncated_header", "Truncated DWARF 5 directory count");
    return false;
  }
  const dirCount = toSafeInt(dirCountRaw);
  if (dirCount === null || dirCount > MAX_DWARF_LINE_HEADER_ENTRIES) {
    issues.push(
      "header_entry_budget",
      `Directory count exceeds ${MAX_DWARF_LINE_HEADER_ENTRIES} entry cap`,
    );
    return false;
  }
  for (let i = 0; i < dirCount; i += 1) {
    if (!consumeHeaderEntry(budget, issues)) return false;
    let dirPath: DwarfLineStringFact = ABSENT_STRING;
    for (const col of dirFormats) {
      if (!consumeStep(budget)) {
        issues.push(
          "decode_budget",
          `Stopped after ${MAX_DWARF_LINE_PROGRAM_STEPS} line-program decoding steps`,
        );
        return false;
      }
      const decoded = decodeDwarf5Form(
        col.form,
        cursor,
        headerBytes,
        offsetSize,
        addressSize,
        col.contentType,
        strings,
        issues,
      );
      if (decoded === null) return false;
      if (col.contentType === DW_LNCT_PATH && decoded.kind === "string") {
        dirPath = decoded.fact;
      } else if (
        col.contentType !== DW_LNCT_PATH &&
        col.contentType !== DW_LNCT_LLVM_SOURCE
      ) {
        issues.push(
          "unknown_content_type",
          `Unknown directory entry content type 0x${col.contentType.toString(16)}`,
        );
      }
    }
    directories.push({ index: i, path: dirPath });
  }

  const fileFormats = readV5FormatDescriptor(cursor, budget, issues, "file");
  if (fileFormats === null) return false;
  const fileCountRaw = readUleb(cursor);
  if (fileCountRaw === null) {
    issues.push("truncated_header", "Truncated DWARF 5 file count");
    return false;
  }
  const fileCount = toSafeInt(fileCountRaw);
  if (fileCount === null || fileCount > MAX_DWARF_LINE_HEADER_ENTRIES) {
    issues.push(
      "header_entry_budget",
      `File count exceeds ${MAX_DWARF_LINE_HEADER_ENTRIES} entry cap`,
    );
    return false;
  }
  for (let i = 0; i < fileCount; i += 1) {
    if (!consumeHeaderEntry(budget, issues)) return false;
    let name: DwarfLineStringFact = ABSENT_STRING;
    let directoryIndex: number | null = null;
    let mtime: DwarfLineNumberFact = ABSENT_NUMBER;
    let size: DwarfLineNumberFact = ABSENT_NUMBER;
    let md5Hex: string | null = null;
    let sourcePresent = false;

    for (const col of fileFormats) {
      if (!consumeStep(budget)) {
        issues.push(
          "decode_budget",
          `Stopped after ${MAX_DWARF_LINE_PROGRAM_STEPS} line-program decoding steps`,
        );
        return false;
      }
      const decoded = decodeDwarf5Form(
        col.form,
        cursor,
        headerBytes,
        offsetSize,
        addressSize,
        col.contentType,
        strings,
        issues,
      );
      if (decoded === null) return false;
      if (col.contentType === DW_LNCT_PATH && decoded.kind === "string") {
        name = decoded.fact;
      } else if (
        col.contentType === DW_LNCT_DIRECTORY_INDEX &&
        decoded.kind === "uint"
      ) {
        const idx = toSafeInt(decoded.value);
        if (idx === null) {
          issues.push(
            "value_out_of_range",
            "Directory index exceeds safe integer",
          );
        } else {
          directoryIndex = idx;
        }
      } else if (
        col.contentType === DW_LNCT_TIMESTAMP &&
        decoded.kind === "uint"
      ) {
        const ts = toSafeInt(decoded.value);
        if (ts === null) {
          issues.push("value_out_of_range", "Timestamp exceeds safe integer");
          mtime = UNKNOWN_NUMBER;
        } else {
          mtime = { state: "present", value: ts };
        }
      } else if (col.contentType === DW_LNCT_SIZE && decoded.kind === "uint") {
        const sz = toSafeInt(decoded.value);
        if (sz === null) {
          issues.push("value_out_of_range", "File size exceeds safe integer");
          size = UNKNOWN_NUMBER;
        } else {
          size = { state: "present", value: sz };
        }
      } else if (col.contentType === DW_LNCT_MD5 && decoded.kind === "bytes") {
        md5Hex = formatMd5Hex(decoded.bytes);
      } else if (
        col.contentType === DW_LNCT_LLVM_SOURCE &&
        decoded.kind === "string"
      ) {
        if (decoded.nonEmpty) sourcePresent = true;
      } else if (
        col.contentType !== DW_LNCT_PATH &&
        col.contentType !== DW_LNCT_DIRECTORY_INDEX &&
        col.contentType !== DW_LNCT_TIMESTAMP &&
        col.contentType !== DW_LNCT_SIZE &&
        col.contentType !== DW_LNCT_MD5 &&
        col.contentType !== DW_LNCT_LLVM_SOURCE
      ) {
        issues.push(
          "unknown_content_type",
          `Unknown file entry content type 0x${col.contentType.toString(16)}`,
        );
      }
    }
    files.push(
      buildFileEntry(
        i,
        name,
        directoryIndex,
        mtime,
        size,
        md5Hex,
        sourcePresent,
        false,
        directories,
        true,
        budget,
        issues,
      ),
    );
  }
  return true;
};

const readLegacyTables = (
  cursor: DwarfCursor,
  headerBytes: Buffer,
  strings: StringTableState,
  budget: SharedBudget,
  issues: ProgramIssueCollector,
  directories: DwarfLineDirectory[],
  files: DwarfLineFile[],
): boolean => {
  while (cursor.remaining() > 0) {
    if (headerBytes[cursor.offset] === 0) {
      cursor.skip(1);
      break;
    }
    if (directories.length >= MAX_DWARF_LINE_HEADER_ENTRIES) {
      issues.push(
        "header_entry_budget",
        `Directory count exceeds ${MAX_DWARF_LINE_HEADER_ENTRIES} entry cap`,
      );
      return false;
    }
    if (!consumeHeaderEntry(budget, issues)) return false;
    const res = readInlineStringFact(
      cursor,
      headerBytes,
      strings,
      issues,
      true,
    );
    if (!res.ok) return false;
    directories.push({ index: directories.length + 1, path: res.fact });
  }

  while (cursor.remaining() > 0) {
    if (headerBytes[cursor.offset] === 0) {
      cursor.skip(1);
      break;
    }
    if (files.length >= MAX_DWARF_LINE_HEADER_ENTRIES) {
      issues.push(
        "header_entry_budget",
        `File count exceeds ${MAX_DWARF_LINE_HEADER_ENTRIES} entry cap`,
      );
      return false;
    }
    if (!consumeHeaderEntry(budget, issues)) return false;
    const nameRes = readInlineStringFact(
      cursor,
      headerBytes,
      strings,
      issues,
      true,
    );
    if (!nameRes.ok) return false;
    const dirRaw = readUleb(cursor);
    const mtimeRaw = readUleb(cursor);
    const sizeRaw = readUleb(cursor);
    if (dirRaw === null || mtimeRaw === null || sizeRaw === null) {
      issues.push("truncated_header", "Truncated DWARF file entry");
      return false;
    }
    const dirIndex = toSafeInt(dirRaw);
    const mtimeVal = toSafeInt(mtimeRaw);
    const sizeVal = toSafeInt(sizeRaw);
    if (dirIndex === null) {
      issues.push("value_out_of_range", "Directory index exceeds safe integer");
    }
    files.push(
      buildFileEntry(
        files.length + 1,
        nameRes.fact,
        dirIndex,
        mtimeVal === null
          ? UNKNOWN_NUMBER
          : { state: "present", value: mtimeVal },
        sizeVal === null
          ? UNKNOWN_NUMBER
          : { state: "present", value: sizeVal },
        null,
        false,
        false,
        directories,
        false,
        budget,
        issues,
      ),
    );
  }
  return true;
};

interface ProgramHeader {
  readonly ok: boolean;
  readonly version: number | null;
  readonly addressSize: number | null;
  readonly segmentSelectorSize: number | null;
  readonly minInstLen: number | null;
  readonly maxOpsPerInst: number | null;
  readonly defaultIsStmt: boolean | null;
  readonly lineBase: number | null;
  readonly lineRange: number | null;
  readonly opcodeBase: number | null;
  readonly standardOpcodeLengths: readonly number[];
  readonly opcodesStart: number;
  readonly directories: DwarfLineDirectory[];
  readonly files: DwarfLineFile[];
  readonly headerTruncated: boolean;
}

const parseProgramHeader = (
  programBytes: Buffer,
  offsetSize: 4 | 8,
  headerOffsetInProgram: number,
  little: boolean,
  defaultAddressSize: 4 | 8,
  strings: StringTableState,
  budget: SharedBudget,
  issues: ProgramIssueCollector,
): ProgramHeader => {
  const directories: DwarfLineDirectory[] = [];
  const files: DwarfLineFile[] = [];
  const cursor = new DwarfCursor(programBytes, little);
  cursor.skip(headerOffsetInProgram);

  const version = cursor.u16();
  if (version === null) {
    issues.push("truncated_header", "Truncated .debug_line header version");
    return {
      ok: false,
      version: null,
      addressSize: null,
      segmentSelectorSize: null,
      minInstLen: null,
      maxOpsPerInst: null,
      defaultIsStmt: null,
      lineBase: null,
      lineRange: null,
      opcodeBase: null,
      standardOpcodeLengths: [],
      opcodesStart: programBytes.length,
      directories,
      files,
      headerTruncated: true,
    };
  }
  if (version < 2 || version > 5) {
    issues.push(
      "unsupported_version",
      `Unsupported DWARF line-program version ${version}`,
    );
    return {
      ok: false,
      version,
      addressSize: null,
      segmentSelectorSize: null,
      minInstLen: null,
      maxOpsPerInst: null,
      defaultIsStmt: null,
      lineBase: null,
      lineRange: null,
      opcodeBase: null,
      standardOpcodeLengths: [],
      opcodesStart: programBytes.length,
      directories,
      files,
      headerTruncated: false,
    };
  }

  let addressSize: number | null = null;
  let segmentSelectorSize: number | null = null;
  if (version === 5) {
    addressSize = cursor.u8();
    segmentSelectorSize = cursor.u8();
    if (addressSize === null || segmentSelectorSize === null) {
      issues.push("truncated_header", "Truncated DWARF 5 address size fields");
      return {
        ok: false,
        version,
        addressSize,
        segmentSelectorSize,
        minInstLen: null,
        maxOpsPerInst: null,
        defaultIsStmt: null,
        lineBase: null,
        lineRange: null,
        opcodeBase: null,
        standardOpcodeLengths: [],
        opcodesStart: programBytes.length,
        directories,
        files,
        headerTruncated: true,
      };
    }
    if (addressSize !== 2 && addressSize !== 4 && addressSize !== 8) {
      issues.push(
        "unsupported_address_size",
        `Unsupported DWARF 5 address_size ${addressSize}`,
      );
      return {
        ok: false,
        version,
        addressSize,
        segmentSelectorSize,
        minInstLen: null,
        maxOpsPerInst: null,
        defaultIsStmt: null,
        lineBase: null,
        lineRange: null,
        opcodeBase: null,
        standardOpcodeLengths: [],
        opcodesStart: programBytes.length,
        directories,
        files,
        headerTruncated: false,
      };
    }
    if (segmentSelectorSize !== 0) {
      issues.push(
        "unsupported_segment_selector",
        `Unsupported DWARF 5 segment_selector_size ${segmentSelectorSize}`,
      );
      return {
        ok: false,
        version,
        addressSize,
        segmentSelectorSize,
        minInstLen: null,
        maxOpsPerInst: null,
        defaultIsStmt: null,
        lineBase: null,
        lineRange: null,
        opcodeBase: null,
        standardOpcodeLengths: [],
        opcodesStart: programBytes.length,
        directories,
        files,
        headerTruncated: false,
      };
    }
  }

  const headerLengthRaw = readOffsetBySize(cursor, offsetSize);
  if (headerLengthRaw === null) {
    issues.push("truncated_header", "Truncated .debug_line header_length");
    return {
      ok: false,
      version,
      addressSize,
      segmentSelectorSize,
      minInstLen: null,
      maxOpsPerInst: null,
      defaultIsStmt: null,
      lineBase: null,
      lineRange: null,
      opcodeBase: null,
      standardOpcodeLengths: [],
      opcodesStart: programBytes.length,
      directories,
      files,
      headerTruncated: true,
    };
  }
  const headerLength = toSafeInt(headerLengthRaw);
  const afterHeaderLength = cursor.offset;
  if (
    headerLength === null ||
    afterHeaderLength + headerLength > programBytes.length
  ) {
    issues.push(
      "truncated_header",
      "Line-program header_length extends past program end",
    );
    return {
      ok: false,
      version,
      addressSize,
      segmentSelectorSize,
      minInstLen: null,
      maxOpsPerInst: null,
      defaultIsStmt: null,
      lineBase: null,
      lineRange: null,
      opcodeBase: null,
      standardOpcodeLengths: [],
      opcodesStart: programBytes.length,
      directories,
      files,
      headerTruncated: true,
    };
  }

  const headerEnd = afterHeaderLength + headerLength;
  const hdrBytes = programBytes.subarray(0, headerEnd);
  const hdr = new DwarfCursor(hdrBytes, little);
  hdr.skip(afterHeaderLength);

  const minInstLen = hdr.u8();
  const maxOpsPerInst = version >= 4 ? hdr.u8() : 1;
  const defaultIsStmtRaw = hdr.u8();
  const lineBaseRaw = hdr.u8();
  const lineRange = hdr.u8();
  const opcodeBase = hdr.u8();

  if (
    minInstLen === null ||
    maxOpsPerInst === null ||
    defaultIsStmtRaw === null ||
    lineBaseRaw === null ||
    lineRange === null ||
    opcodeBase === null
  ) {
    issues.push("truncated_header", "Truncated .debug_line prologue fields");
    return {
      ok: false,
      version,
      addressSize,
      segmentSelectorSize,
      minInstLen,
      maxOpsPerInst,
      defaultIsStmt: defaultIsStmtRaw === null ? null : defaultIsStmtRaw !== 0,
      lineBase: lineBaseRaw === null ? null : (lineBaseRaw << 24) >> 24,
      lineRange,
      opcodeBase,
      standardOpcodeLengths: [],
      opcodesStart: programBytes.length,
      directories,
      files,
      headerTruncated: true,
    };
  }

  const lineBase = (lineBaseRaw << 24) >> 24;
  const defaultIsStmt = defaultIsStmtRaw !== 0;

  if (opcodeBase === 0 || opcodeBase - 1 > MAX_DWARF_LINE_STANDARD_OPCODES) {
    issues.push("malformed_header", `Invalid opcode_base ${opcodeBase}`);
    return {
      ok: false,
      version,
      addressSize,
      segmentSelectorSize,
      minInstLen,
      maxOpsPerInst,
      defaultIsStmt,
      lineBase,
      lineRange,
      opcodeBase,
      standardOpcodeLengths: [],
      opcodesStart: programBytes.length,
      directories,
      files,
      headerTruncated: false,
    };
  }

  const standardOpcodeLengths: number[] = [];
  for (let i = 1; i < opcodeBase; i += 1) {
    const arity = hdr.u8();
    if (arity === null) {
      issues.push("truncated_header", "Truncated standard_opcode_lengths");
      return {
        ok: false,
        version,
        addressSize,
        segmentSelectorSize,
        minInstLen,
        maxOpsPerInst,
        defaultIsStmt,
        lineBase,
        lineRange,
        opcodeBase,
        standardOpcodeLengths,
        opcodesStart: programBytes.length,
        directories,
        files,
        headerTruncated: true,
      };
    }
    standardOpcodeLengths.push(arity);
  }

  if (minInstLen === 0 || maxOpsPerInst === 0) {
    issues.push(
      "malformed_header",
      "minimum_instruction_length and maximum_operations_per_instruction must be non-zero",
    );
    return {
      ok: false,
      version,
      addressSize,
      segmentSelectorSize,
      minInstLen,
      maxOpsPerInst,
      defaultIsStmt,
      lineBase,
      lineRange,
      opcodeBase,
      standardOpcodeLengths,
      opcodesStart: programBytes.length,
      directories,
      files,
      headerTruncated: false,
    };
  }

  const effAddressSize = addressSize ?? defaultAddressSize;
  const tablesOk =
    version === 5
      ? readV5Tables(
          hdr,
          hdrBytes,
          offsetSize,
          effAddressSize,
          strings,
          budget,
          issues,
          directories,
          files,
        )
      : readLegacyTables(
          hdr,
          hdrBytes,
          strings,
          budget,
          issues,
          directories,
          files,
        );

  return {
    ok: tablesOk,
    version,
    addressSize,
    segmentSelectorSize,
    minInstLen,
    maxOpsPerInst,
    defaultIsStmt,
    lineBase,
    lineRange,
    opcodeBase,
    standardOpcodeLengths,
    opcodesStart: headerEnd,
    directories,
    files,
    headerTruncated: !tablesOk,
  };
};

interface MachineRegisters {
  address: bigint;
  opIndex: number;
  file: number;
  line: number;
  column: number;
  isStmt: boolean;
  basicBlock: boolean;
  endSequence: boolean;
  prologueEnd: boolean;
  epilogueBegin: boolean;
  isa: number;
  discriminator: number;
}

const resetRegisters = (defaultIsStmt: boolean): MachineRegisters => ({
  address: 0n,
  opIndex: 0,
  file: 1,
  line: 1,
  column: 0,
  isStmt: defaultIsStmt,
  basicBlock: false,
  endSequence: false,
  prologueEnd: false,
  epilogueBegin: false,
  isa: 0,
  discriminator: 0,
});

const advancePc = (
  regs: MachineRegisters,
  operationAdvance: bigint,
  minInstLen: number,
  maxOpsPerInst: number,
  issues: ProgramIssueCollector,
): void => {
  const maxOps = BigInt(maxOpsPerInst);
  const totalOps = BigInt(regs.opIndex) + operationAdvance;
  const nextAddress = regs.address + BigInt(minInstLen) * (totalOps / maxOps);
  if (nextAddress > MAX_U64) {
    issues.push(
      "value_out_of_range",
      "Computed line-program PC overflowed 64-bit unsigned range",
    );
    regs.address = nextAddress & MAX_U64;
  } else {
    regs.address = nextAddress;
  }
  regs.opIndex = Number(totalOps % maxOps);
};

const lookupFileEntry = (
  files: readonly DwarfLineFile[],
  fileIndex: number,
  zeroBased: boolean,
): DwarfLineFile | undefined => {
  if (zeroBased) return files[fileIndex];
  return fileIndex > 0 ? files[fileIndex - 1] : undefined;
};

const readExtendedAddress = (
  cursor: DwarfCursor,
  size: number,
  little: boolean,
): bigint | null => {
  if (size === 4) {
    const v = cursor.u32();
    return v === null ? null : BigInt(v);
  }
  if (size === 8) return cursor.u64();
  if (size === 2) {
    const v = cursor.u16();
    return v === null ? null : BigInt(v);
  }
  if (size === 1) {
    const v = cursor.u8();
    return v === null ? null : BigInt(v);
  }
  if (size > 8) return null;
  const bytes = readRawBytes(cursor, size);
  if (bytes === null) return null;
  let value = 0n;
  if (little) {
    for (let i = bytes.length - 1; i >= 0; i -= 1) {
      value = (value << 8n) | BigInt(bytes[i] ?? 0);
    }
  } else {
    for (const byte of bytes) {
      value = (value << 8n) | BigInt(byte);
    }
  }
  return value;
};

interface RunProgramResult {
  readonly totalRows: number;
  readonly retainedRows: number;
  readonly addressesUnresolved: boolean;
  readonly sequences: readonly DwarfLineSequence[];
  readonly rowsOmitted: boolean;
  readonly stopReason:
    | "complete"
    | "max_rows"
    | "decode_budget"
    | "string_budget"
    | "aborted";
}

const runLineMachine = (
  programIndex: number,
  programOffset: number,
  programBytes: Buffer,
  header: ProgramHeader,
  little: boolean,
  strings: StringTableState,
  issues: ProgramIssueCollector,
  budget: SharedBudget,
  retainedRowsOut: DwarfLineRow[],
  maxRows: number,
  retainRowsForProgram: boolean,
  addressTargets: readonly AddressMatchTarget[] | null,
): RunProgramResult => {
  const zeroBased = header.version === 5;
  const cursor = new DwarfCursor(programBytes, little);
  cursor.skip(header.opcodesStart);

  const defaultIsStmt = header.defaultIsStmt ?? true;
  const minInstLen = header.minInstLen ?? 1;
  const maxOpsPerInst = header.maxOpsPerInst ?? 1;
  const lineBase = header.lineBase ?? -5;
  const lineRange = header.lineRange ?? 14;
  const opcodeBase = header.opcodeBase ?? 13;

  let regs = resetRegisters(defaultIsStmt);
  let totalRows = 0;
  let totalSequences = 0;
  let retainedRows = 0;
  let addressesUnresolved = false;
  let aborted = false;
  let rowLimitHit = false;
  let haltedByMaxRows = false;
  let haltedByRowStringBudget = false;
  let seqStartAddr: bigint | null = null;
  let seqEndAddr: bigint | null = null;
  let seqRowCount = 0;
  let currentSequenceRows: SequenceRowRecord[] = [];
  let currentMonotonic = true;
  const sequences: DwarfLineSequence[] = [];

  const finalizeSequence = (hasEndSequence: boolean): void => {
    if (seqRowCount === 0) return;
    const seqIdx = totalSequences;
    totalSequences += 1;
    const startAddr =
      seqStartAddr !== null ? formatDwarfLineAddress(seqStartAddr) : null;
    const endAddr =
      seqEndAddr !== null ? formatDwarfLineAddress(seqEndAddr) : null;
    if (budget.sequencesRemaining > 0) {
      budget.sequencesRemaining -= 1;
      sequences.push({
        sequence_index: seqIdx,
        start_address: startAddr,
        end_address: endAddr,
        has_end_sequence: hasEndSequence,
        row_start: totalRows - seqRowCount,
        row_count: seqRowCount,
      });
    } else {
      budget.sequenceCountBudgetHit = true;
    }
    if (addressTargets !== null && !addressMatchingStopped(budget)) {
      const seqIndex: DecodedSequenceIndex = {
        programIndex,
        programOffset,
        sequenceIndex: seqIdx,
        hasEndSequence,
        monotonic: currentMonotonic,
        rows: currentSequenceRows,
        endAddress: seqEndAddr,
      };
      for (const entry of addressTargets) {
        if (addressMatchingStopped(budget)) break;
        if (currentMonotonic) {
          matchSequenceMonotonic(seqIndex, entry.target, entry.matches, budget);
        } else {
          matchSequenceLinear(seqIndex, entry.target, entry.matches, budget);
        }
      }
    }
    seqStartAddr = null;
    seqEndAddr = null;
    seqRowCount = 0;
    currentSequenceRows = [];
    currentMonotonic = true;
  };

  const emitRow = (): "ok" | "max_rows" | "decode_budget" | "string_budget" => {
    if (
      retainRowsForProgram &&
      maxRows > 0 &&
      retainedRowsOut.length >= maxRows
    ) {
      rowLimitHit = true;
      if (addressTargets === null) {
        haltedByMaxRows = true;
        return "max_rows";
      }
    }

    const needRowDetails =
      addressTargets !== null ||
      (retainRowsForProgram && maxRows > 0 && retainedRowsOut.length < maxRows);
    const fileEntry = needRowDetails
      ? lookupFileEntry(header.files, regs.file, zeroBased)
      : undefined;
    const seqIndex = totalSequences;

    if (
      retainRowsForProgram &&
      maxRows > 0 &&
      retainedRowsOut.length < maxRows
    ) {
      const displayFile =
        fileEntry?.path.value ?? fileEntry?.name.value ?? null;
      if (
        displayFile !== null &&
        !tryConsumeExpandedChars(budget, displayFile.length)
      ) {
        issues.push(
          "string_budget",
          `Retained row string expansion exceeded ${MAX_DWARF_LINE_EXPANDED_STRING_CHARS}-character budget`,
        );
        if (addressTargets === null) {
          haltedByRowStringBudget = true;
          return "string_budget";
        }
      } else {
        retainedRows += 1;
        retainedRowsOut.push({
          program_index: programIndex,
          sequence_index: seqIndex,
          address: formatDwarfLineAddress(regs.address),
          op_index: regs.opIndex,
          file_index: regs.file,
          file: displayFile,
          line: regs.line,
          column: regs.column,
          is_stmt: regs.isStmt,
          basic_block: regs.basicBlock,
          end_sequence: regs.endSequence,
          prologue_end: regs.prologueEnd,
          epilogue_begin: regs.epilogueBegin,
          isa: regs.isa,
          discriminator: regs.discriminator,
        });
      }
    }

    if (addressTargets !== null) {
      if (currentSequenceRows.length >= MAX_DWARF_LINE_SEQUENCE_ROWS) {
        budget.sequenceBudgetHit = true;
        issues.push(
          "decode_budget",
          `Line sequence exceeded ${MAX_DWARF_LINE_SEQUENCE_ROWS} rows`,
        );
        return "decode_budget";
      }
      if (seqEndAddr !== null && regs.address < seqEndAddr) {
        currentMonotonic = false;
      }
      currentSequenceRows.push({
        programIndex,
        programOffset,
        sequenceIndex: seqIndex,
        address: regs.address,
        opIndex: regs.opIndex,
        fileIndex: regs.file,
        fileName: fileEntry?.name.value ?? null,
        directory: fileEntry?.directory.value ?? null,
        path: fileEntry?.path.value ?? null,
        md5Hex: fileEntry?.md5_hex ?? null,
        line: regs.line,
        column: regs.column,
        isStmt: regs.isStmt,
        basicBlock: regs.basicBlock,
        endSequence: regs.endSequence,
        prologueEnd: regs.prologueEnd,
        epilogueBegin: regs.epilogueBegin,
        isa: regs.isa,
        discriminator: regs.discriminator,
      });
    }

    totalRows += 1;
    if (seqStartAddr === null) seqStartAddr = regs.address;
    seqEndAddr = regs.address;
    seqRowCount += 1;
    return "ok";
  };

  while (cursor.remaining() > 0) {
    if (!consumeStep(budget)) {
      issues.push(
        "decode_budget",
        `Stopped after ${MAX_DWARF_LINE_PROGRAM_STEPS} line-program opcode steps`,
      );
      if (seqRowCount > 0) {
        finalizeSequence(false);
      }
      return {
        totalRows,
        retainedRows,
        addressesUnresolved,
        sequences,
        rowsOmitted: rowLimitHit,
        stopReason: "decode_budget",
      };
    }

    const opcode = cursor.u8();
    if (opcode === null) break;

    if (opcode === 0) {
      const extLenRaw = readUleb(cursor);
      if (extLenRaw === null) {
        issues.push("truncated_program", "Truncated extended opcode length");
        aborted = true;
        break;
      }
      const extLen = toSafeInt(extLenRaw);
      if (extLen === null || extLen === 0) {
        issues.push(
          "malformed_opcode",
          "Extended opcode length must be positive",
        );
        aborted = true;
        break;
      }
      if (extLen > cursor.remaining()) {
        issues.push(
          "truncated_program",
          "Extended opcode extends past program end",
        );
        aborted = true;
        break;
      }
      const extStart = cursor.offset;
      const extSub = programBytes.subarray(extStart, extStart + extLen);
      cursor.skip(extLen);
      const extCursor = new DwarfCursor(extSub, little);
      const extOpcode = extCursor.u8();
      if (extOpcode === null) {
        issues.push("malformed_opcode", "Missing extended opcode selector");
        aborted = true;
        break;
      }
      if (extOpcode === DW_LNE_END_SEQUENCE) {
        regs.endSequence = true;
        if (emitRow() !== "ok") {
          break;
        }
        finalizeSequence(true);
        regs = resetRegisters(defaultIsStmt);
      } else if (extOpcode === DW_LNE_SET_ADDRESS) {
        const addrBytes = extLen - 1;
        if (header.addressSize !== null && addrBytes !== header.addressSize) {
          issues.push(
            "unsupported_address_size",
            `DW_LNE_set_address length ${addrBytes} does not match header address_size ${header.addressSize}`,
          );
          aborted = true;
          break;
        }
        if (addrBytes !== 2 && addrBytes !== 4 && addrBytes !== 8) {
          issues.push(
            "unsupported_address_size",
            `Unsupported DW_LNE_set_address width ${addrBytes}`,
          );
          aborted = true;
          break;
        }
        const addr = readExtendedAddress(extCursor, addrBytes, little);
        if (addr === null) {
          issues.push(
            "malformed_opcode",
            "Truncated DW_LNE_set_address operand",
          );
          aborted = true;
          break;
        }
        regs.address = addr;
        regs.opIndex = 0;
        if (strings.lineRelocated) {
          addressesUnresolved = true;
          issues.push(
            "unapplied_relocation",
            "Unapplied ET_REL relocations leave DW_LNE_set_address values at object placeholder offsets",
          );
        }
      } else if (extOpcode === DW_LNE_DEFINE_FILE) {
        if (header.files.length >= MAX_DWARF_LINE_HEADER_ENTRIES) {
          issues.push(
            "header_entry_budget",
            `File entries exceed ${MAX_DWARF_LINE_HEADER_ENTRIES} cap`,
          );
          aborted = true;
          break;
        }
        if (!consumeHeaderEntry(budget, issues)) {
          break;
        }
        const nameRes = readInlineStringFact(
          extCursor,
          extSub,
          strings,
          issues,
          true,
        );
        const dirRaw = readUleb(extCursor);
        const mtimeRaw = readUleb(extCursor);
        const sizeRaw = readUleb(extCursor);
        if (
          !nameRes.ok ||
          dirRaw === null ||
          mtimeRaw === null ||
          sizeRaw === null
        ) {
          issues.push(
            "malformed_opcode",
            "Truncated DW_LNE_define_file operand",
          );
          aborted = true;
          break;
        }
        const dirIdx = toSafeInt(dirRaw);
        const mtimeVal = toSafeInt(mtimeRaw);
        const sizeVal = toSafeInt(sizeRaw);
        header.files.push(
          buildFileEntry(
            zeroBased ? header.files.length : header.files.length + 1,
            nameRes.fact,
            dirIdx,
            mtimeVal === null
              ? UNKNOWN_NUMBER
              : { state: "present", value: mtimeVal },
            sizeVal === null
              ? UNKNOWN_NUMBER
              : { state: "present", value: sizeVal },
            null,
            false,
            true,
            header.directories,
            zeroBased,
            budget,
            issues,
          ),
        );
      } else if (extOpcode === DW_LNE_SET_DISCRIMINATOR) {
        const discRaw = readUleb(extCursor);
        if (discRaw === null) {
          issues.push(
            "malformed_opcode",
            "Truncated DW_LNE_set_discriminator operand",
          );
          aborted = true;
          break;
        }
        const disc = toSafeInt(discRaw);
        if (disc === null) {
          issues.push(
            "value_out_of_range",
            "Discriminator exceeds safe integer",
          );
          regs.discriminator = Number.MAX_SAFE_INTEGER;
        } else {
          regs.discriminator = disc;
        }
      }
      continue;
    }

    if (opcode < opcodeBase) {
      if (opcode === DW_LNS_COPY) {
        if (emitRow() !== "ok") break;
        regs.discriminator = 0;
        regs.basicBlock = false;
        regs.prologueEnd = false;
        regs.epilogueBegin = false;
      } else if (opcode === DW_LNS_ADVANCE_PC) {
        const adv = readUleb(cursor);
        if (adv === null) {
          issues.push(
            "truncated_program",
            "Truncated DW_LNS_advance_pc operand",
          );
          aborted = true;
          break;
        }
        advancePc(regs, adv, minInstLen, maxOpsPerInst, issues);
      } else if (opcode === DW_LNS_ADVANCE_LINE) {
        const deltaRaw = readSleb(cursor);
        if (deltaRaw === null) {
          issues.push(
            "truncated_program",
            "Truncated DW_LNS_advance_line operand",
          );
          aborted = true;
          break;
        }
        const delta = toSignedSafeInt(deltaRaw);
        if (delta === null || !Number.isSafeInteger(regs.line + delta)) {
          issues.push(
            "value_out_of_range",
            "Line number delta overflowed safe integer",
          );
          aborted = true;
          break;
        }
        regs.line += delta;
      } else if (opcode === DW_LNS_SET_FILE) {
        const fRaw = readUleb(cursor);
        if (fRaw === null) {
          issues.push("truncated_program", "Truncated DW_LNS_set_file operand");
          aborted = true;
          break;
        }
        const f = toSafeInt(fRaw);
        if (f === null) {
          issues.push("value_out_of_range", "File index exceeds safe integer");
          aborted = true;
          break;
        }
        regs.file = f;
      } else if (opcode === DW_LNS_SET_COLUMN) {
        const cRaw = readUleb(cursor);
        if (cRaw === null) {
          issues.push(
            "truncated_program",
            "Truncated DW_LNS_set_column operand",
          );
          aborted = true;
          break;
        }
        const c = toSafeInt(cRaw);
        if (c === null) {
          issues.push(
            "value_out_of_range",
            "Column number exceeds safe integer",
          );
          aborted = true;
          break;
        }
        regs.column = c;
      } else if (opcode === DW_LNS_NEGATE_STMT) {
        regs.isStmt = !regs.isStmt;
      } else if (opcode === DW_LNS_SET_BASIC_BLOCK) {
        regs.basicBlock = true;
      } else if (opcode === DW_LNS_CONST_ADD_PC) {
        if (lineRange === 0) {
          issues.push(
            "malformed_opcode",
            "DW_LNS_const_add_pc requires non-zero line_range",
          );
          aborted = true;
          break;
        }
        const opAdvance = BigInt(Math.floor((255 - opcodeBase) / lineRange));
        advancePc(regs, opAdvance, minInstLen, maxOpsPerInst, issues);
      } else if (opcode === DW_LNS_FIXED_ADVANCE_PC) {
        const adv = cursor.u16();
        if (adv === null) {
          issues.push(
            "truncated_program",
            "Truncated DW_LNS_fixed_advance_pc operand",
          );
          aborted = true;
          break;
        }
        const next = regs.address + BigInt(adv);
        if (next > MAX_U64) {
          issues.push(
            "value_out_of_range",
            "PC overflowed 64-bit unsigned range",
          );
          regs.address = next & MAX_U64;
        } else {
          regs.address = next;
        }
        regs.opIndex = 0;
      } else if (opcode === DW_LNS_SET_PROLOGUE_END) {
        regs.prologueEnd = true;
      } else if (opcode === DW_LNS_SET_EPILOGUE_BEGIN) {
        regs.epilogueBegin = true;
      } else if (opcode === DW_LNS_SET_ISA) {
        const isaRaw = readUleb(cursor);
        if (isaRaw === null) {
          issues.push("truncated_program", "Truncated DW_LNS_set_isa operand");
          aborted = true;
          break;
        }
        const isa = toSafeInt(isaRaw);
        if (isa === null) {
          issues.push(
            "value_out_of_range",
            "ISA register exceeds safe integer",
          );
          aborted = true;
          break;
        }
        regs.isa = isa;
      } else {
        const operandCount = header.standardOpcodeLengths[opcode - 1] ?? 0;
        for (let k = 0; k < operandCount; k += 1) {
          if (readUleb(cursor) === null) {
            issues.push(
              "truncated_program",
              `Truncated unknown standard opcode ${opcode} operand`,
            );
            aborted = true;
            break;
          }
        }
        if (aborted) break;
      }
      continue;
    }

    if (lineRange === 0) {
      issues.push(
        "malformed_opcode",
        "Special opcode requires non-zero line_range",
      );
      aborted = true;
      break;
    }
    const adjusted = opcode - opcodeBase;
    const opAdvance = BigInt(Math.floor(adjusted / lineRange));
    const lineDelta = lineBase + (adjusted % lineRange);
    advancePc(regs, opAdvance, minInstLen, maxOpsPerInst, issues);
    if (!Number.isSafeInteger(regs.line + lineDelta)) {
      issues.push(
        "value_out_of_range",
        "Line register overflowed safe integer",
      );
      aborted = true;
      break;
    }
    regs.line += lineDelta;
    if (emitRow() !== "ok") break;
    regs.basicBlock = false;
    regs.prologueEnd = false;
    regs.epilogueBegin = false;
    regs.discriminator = 0;
  }

  const budgetStopped =
    budget.stepBudgetHit ||
    budget.headerEntryBudgetHit ||
    budget.sequenceBudgetHit;
  if (seqRowCount > 0) {
    if (
      !haltedByMaxRows &&
      !haltedByRowStringBudget &&
      !aborted &&
      !budgetStopped
    ) {
      issues.push(
        "end_sequence_missing",
        "Line-number program ended without DW_LNE_end_sequence",
      );
    }
    finalizeSequence(false);
  }

  return {
    totalRows,
    retainedRows,
    addressesUnresolved,
    sequences,
    rowsOmitted: rowLimitHit,
    stopReason: budgetStopped
      ? "decode_budget"
      : haltedByRowStringBudget
        ? "string_budget"
        : aborted
          ? "aborted"
          : haltedByMaxRows
            ? "max_rows"
            : "complete",
  };
};

const tryPushAddressMatch = (
  r: SequenceRowRecord,
  spanStart: string,
  spanEnd: string | null,
  exact: boolean,
  out: DwarfLineAddressMatch["matches"][number][],
  budget: SharedBudget,
): boolean => {
  if (budget.addressMatchesRemaining <= 0) {
    budget.addressMatchBudgetHit = true;
    return false;
  }
  const matchChars =
    (r.fileName?.length ?? 0) +
    (r.directory?.length ?? 0) +
    (r.path?.length ?? 0);
  if (!tryConsumeExpandedChars(budget, matchChars)) {
    budget.addressMatchStringBudgetHit = true;
    return false;
  }
  budget.addressMatchesRemaining -= 1;
  out.push({
    program_index: r.programIndex,
    program_offset: r.programOffset,
    sequence_index: r.sequenceIndex,
    span_start: spanStart,
    span_end: spanEnd,
    exact,
    address: formatDwarfLineAddress(r.address),
    op_index: r.opIndex,
    file_index: r.fileIndex,
    file: r.fileName,
    directory: r.directory,
    path: r.path,
    md5_hex: r.md5Hex,
    line: r.line,
    column: r.column,
    is_stmt: r.isStmt,
    basic_block: r.basicBlock,
    prologue_end: r.prologueEnd,
    epilogue_begin: r.epilogueBegin,
    isa: r.isa,
    discriminator: r.discriminator,
  });
  return true;
};

const matchSequenceMonotonic = (
  seq: DecodedSequenceIndex,
  query: bigint,
  out: DwarfLineAddressMatch["matches"][number][],
  budget: SharedBudget,
): void => {
  const rows = seq.rows;
  if (rows.length === 0) return;

  const endIdx = seq.hasEndSequence ? rows.length - 1 : rows.length;
  if (seq.hasEndSequence && endIdx === 0) return;

  const first = rows[0];
  if (!first || query < first.address) return;
  if (
    seq.hasEndSequence &&
    seq.endAddress !== null &&
    query >= seq.endAddress
  ) {
    return;
  }

  // Binary search for greatest index i in [0, endIdx) where rows[i].address <= query.
  let lo = 0;
  let hi = endIdx - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const row = rows[mid];
    if (row && row.address <= query) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const matchedStartAddr = rows[lo]?.address;
  if (matchedStartAddr === undefined) return;

  // Walk backwards to capture earlier view rows at matchedStartAddr.
  let groupStart = lo;
  while (groupStart > 0 && rows[groupStart - 1]?.address === matchedStartAddr) {
    groupStart -= 1;
  }
  // Walk forwards to find the end of matchedStartAddr group.
  let groupEnd = lo + 1;
  while (groupEnd < endIdx && rows[groupEnd]?.address === matchedStartAddr) {
    groupEnd += 1;
  }

  const nextRow = rows[groupEnd];
  if (nextRow === undefined && !seq.hasEndSequence) {
    // Sequence had no end_sequence terminator; final row only matches exact PC.
    if (query !== matchedStartAddr) return;
  }
  const spanEndBig =
    nextRow !== undefined
      ? nextRow.address
      : seq.hasEndSequence
        ? seq.endAddress
        : null;
  const spanEnd =
    spanEndBig === null ? null : formatDwarfLineAddress(spanEndBig);
  const spanStart = formatDwarfLineAddress(matchedStartAddr);
  const exact = query === matchedStartAddr;

  for (let i = groupStart; i < groupEnd; i += 1) {
    const r = rows[i];
    if (!r) continue;
    if (!tryPushAddressMatch(r, spanStart, spanEnd, exact, out, budget)) {
      return;
    }
  }
};

const matchSequenceLinear = (
  seq: DecodedSequenceIndex,
  query: bigint,
  out: DwarfLineAddressMatch["matches"][number][],
  budget: SharedBudget,
): void => {
  const rows = seq.rows;
  const limit = seq.hasEndSequence ? rows.length - 1 : rows.length;
  let i = 0;
  while (i < limit) {
    const startAddr = rows[i]?.address;
    if (startAddr === undefined) break;
    let j = i + 1;
    while (j < limit && rows[j]?.address === startAddr) j += 1;
    const nextRow = rows[j];
    const candidateEnd =
      nextRow !== undefined
        ? nextRow.address
        : seq.hasEndSequence
          ? seq.endAddress
          : null;
    const hasForwardSpan = candidateEnd !== null && candidateEnd > startAddr;
    const matched = hasForwardSpan
      ? query >= startAddr && query < candidateEnd
      : query === startAddr;
    if (matched) {
      const spanStart = formatDwarfLineAddress(startAddr);
      const spanEnd = hasForwardSpan
        ? formatDwarfLineAddress(candidateEnd)
        : null;
      const exact = query === startAddr;
      for (let k = i; k < j; k += 1) {
        const r = rows[k];
        if (!r) continue;
        if (!tryPushAddressMatch(r, spanStart, spanEnd, exact, out, budget)) {
          return;
        }
      }
    }
    i = j;
  }
};

const resolveAddresses = (
  targets: readonly AddressMatchTarget[] | null,
  unappliedRelocations: boolean,
  walkIncomplete: boolean,
  addressMatchBudgetHit: boolean,
): readonly DwarfLineAddressMatch[] => {
  if (targets === null || targets.length === 0) return [];
  return targets.map((entry) => {
    if (unappliedRelocations) {
      return {
        query_address: entry.queryAddress,
        status: "unapplied_relocation",
        matches: [],
      };
    }
    if (entry.matches.length > 0) {
      return {
        query_address: entry.queryAddress,
        status: "resolved",
        matches: entry.matches,
      };
    }
    return {
      query_address: entry.queryAddress,
      status:
        walkIncomplete || addressMatchBudgetHit ? "incomplete" : "not_found",
      matches: [],
    };
  });
};

/** Decode DWARF 2–5 `.debug_line` programs and resolve virtual addresses offline. */
export const parseDwarfLinePrograms = (
  input: ParseDwarfLineProgramsInput,
): ParsedDwarfLinePrograms => {
  const { line, programOffset, maxPrograms, maxRows } = input;
  if (programOffset !== undefined && programOffset >= line.length) {
    throw malformedInput(
      "dwarf",
      `.debug_line program_offset ${programOffset} is outside .debug_line (${line.length} bytes)`,
      { offset: programOffset, field: "program_offset" },
    );
  }

  const strings = createStringTableState(input);
  const budget: SharedBudget = {
    stepsRemaining: MAX_DWARF_LINE_PROGRAM_STEPS,
    stepBudgetHit: false,
    headerEntriesRemaining: MAX_DWARF_LINE_TOTAL_HEADER_ENTRIES,
    headerEntryBudgetHit: false,
    expandedCharsRemaining: MAX_DWARF_LINE_EXPANDED_STRING_CHARS,
    stringExpansionBudgetHit: false,
    sequencesRemaining: MAX_DWARF_LINE_SEQUENCES,
    sequenceCountBudgetHit: false,
    addressMatchesRemaining: MAX_DWARF_LINE_ADDRESS_MATCHES,
    addressMatchBudgetHit: false,
    addressMatchStringBudgetHit: false,
    sequenceBudgetHit: false,
  };
  const addressTargets =
    input.addresses !== undefined && input.addresses.length > 0
      ? input.addresses.map((raw) => {
          const target = BigInt(raw);
          return {
            queryAddress: formatDwarfLineAddress(target),
            target,
            matches: [],
          };
        })
      : null;

  const programs: DwarfLineProgram[] = [];
  const rows: DwarfLineRow[] = [];
  let totalPrograms = 0;
  let totalRows = 0;
  let anyAddressesUnresolved = input.unappliedLineRelocations.length > 0;
  let partialReason: string | null = null;
  let walkIncomplete = false;
  let cursorOffset = programOffset ?? 0;

  while (cursorOffset < line.length) {
    if (programOffset !== undefined && totalPrograms > 0) break;

    if (!consumeStep(budget)) {
      partialReason ??= `Line-program decoding stopped at the ${MAX_DWARF_LINE_PROGRAM_STEPS}-step opcode budget`;
      walkIncomplete = true;
      break;
    }

    if (totalPrograms >= MAX_DWARF_LINE_PROGRAMS_WALKED) {
      partialReason ??= `Walked maximum of ${MAX_DWARF_LINE_PROGRAMS_WALKED} line-number programs`;
      walkIncomplete = true;
      break;
    }

    if (
      programs.length >= maxPrograms &&
      (addressTargets === null || addressMatchingStopped(budget))
    ) {
      partialReason ??= `Retained line-program limit (${maxPrograms}) reached`;
      break;
    }

    const sliceCursor = new DwarfCursor(
      line.subarray(cursorOffset),
      input.little,
    );
    const initial = readInitialLength(sliceCursor);
    if (!initial.ok) {
      if (totalPrograms === 0 || programOffset !== undefined) {
        if (initial.reason === "truncated") {
          throw truncatedInput(
            "dwarf",
            "Truncated .debug_line initial length",
            {
              offset: cursorOffset,
            },
          );
        }
        throw malformedInput(
          "dwarf",
          initial.reason === "reserved"
            ? "Invalid reserved .debug_line initial length"
            : "Overflowing .debug_line initial length",
          { offset: cursorOffset },
        );
      }
      partialReason ??=
        initial.reason === "truncated"
          ? "Trailing .debug_line initial length is truncated"
          : "Trailing .debug_line initial length is invalid";
      walkIncomplete = true;
      break;
    }

    if (initial.payloadLength === 0) {
      if (totalPrograms === 0 || programOffset !== undefined) {
        throw malformedInput(
          "dwarf",
          ".debug_line program unit_length is zero",
          {
            offset: cursorOffset,
          },
        );
      }
      partialReason ??= "Encountered zero-length trailing .debug_line entry";
      walkIncomplete = true;
      break;
    }

    const declaredEnd = cursorOffset + initial.totalLength;
    const boundedEnd = Math.min(line.length, declaredEnd);
    const truncatedProgram = declaredEnd > line.length;
    const boundedLength = boundedEnd - cursorOffset;
    const programBytes = line.subarray(cursorOffset, boundedEnd);
    const headerOffsetInProgram = sliceCursor.offset;

    const programIndex = totalPrograms;
    totalPrograms += 1;

    const issues = createIssueCollector();
    if (truncatedProgram) {
      issues.push(
        "truncated_program",
        `Program declared length ${initial.totalLength} extends past .debug_line end`,
      );
      walkIncomplete = true;
      partialReason ??= "Line-number program extends past .debug_line end";
    }

    const header = parseProgramHeader(
      programBytes,
      initial.offsetSize,
      headerOffsetInProgram,
      input.little,
      input.defaultAddressSize,
      strings,
      budget,
      issues,
    );

    if (!header.ok) {
      walkIncomplete = true;
      if (budget.headerEntryBudgetHit) {
        partialReason ??= `Aggregate directory and file entries exceeded ${MAX_DWARF_LINE_TOTAL_HEADER_ENTRIES} entry cap`;
      } else if (budget.stepBudgetHit) {
        partialReason ??= `Line-program decoding stopped at the ${MAX_DWARF_LINE_PROGRAM_STEPS}-step opcode budget`;
      } else {
        partialReason ??=
          "Line-number program header could not be completely decoded";
      }
    }

    const retainRowsForProgram = programs.length < maxPrograms;
    let runResult: RunProgramResult = {
      totalRows: 0,
      retainedRows: 0,
      addressesUnresolved: strings.lineRelocated,
      sequences: [],
      rowsOmitted: false,
      stopReason: header.ok
        ? "complete"
        : budget.stepBudgetHit || budget.headerEntryBudgetHit
          ? "decode_budget"
          : "aborted",
    };

    if (header.ok) {
      runResult = runLineMachine(
        programIndex,
        cursorOffset,
        programBytes,
        header,
        input.little,
        strings,
        issues,
        budget,
        rows,
        maxRows,
        retainRowsForProgram,
        addressTargets,
      );
      totalRows += runResult.totalRows;
      if (runResult.addressesUnresolved) anyAddressesUnresolved = true;
      if (runResult.stopReason === "decode_budget") {
        walkIncomplete = true;
        partialReason ??= budget.headerEntryBudgetHit
          ? `Aggregate directory and file entries exceeded ${MAX_DWARF_LINE_TOTAL_HEADER_ENTRIES} entry cap`
          : budget.sequenceBudgetHit
            ? `Line sequence exceeded ${MAX_DWARF_LINE_SEQUENCE_ROWS} rows`
            : `Line-program decoding stopped at the ${MAX_DWARF_LINE_PROGRAM_STEPS}-step opcode budget`;
      } else if (runResult.stopReason === "string_budget") {
        partialReason ??= `Line-program string expansion exceeded ${MAX_DWARF_LINE_EXPANDED_STRING_CHARS}-character budget`;
        walkIncomplete = true;
      } else if (runResult.stopReason === "aborted") {
        walkIncomplete = true;
        partialReason ??=
          "Line-number program execution stopped due to malformed or truncated opcodes";
      } else if (runResult.stopReason === "max_rows") {
        partialReason ??= `Retained line-row limit (${maxRows}) reached`;
        walkIncomplete = true;
      } else if (runResult.rowsOmitted) {
        partialReason ??= `Retained line-row limit (${maxRows}) reached`;
      }
    }

    if (retainRowsForProgram) {
      programs.push({
        index: programIndex,
        offset: cursorOffset,
        file_offset:
          input.lineFileOffset === null
            ? null
            : input.lineFileOffset + cursorOffset,
        length: boundedLength,
        offset_size: initial.offsetSize,
        version: header.version,
        address_size: header.addressSize,
        segment_selector_size: header.segmentSelectorSize,
        minimum_instruction_length: header.minInstLen,
        maximum_operations_per_instruction: header.maxOpsPerInst,
        default_is_stmt: header.defaultIsStmt,
        line_base: header.lineBase,
        line_range: header.lineRange,
        opcode_base: header.opcodeBase,
        standard_opcode_lengths: [...header.standardOpcodeLengths],
        directories: header.directories,
        files: header.files,
        sequences: [...runResult.sequences],
        total_rows: runResult.totalRows,
        retained_rows: runResult.retainedRows,
        addresses_unresolved: runResult.addressesUnresolved,
        issues: issues.list,
      });
    } else {
      partialReason ??= `Retained line-program limit (${maxPrograms}) reached`;
    }

    cursorOffset = boundedEnd;

    if (
      runResult.stopReason === "decode_budget" ||
      runResult.stopReason === "string_budget" ||
      budget.stepBudgetHit ||
      budget.headerEntryBudgetHit ||
      budget.sequenceBudgetHit
    ) {
      break;
    }
    if (runResult.stopReason === "max_rows") {
      break;
    }
  }

  if (maxRows > 0 && totalRows > maxRows && partialReason === null) {
    partialReason = `Retained line-row limit (${maxRows}) reached`;
  }
  if (strings.stringBudgetHit || budget.stringExpansionBudgetHit) {
    partialReason ??= `Line-program string expansion exceeded ${MAX_DWARF_LINE_EXPANDED_STRING_CHARS}-character budget`;
  }
  if (budget.sequenceCountBudgetHit) {
    partialReason ??= `Retained line-sequence limit (${MAX_DWARF_LINE_SEQUENCES}) reached`;
  }
  if (budget.addressMatchBudgetHit) {
    partialReason ??= `Retained address-match limit (${MAX_DWARF_LINE_ADDRESS_MATCHES}) reached`;
  }

  const addressMatches = resolveAddresses(
    addressTargets,
    anyAddressesUnresolved,
    walkIncomplete,
    addressMatchingStopped(budget),
  );

  const limitations: string[] = [
    DWARF_LINE_LIMITATIONS.targetDerived,
    DWARF_LINE_LIMITATIONS.childDiesOmitted,
    DWARF_LINE_LIMITATIONS.externalDebugUnfollowed,
  ];
  if (input.lineFileOffset === null && line.length > 0) {
    limitations.push(DWARF_LINE_LIMITATIONS.compressedOffsets);
  }
  if (maxRows === 0) {
    limitations.push(DWARF_LINE_LIMITATIONS.rowsOmittedByCaller);
  }
  if (strings.stringBudgetHit || budget.stringExpansionBudgetHit) {
    limitations.push(DWARF_LINE_LIMITATIONS.stringExpansionTruncated);
  }
  if (budget.addressMatchBudgetHit) {
    limitations.push(DWARF_LINE_LIMITATIONS.addressMatchesTruncated);
  }

  return {
    selected_program_offset: programOffset ?? null,
    programs,
    total_programs: totalPrograms,
    rows,
    total_rows: totalRows,
    address_matches: addressMatches,
    coverage: {
      status: partialReason === null ? "complete" : "partial",
      reason: partialReason,
    },
    limitations,
  };
};
