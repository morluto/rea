import {
  dwarfLanguageName,
  MAX_DWARF_STRING_BYTES,
  MAX_DWARF_UNIT_ISSUES,
  MAX_DWARF_UNITS,
  type DwarfCompileUnit,
  type DwarfNumberFact,
  type DwarfStringFact,
  type DwarfUnitIssueCode,
} from "../../domain/native/dwarfUnits.js";
import { DwarfAbbrevCache, type DwarfAbbrevAttribute } from "./DwarfAbbrev.js";
import { DwarfCursor, readInitialLength } from "./DwarfReader.js";

const DW_AT_NAME = 0x03;
const DW_AT_STMT_LIST = 0x10;
const DW_AT_LOW_PC = 0x11;
const DW_AT_LANGUAGE = 0x13;
const DW_AT_COMP_DIR = 0x1b;
const DW_AT_PRODUCER = 0x25;
const DW_AT_STR_OFFSETS_BASE = 0x72;
const DW_AT_DWO_NAME = 0x76;
const DW_AT_GNU_DWO_NAME = 0x2130;

const FORM_IMPLICIT_CONST = 0x21;
const FORM_INDIRECT = 0x16;

const RELOCATIONS_UNAPPLIED =
  "Relocatable ELF debug relocations were not applied";

export interface DwarfInfoInput {
  readonly info: Buffer;
  /** Null when `.debug_abbrev` is absent or could not be decoded. */
  readonly abbrev: Buffer | null;
  readonly str: Buffer | null;
  readonly lineStr: Buffer | null;
  readonly strOffsets: Buffer | null;
  readonly little: boolean;
  /** Artifact file offset of `.debug_info`, or null when that section is compressed. */
  readonly infoFileOffset: number | null;
  readonly pageOffset: number;
  readonly pageLimit: number;
  /** ET_REL debug relocations were observed and not applied. */
  readonly debugRelocationsUnapplied?: boolean;
}

export interface DwarfInfoWalk {
  readonly units: DwarfCompileUnit[];
  readonly total_units: number;
  readonly coverage: {
    readonly status: "complete" | "partial";
    readonly reason: string | null;
  };
}

type FormValue =
  | { readonly kind: "string"; readonly raw: Buffer }
  | {
      readonly kind: "string-ref";
      readonly section: "str" | "line_str";
      readonly offset: number;
    }
  | { readonly kind: "strx"; readonly index: number }
  | { readonly kind: "gnu-str-index"; readonly index: number }
  | { readonly kind: "supplementary" }
  | { readonly kind: "constant"; readonly value: bigint }
  | { readonly kind: "skip" }
  | { readonly kind: "unusable" }
  | { readonly kind: "capped" };

type FormFailure = "truncated" | "unknown-form" | "indirect-invalid";

interface UnitDraft {
  readonly offset: number;
  readonly file_offset: number | null;
  readonly length: number;
  readonly offset_size: 4 | 8;
  version: number | null;
  unit_type: number | null;
  address_size: number | null;
  abbrev_offset: number | null;
  tag: number | null;
  die_complete: boolean;
  name: DwarfStringFact;
  comp_dir: DwarfStringFact;
  producer: DwarfStringFact;
  dwo_name: DwarfStringFact;
  language: DwarfNumberFact;
  language_name: string | null;
  stmt_list: DwarfNumberFact;
  low_pc_present: boolean | null;
  readonly issues: { code: DwarfUnitIssueCode; detail: string }[];
}

/** Walk `.debug_info` unit headers and the first DIE of each framed unit. */
export const parseDwarfCompileUnits = (
  input: DwarfInfoInput,
): DwarfInfoWalk => {
  const cursor = new DwarfCursor(input.info, input.little);
  const abbrev = new DwarfAbbrevCache(
    input.abbrev ?? Buffer.alloc(0),
    input.little,
  );
  const units: DwarfCompileUnit[] = [];
  let total = 0;
  let reason: string | null = null;
  while (cursor.remaining() > 0) {
    if (total >= MAX_DWARF_UNITS) {
      reason = `The walk stopped at ${String(MAX_DWARF_UNITS)} framed units. total_units is not a complete census.`;
      break;
    }
    const start = cursor.offset;
    const framed = readInitialLength(cursor);
    if (!framed.ok || cursor.remaining() < framed.payloadLength) {
      reason = frameReason(start, framed.ok ? "truncated" : framed.reason);
      break;
    }
    const payload = input.info.subarray(
      cursor.offset,
      cursor.offset + framed.payloadLength,
    );
    cursor.offset += framed.payloadLength;
    if (total >= input.pageOffset && total < input.pageOffset + input.pageLimit)
      units.push(
        parseUnit(
          payload,
          start,
          framed.offsetSize,
          framed.totalLength,
          input,
          abbrev,
        ),
      );
    total += 1;
  }
  return {
    units,
    total_units: total,
    coverage:
      reason === null
        ? { status: "complete", reason: null }
        : { status: "partial", reason },
  };
};

const frameReason = (
  offset: number,
  reason: "truncated" | "reserved" | "overflow",
): string => {
  const where = `Compile unit at .debug_info offset ${String(offset)}`;
  switch (reason) {
    case "reserved":
      return `${where} uses a reserved initial length and does not frame the next unit.`;
    case "overflow":
      return `${where} has a length above the exact integer range and does not frame the next unit.`;
    default:
      return `${where} is truncated and does not frame the next unit.`;
  }
};

const absentString = (): DwarfStringFact => ({ state: "absent", value: null });
const unknownString = (): DwarfStringFact => ({
  state: "unknown",
  value: null,
});
const unresolvedString = (): DwarfStringFact => ({
  state: "unresolved",
  value: null,
});
const absentNumber = (): DwarfNumberFact => ({ state: "absent", value: null });
const unknownNumber = (): DwarfNumberFact => ({
  state: "unknown",
  value: null,
});
const unresolvedNumber = (): DwarfNumberFact => ({
  state: "unresolved",
  value: null,
});

const parseUnit = (
  payload: Buffer,
  offset: number,
  offsetSize: 4 | 8,
  length: number,
  input: DwarfInfoInput,
  abbrev: DwarfAbbrevCache,
): DwarfCompileUnit => {
  const draft = blankUnit(
    offset,
    input.infoFileOffset === null ? null : input.infoFileOffset + offset,
    length,
    offsetSize,
  );
  const issue = (code: DwarfUnitIssueCode, detail: string): void => {
    if (draft.issues.length < MAX_DWARF_UNIT_ISSUES)
      draft.issues.push({ code, detail });
  };
  if (payload.length === 0) {
    issue("empty_unit", "Unit length is zero");
    return draft;
  }
  const cursor = new DwarfCursor(payload, input.little);
  const version = cursor.u16();
  if (version === null) {
    issue("truncated_header", "Unit version is truncated");
    return draft;
  }
  draft.version = version;
  if (version < 2 || version > 5) {
    issue(
      "unsupported_version",
      `DWARF version ${String(version)} is not read`,
    );
    return draft;
  }
  if (version >= 5) {
    const unitType = cursor.u8();
    if (unitType === null) {
      issue("truncated_header", "Unit type is truncated");
      return draft;
    }
    draft.unit_type = unitType;
  }
  if (version >= 5) {
    const addressSize = cursor.u8();
    if (addressSize === null) {
      issue("truncated_header", "Address size is truncated");
      return draft;
    }
    draft.address_size = addressSize;
  }
  const abbrevField = readOffset(cursor, offsetSize);
  if (abbrevField === null) {
    issue("truncated_header", "Abbreviation offset is truncated");
    return draft;
  }
  if (abbrevField === "overflow") {
    issue(
      "value_out_of_range",
      "Abbreviation offset exceeds the exact integer range",
    );
    return draft;
  }
  draft.abbrev_offset = abbrevField;
  if (version < 5) {
    const addressSize = cursor.u8();
    if (addressSize === null) {
      issue("truncated_header", "Address size is truncated");
      return draft;
    }
    draft.address_size = addressSize;
  }
  const knownType =
    draft.unit_type === null || (draft.unit_type >= 1 && draft.unit_type <= 6);
  if (!knownType) {
    issue(
      "unknown_unit_type",
      `DW_UT value ${String(draft.unit_type)} has no known header trailer`,
    );
    return draft;
  }
  if (
    draft.address_size === null ||
    draft.address_size < 1 ||
    draft.address_size > 8
  ) {
    issue(
      "unsupported_address_size",
      `Address size ${String(draft.address_size)} is outside 1..8`,
    );
    return draft;
  }
  const trailer =
    draft.unit_type === 4 || draft.unit_type === 5
      ? 8
      : draft.unit_type === 2 || draft.unit_type === 6
        ? 8 + offsetSize
        : 0;
  if (!cursor.skip(trailer)) {
    issue("truncated_header", "Unit header trailer is truncated");
    return draft;
  }
  if (input.abbrev === null) {
    issue("abbrev_unavailable", ".debug_abbrev was not available");
    return draft;
  }
  // The stored field is a relocation placeholder. It selects a table only
  // when the section leaves one choice.
  if (
    input.debugRelocationsUnapplied === true &&
    (draft.abbrev_offset !== 0 || !abbrev.holdsOneTable())
  ) {
    draft.abbrev_offset = null;
    issue(
      "unapplied_relocation",
      "Abbreviation offset is an unapplied ET_REL relocation, so no table can be selected",
    );
    return draft;
  }
  if (draft.abbrev_offset > input.abbrev.length) {
    issue(
      "abbrev_offset_out_of_range",
      `Abbreviation offset ${String(draft.abbrev_offset)} is outside .debug_abbrev`,
    );
    return draft;
  }
  const table = abbrev.get(draft.abbrev_offset);
  if (table.kind === "budget") {
    issue("abbrev_budget", table.message);
    return draft;
  }
  if (table.kind === "malformed") {
    issue("abbrev_malformed", table.message);
    return draft;
  }
  readDie(
    new DwarfCursor(payload.subarray(cursor.offset), input.little),
    table.entries,
    draft,
    input,
    issue,
  );
  return draft;
};

const readOffset = (
  cursor: DwarfCursor,
  offsetSize: 4 | 8,
): number | "overflow" | null => {
  const value = cursor.fixed(offsetSize);
  if (value === null) return null;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return "overflow";
  return Number(value);
};

const readDie = (
  cursor: DwarfCursor,
  entries: ReadonlyMap<
    number,
    { tag: number; attributes: readonly DwarfAbbrevAttribute[] }
  >,
  draft: UnitDraft,
  input: DwarfInfoInput,
  issue: (code: DwarfUnitIssueCode, detail: string) => void,
): void => {
  const code = cursor.uleb();
  if (!code.ok) {
    issue("truncated_die", "Abbreviation code is truncated");
    return;
  }
  if (code.value === 0n) {
    markAbsent(draft);
    draft.die_complete = true;
    draft.low_pc_present = false;
    return;
  }
  if (code.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    issue(
      "unknown_abbrev_code",
      "Abbreviation code exceeds the exact integer range",
    );
    return;
  }
  const entry = entries.get(Number(code.value));
  if (entry === undefined) {
    issue(
      "unknown_abbrev_code",
      `Abbreviation code ${code.value.toString()} was not defined`,
    );
    return;
  }
  draft.tag = entry.tag;
  draft.low_pc_present = entry.attributes.some(
    (attribute) => attribute.name === DW_AT_LOW_PC,
  );
  const reached = new Map<number, FormValue>();
  let stop = entry.attributes.length;
  for (let index = 0; index < entry.attributes.length; index += 1) {
    const attribute = entry.attributes[index]!;
    const read = readForm(cursor, attribute.form, attribute.implicit, {
      version: draft.version ?? 0,
      addressSize: draft.address_size ?? 0,
      offsetSize: draft.offset_size,
    });
    if (!read.ok) {
      stop = index;
      if (read.reason === "unknown-form")
        issue(
          "unknown_form",
          `Unknown DW_FORM ${String(read.form)} (0x${read.form.toString(16)})`,
        );
      else if (read.reason === "indirect-invalid")
        issue(
          "unknown_form",
          "DW_FORM_indirect cannot carry DW_FORM_implicit_const",
        );
      else issue("truncated_die", "DIE attribute value is truncated");
      break;
    }
    reached.set(attribute.name, read.value);
  }
  draft.die_complete = stop === entry.attributes.length;
  const factAt = (name: number): FormValue | "absent" | "unknown" => {
    const hits = entry.attributes.flatMap((attribute, index) =>
      attribute.name === name ? [index] : [],
    );
    if (hits.length === 0) return "absent";
    if (hits.some((index) => index >= stop)) return "unknown";
    return reached.get(name) ?? "unknown";
  };
  let base: number | null = null;
  let baseAvailability: "absent" | "unknown" | "present" | "invalid" = "absent";
  const baseFact = factAt(DW_AT_STR_OFFSETS_BASE);
  // ET_REL leaves this sec_offset and .debug_str_offsets unrelocated.
  if (baseFact === "unknown") baseAvailability = "unknown";
  else if (baseFact === "absent" || input.debugRelocationsUnapplied === true)
    baseAvailability = "absent";
  else if (baseFact.kind === "constant") {
    if (
      baseFact.value < 0n ||
      baseFact.value > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      baseAvailability = "invalid";
      issue(
        "value_out_of_range",
        "DW_AT_str_offsets_base exceeds the exact integer range",
      );
    } else {
      base = Number(baseFact.value);
      baseAvailability = "present";
    }
  } else baseAvailability = "invalid";
  const strings = input;
  const resolve = (name: number): DwarfStringFact =>
    resolveString(factAt(name), draft, strings, base, baseAvailability, issue);
  draft.name = resolve(DW_AT_NAME);
  draft.comp_dir = resolve(DW_AT_COMP_DIR);
  draft.producer = resolve(DW_AT_PRODUCER);
  draft.dwo_name = mergeDwoName(
    resolve(DW_AT_DWO_NAME),
    resolve(DW_AT_GNU_DWO_NAME),
    issue,
  );
  draft.language = resolveNumber(factAt(DW_AT_LANGUAGE), issue);
  draft.language_name =
    draft.language.state === "present" && draft.language.value !== null
      ? dwarfLanguageName(draft.language.value)
      : null;
  const stmtList = factAt(DW_AT_STMT_LIST);
  draft.stmt_list =
    input.debugRelocationsUnapplied === true
      ? unappliedSectionOffset(stmtList, issue)
      : resolveNumber(stmtList, issue);
};

const mergeDwoName = (
  standard: DwarfStringFact,
  gnu: DwarfStringFact,
  issue: (code: DwarfUnitIssueCode, detail: string) => void,
): DwarfStringFact => {
  if (standard.state === "absent") return gnu;
  if (
    standard.state === "present" &&
    gnu.state === "present" &&
    standard.value !== gnu.value
  )
    issue(
      "conflicting_dwo_name",
      "DW_AT_dwo_name and DW_AT_GNU_dwo_name differ; the standard value is kept",
    );
  return standard;
};

const resolveString = (
  fact: FormValue | "absent" | "unknown",
  draft: UnitDraft,
  input: DwarfInfoInput,
  base: number | null,
  baseAvailability: "absent" | "unknown" | "present" | "invalid",
  issue: (code: DwarfUnitIssueCode, detail: string) => void,
): DwarfStringFact => {
  if (fact === "absent") return absentString();
  if (fact === "unknown") return unknownString();
  switch (fact.kind) {
    case "string":
      return presentString(fact.raw, issue);
    case "string-ref":
    case "strx":
    case "gnu-str-index":
      if (input.debugRelocationsUnapplied === true) {
        issue("unapplied_relocation", RELOCATIONS_UNAPPLIED);
        return unresolvedString();
      }
      return fact.kind === "string-ref"
        ? presentString(
            lookupString(
              fact.section === "line_str" ? input.lineStr : input.str,
              fact.offset,
              issue,
            ),
            issue,
          )
        : resolveIndexedString(
            fact,
            draft,
            input,
            base,
            baseAvailability,
            issue,
          );
    case "supplementary":
      issue(
        "supplementary_string",
        "String refers to a supplementary object file that was not read",
      );
      return unresolvedString();
    case "unusable":
      issue(
        "value_out_of_range",
        "String index exceeds the exact integer range",
      );
      return unresolvedString();
    case "capped":
      issue("string_unresolved", "String exceeds the retained byte cap");
      return unresolvedString();
    default:
      issue("string_unresolved", "Attribute form did not carry a string");
      return unresolvedString();
  }
};

const resolveIndexedString = (
  fact: Extract<FormValue, { kind: "strx" | "gnu-str-index" }>,
  draft: UnitDraft,
  input: DwarfInfoInput,
  base: number | null,
  baseAvailability: "absent" | "unknown" | "present" | "invalid",
  issue: (code: DwarfUnitIssueCode, detail: string) => void,
): DwarfStringFact => {
  if (baseAvailability === "invalid") {
    issue(
      "value_out_of_range",
      "DW_AT_str_offsets_base cannot select a string",
    );
    return unresolvedString();
  }
  if (baseAvailability === "unknown") {
    issue("string_unresolved", "DW_AT_str_offsets_base was not decoded");
    return unknownString();
  }
  const gnu = fact.kind === "gnu-str-index";
  const origin =
    base !== null ? base : gnu && (draft.version ?? 5) < 5 ? 0 : null;
  if (origin === null) {
    issue(
      "str_offsets_base_absent",
      gnu
        ? "DW_FORM_GNU_str_index has no DW_AT_str_offsets_base in this DWARF 5 unit"
        : "DW_FORM_strx has no DW_AT_str_offsets_base",
    );
    return unresolvedString();
  }
  const strOffset = indexedDebugStrOffset(
    input.strOffsets,
    origin,
    fact.index,
    draft.offset_size,
    input.little,
    gnu && (draft.version ?? 5) < 5,
  );
  if (typeof strOffset !== "number") {
    issue(
      "string_unresolved",
      strOffset === "missing"
        ? ".debug_str_offsets was not available"
        : "String offset index is outside .debug_str_offsets or its contribution is invalid",
    );
    return unresolvedString();
  }
  return presentString(lookupString(input.str, strOffset, issue), issue);
};

const presentString = (
  raw: Buffer | null,
  issue: (code: DwarfUnitIssueCode, detail: string) => void,
): DwarfStringFact => {
  if (raw === null) return unresolvedString();
  const utf8 = raw.toString("utf8");
  if (Buffer.from(utf8, "utf8").equals(raw))
    return { state: "present", value: utf8 };
  issue(
    "string_not_utf8",
    "String is not valid UTF-8; the value is the raw bytes as Latin-1",
  );
  return { state: "present", value: raw.toString("latin1") };
};

const lookupString = (
  section: Buffer | null,
  offset: number,
  issue: (code: DwarfUnitIssueCode, detail: string) => void,
): Buffer | null => {
  if (section === null) {
    issue("string_unresolved", "String section was not available");
    return null;
  }
  if (offset < 0 || offset > section.length) {
    issue("string_unresolved", "String offset is outside its section");
    return null;
  }
  const end = Math.min(section.length, offset + MAX_DWARF_STRING_BYTES + 1);
  const window = section.subarray(offset, end);
  const nul = window.indexOf(0);
  if (nul < 0) {
    issue(
      "string_unresolved",
      end - offset > MAX_DWARF_STRING_BYTES
        ? "String exceeds the retained byte cap"
        : "String is not NUL-terminated",
    );
    return null;
  }
  return window.subarray(0, nul);
};

const indexedDebugStrOffset = (
  section: Buffer | null,
  base: number,
  index: number,
  offsetSize: 4 | 8,
  little: boolean,
  headerless: boolean,
): number | "missing" | "out-of-range" => {
  if (section === null) return "missing";
  let end = section.length;
  if (!headerless) {
    // DW_AT_str_offsets_base selects the first entry after this contribution's
    // initial length, version and padding, not an arbitrary section offset.
    const headerSize = offsetSize === 4 ? 8 : 16;
    if (base < headerSize || base > section.length) return "out-of-range";
    const start = base - headerSize;
    const header = new DwarfCursor(section.subarray(start, base), little);
    const framed = readInitialLength(header);
    if (
      !framed.ok ||
      framed.offsetSize !== offsetSize ||
      framed.payloadLength < 4 ||
      (framed.payloadLength - 4) % offsetSize !== 0 ||
      framed.totalLength > section.length - start ||
      header.u16() !== 5 ||
      header.u16() !== 0
    )
      return "out-of-range";
    end = start + framed.totalLength;
  }
  if (index > Math.floor((Number.MAX_SAFE_INTEGER - base) / offsetSize))
    return "out-of-range";
  const entry = base + index * offsetSize;
  if (entry < 0 || entry > end - offsetSize) return "out-of-range";
  const value = new DwarfCursor(section.subarray(entry), little).fixed(
    offsetSize,
  );
  if (value === null || value > BigInt(Number.MAX_SAFE_INTEGER))
    return "out-of-range";
  return Number(value);
};

/** A `sec_offset` holds a relocation placeholder until ET_REL relocations apply. */
const unappliedSectionOffset = (
  fact: FormValue | "absent" | "unknown",
  issue: (code: DwarfUnitIssueCode, detail: string) => void,
): DwarfNumberFact => {
  if (fact === "absent") return absentNumber();
  if (fact === "unknown") return unknownNumber();
  issue("unapplied_relocation", RELOCATIONS_UNAPPLIED);
  return unresolvedNumber();
};

const resolveNumber = (
  fact: FormValue | "absent" | "unknown",
  issue: (code: DwarfUnitIssueCode, detail: string) => void,
): DwarfNumberFact => {
  if (fact === "absent") return absentNumber();
  if (fact === "unknown") return unknownNumber();
  if (fact.kind !== "constant") {
    issue(
      "value_unresolved",
      "Numeric attribute form did not carry an integer",
    );
    return unresolvedNumber();
  }
  if (fact.value < 0n || fact.value > 0xffff_ffffn) {
    issue("value_out_of_range", "Attribute integer is outside uint32");
    return unresolvedNumber();
  }
  return { state: "present", value: Number(fact.value) };
};

interface FormContext {
  readonly version: number;
  readonly addressSize: number;
  readonly offsetSize: 4 | 8;
}

const readForm = (
  cursor: DwarfCursor,
  form: number,
  implicit: bigint | null,
  unit: FormContext,
):
  | { readonly ok: true; readonly value: FormValue }
  | {
      readonly ok: false;
      readonly reason: FormFailure;
      readonly form: number;
    } => {
  // Each indirection consumes at least one byte, so the unit cursor's remaining
  // bytes bound the chain without recursion or a limit on valid nesting depth.
  while (form === FORM_INDIRECT) {
    const inner = cursor.uleb();
    if (!inner.ok) return { ok: false, reason: "truncated", form };
    if (inner.value > 0xffff_ffffn)
      return { ok: false, reason: "unknown-form", form: 0xffff_ffff };
    form = Number(inner.value);
    if (form === FORM_IMPLICIT_CONST)
      return { ok: false, reason: "indirect-invalid", form };
    implicit = null;
  }
  const value = readDirectForm(cursor, form, implicit, unit);
  return value === null
    ? { ok: false, reason: "truncated", form }
    : value === "unknown"
      ? { ok: false, reason: "unknown-form", form }
      : { ok: true, value };
};

const readDirectForm = (
  cursor: DwarfCursor,
  form: number,
  implicit: bigint | null,
  unit: FormContext,
): FormValue | "unknown" | null => {
  const skip = (size: number): FormValue | null =>
    cursor.skip(size) ? { kind: "skip" } : null;
  const constant = (size: number): FormValue | null => {
    const value = cursor.fixed(size);
    return value === null ? null : { kind: "constant", value };
  };
  const block = (length: bigint | null): FormValue | null => {
    if (length === null) return null;
    if (length < 0n || length > BigInt(cursor.remaining())) return null;
    return cursor.skip(Number(length)) ? { kind: "skip" } : null;
  };
  const index = (size: number): FormValue | null => {
    const value = cursor.fixed(size);
    if (value === null) return null;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: "unusable" };
    return { kind: "strx", index: Number(value) };
  };
  switch (form) {
    case 0x01:
      return skip(unit.addressSize);
    case 0x03:
      return block(cursor.fixed(2));
    case 0x04:
      return block(cursor.fixed(4));
    case 0x05:
      return constant(2);
    case 0x06:
      return constant(4);
    case 0x07:
      return constant(8);
    case 0x08:
      return readInlineString(cursor);
    case 0x09:
    case 0x18: {
      const length = cursor.uleb();
      if (!length.ok) return null;
      return block(length.value);
    }
    case 0x0a:
      return block(cursor.fixed(1));
    case 0x0b:
    case 0x0c:
      return constant(1);
    case 0x0d: {
      const value = cursor.sleb();
      if (!value.ok) return null;
      return { kind: "constant", value: value.value };
    }
    case 0x0e:
      return stringRef(cursor, "str", unit.offsetSize);
    case 0x0f: {
      const value = cursor.uleb();
      if (!value.ok) return null;
      return { kind: "constant", value: value.value };
    }
    case 0x10:
      return skip(unit.version === 2 ? unit.addressSize : unit.offsetSize);
    case 0x11:
      return skip(1);
    case 0x12:
      return skip(2);
    case 0x13:
      return skip(4);
    case 0x14:
    case 0x20:
      return skip(8);
    case 0x15: {
      const length = cursor.uleb();
      return length.ok ? { kind: "skip" } : null;
    }
    case 0x17:
      return constant(unit.offsetSize);
    case 0x19:
      return { kind: "constant", value: 1n };
    case 0x1a:
    case 0x1f02: {
      const value = cursor.uleb();
      if (!value.ok) return null;
      if (value.value > BigInt(Number.MAX_SAFE_INTEGER))
        return { kind: "unusable" };
      return form === 0x1f02
        ? { kind: "gnu-str-index", index: Number(value.value) }
        : { kind: "strx", index: Number(value.value) };
    }
    case 0x1b:
    case 0x1f01:
    case 0x22:
    case 0x23: {
      const value = cursor.uleb();
      return value.ok ? { kind: "skip" } : null;
    }
    case 0x1c:
      return skip(4);
    case 0x1d:
    case 0x1f21:
      return cursor.skip(unit.offsetSize) ? { kind: "supplementary" } : null;
    case 0x1e:
      return skip(16);
    case 0x1f:
      return stringRef(cursor, "line_str", unit.offsetSize);
    case 0x21:
      return { kind: "constant", value: implicit ?? 0n };
    case 0x24:
      return skip(8);
    case 0x25:
      return index(1);
    case 0x26:
      return index(2);
    case 0x27:
      return index(3);
    case 0x28:
      return index(4);
    case 0x29:
      return skip(1);
    case 0x2a:
      return skip(2);
    case 0x2b:
      return skip(3);
    case 0x2c:
      return skip(4);
    case 0x1f20:
      return skip(unit.offsetSize);
    default:
      return "unknown";
  }
};

const stringRef = (
  cursor: DwarfCursor,
  section: "str" | "line_str",
  offsetSize: 4 | 8,
): FormValue | null => {
  const value = cursor.fixed(offsetSize);
  if (value === null) return null;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: "unusable" };
  return { kind: "string-ref", section, offset: Number(value) };
};

const readInlineString = (cursor: DwarfCursor): FormValue | null => {
  const start = cursor.offset;
  const limit = Math.min(
    cursor.bytes.length,
    start + MAX_DWARF_STRING_BYTES + 1,
  );
  const head = cursor.bytes.subarray(start, limit);
  const nul = head.indexOf(0);
  if (nul >= 0) {
    cursor.offset = start + nul + 1;
    return { kind: "string", raw: head.subarray(0, nul) };
  }
  if (limit < cursor.bytes.length) {
    const rest = cursor.bytes.subarray(limit);
    const later = rest.indexOf(0);
    if (later < 0) return null;
    cursor.offset = limit + later + 1;
    return { kind: "capped" };
  }
  return null;
};

const blankUnit = (
  offset: number,
  fileOffset: number | null,
  length: number,
  offsetSize: 4 | 8,
): UnitDraft => ({
  offset,
  file_offset: fileOffset,
  length,
  offset_size: offsetSize,
  version: null,
  unit_type: null,
  address_size: null,
  abbrev_offset: null,
  tag: null,
  die_complete: false,
  name: unknownString(),
  comp_dir: unknownString(),
  producer: unknownString(),
  dwo_name: unknownString(),
  language: unknownNumber(),
  language_name: null,
  stmt_list: unknownNumber(),
  low_pc_present: null,
  issues: [],
});

const markAbsent = (draft: UnitDraft): void => {
  draft.name = absentString();
  draft.comp_dir = absentString();
  draft.producer = absentString();
  draft.dwo_name = absentString();
  draft.language = absentNumber();
  draft.language_name = null;
  draft.stmt_list = absentNumber();
};
