import {
  MAX_DWARF_ABBREV_ATTRIBUTES,
  MAX_DWARF_ABBREV_ENTRIES,
} from "../../domain/native/dwarfUnits.js";
import { DwarfCursor } from "./DwarfReader.js";
import { Budget } from "../../domain/budget.js";

const DW_AT_LOW_PC = 0x11;
const DW_FORM_IMPLICIT_CONST = 0x21;
// Admit one maximally sized table, including attribute terminators and its
// final zero code. Cache eviction never replenishes this parsing allowance.
const MAX_ABBREV_PARSE_STEPS =
  MAX_DWARF_ABBREV_ENTRIES * (MAX_DWARF_ABBREV_ATTRIBUTES + 2) + 1;

interface AbbrevWorkBudget {
  remaining: number;
}

const workExhausted = (): DwarfAbbrevTable => ({
  kind: "budget",
  message: `Abbreviation decoding exceeds the ${String(MAX_ABBREV_PARSE_STEPS)}-step aggregate parsing work allowance`,
});

export interface DwarfAbbrevAttribute {
  readonly name: number;
  readonly form: number;
  readonly implicit: bigint | null;
}

export interface DwarfAbbrevEntry {
  readonly code: number;
  readonly tag: number;
  readonly children: boolean;
  readonly hasLowPc: boolean;
  readonly attributes: readonly DwarfAbbrevAttribute[];
}

export type DwarfAbbrevTable =
  | {
      readonly kind: "ok";
      readonly entries: ReadonlyMap<number, DwarfAbbrevEntry>;
      /** Section offset just past this table's terminating code. */
      readonly end: number;
    }
  | { readonly kind: "malformed"; readonly message: string }
  | { readonly kind: "budget"; readonly message: string };

/**
 * Parse abbreviation tables. Failures are cached with successes. Retention is
 * bounded by eviction. A shared work allowance bounds reparsing across
 * evictions and failed tables; exhaustion produces an explicit budget result.
 */
export class DwarfAbbrevCache {
  readonly #cache = new Map<number, DwarfAbbrevTable>();
  readonly #work: AbbrevWorkBudget = { remaining: MAX_ABBREV_PARSE_STEPS };
  #retained = new Budget(MAX_DWARF_ABBREV_ENTRIES);

  constructor(
    readonly bytes: Buffer,
    readonly little: boolean,
  ) {}

  get(offset: number): DwarfAbbrevTable {
    const cached = this.#cache.get(offset);
    if (cached !== undefined) return cached;
    const parsed = parseAbbrevTable(
      this.bytes,
      this.little,
      offset,
      this.#work,
    );
    const entries = parsed.kind === "ok" ? parsed.entries.size : 0;
    if (!this.#retained.tryCharge(entries)) {
      this.#cache.clear();
      this.#retained = new Budget(MAX_DWARF_ABBREV_ENTRIES);
      if (!this.#retained.tryCharge(entries)) return parsed;
    }
    this.#cache.set(offset, parsed);
    return parsed;
  }

  /** True when the section is one table, which every unit must then select. */
  holdsOneTable(): boolean {
    const first = this.get(0);
    return first.kind === "ok" && first.end === this.bytes.length;
  }
}

const parseAbbrevTable = (
  bytes: Buffer,
  little: boolean,
  offset: number,
  work: AbbrevWorkBudget,
): DwarfAbbrevTable => {
  if (offset < 0 || offset > bytes.length)
    return {
      kind: "malformed",
      message: "Abbreviation offset is outside .debug_abbrev",
    };
  const cursor = new DwarfCursor(bytes, little);
  cursor.offset = offset;
  const entries = new Map<number, DwarfAbbrevEntry>();
  for (;;) {
    if (work.remaining <= 0) return workExhausted();
    work.remaining -= 1;
    const code = cursor.ulebSafe();
    if (code === -1)
      return {
        kind: "malformed",
        message: "Abbreviation table ended before its terminating code",
      };
    if (code === 0) return { kind: "ok", entries, end: cursor.offset };
    if (entries.size >= MAX_DWARF_ABBREV_ENTRIES)
      return {
        kind: "budget",
        message: `Abbreviation table exceeds ${String(MAX_DWARF_ABBREV_ENTRIES)} entries`,
      };
    const tag = cursor.ulebSafe();
    const children = cursor.u8();
    if (code === -2 || tag === -1 || children === null)
      return {
        kind: "malformed",
        message: "Abbreviation header is truncated or out of range",
      };
    if (children !== 0 && children !== 1)
      return {
        kind: "malformed",
        message: "Abbreviation children flag is not 0 or 1",
      };
    if (tag === -2 || tag > 0xffff)
      return {
        kind: "malformed",
        message: "Abbreviation tag is out of range",
      };
    if (entries.has(code))
      return {
        kind: "malformed",
        message: `Duplicate abbreviation code ${String(code)}`,
      };
    const attributes: DwarfAbbrevAttribute[] = [];
    let hasLowPc = false;
    for (;;) {
      if (work.remaining <= 0) return workExhausted();
      work.remaining -= 1;
      const name = cursor.ulebSafe();
      const form = cursor.ulebSafe();
      if (name === -1 || form === -1)
        return {
          kind: "malformed",
          message: "Abbreviation attribute list is truncated",
        };
      if (name === 0 && form === 0) break;
      if (attributes.length >= MAX_DWARF_ABBREV_ATTRIBUTES)
        return {
          kind: "budget",
          message: `Abbreviation exceeds ${String(MAX_DWARF_ABBREV_ATTRIBUTES)} attributes`,
        };
      if (
        name === -2 ||
        form === -2 ||
        name > 0xffff_ffff ||
        form > 0xffff_ffff
      )
        return {
          kind: "malformed",
          message: "Abbreviation attribute or form is out of range",
        };
      if (name === DW_AT_LOW_PC) hasLowPc = true;
      let implicit: bigint | null = null;
      if (form === DW_FORM_IMPLICIT_CONST) {
        const constant = cursor.sleb();
        if (!constant.ok)
          return {
            kind: "malformed",
            message: "DW_FORM_implicit_const is missing its abbreviation value",
          };
        implicit = constant.value;
      }
      attributes.push({ name, form, implicit });
    }
    entries.set(code, {
      code,
      tag,
      children: children === 1,
      hasLowPc,
      attributes,
    });
  }
};
