import {
  MAX_DWARF_ABBREV_ATTRIBUTES,
  MAX_DWARF_ABBREV_ENTRIES,
} from "../../domain/native/dwarfUnits.js";
import { DwarfCursor } from "./DwarfReader.js";

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

const safeCode = (value: bigint): number | null =>
  value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);

/**
 * Parse abbreviation tables. Failures are cached with successes. Retention is
 * bounded by eviction. A shared work allowance bounds reparsing across
 * evictions and failed tables; exhaustion produces an explicit budget result.
 */
export class DwarfAbbrevCache {
  readonly #cache = new Map<number, DwarfAbbrevTable>();
  readonly #work: AbbrevWorkBudget = { remaining: MAX_ABBREV_PARSE_STEPS };
  #retained = 0;

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
    if (this.#retained + entries > MAX_DWARF_ABBREV_ENTRIES) {
      this.#cache.clear();
      this.#retained = 0;
    }
    this.#retained += entries;
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
  const cursor = new DwarfCursor(bytes.subarray(offset), little);
  const entries = new Map<number, DwarfAbbrevEntry>();
  for (;;) {
    if (work.remaining <= 0) return workExhausted();
    work.remaining -= 1;
    const code = cursor.uleb();
    if (!code.ok)
      return {
        kind: "malformed",
        message: "Abbreviation table ended before its terminating code",
      };
    if (code.value === 0n)
      return { kind: "ok", entries, end: offset + cursor.offset };
    if (entries.size >= MAX_DWARF_ABBREV_ENTRIES)
      return {
        kind: "budget",
        message: `Abbreviation table exceeds ${String(MAX_DWARF_ABBREV_ENTRIES)} entries`,
      };
    const codeNumber = safeCode(code.value);
    const tag = cursor.uleb();
    const children = cursor.u8();
    if (codeNumber === null || !tag.ok || children === null)
      return {
        kind: "malformed",
        message: "Abbreviation header is truncated or out of range",
      };
    if (children !== 0 && children !== 1)
      return {
        kind: "malformed",
        message: "Abbreviation children flag is not 0 or 1",
      };
    const tagNumber = safeCode(tag.value);
    if (tagNumber === null || tagNumber > 0xffff)
      return {
        kind: "malformed",
        message: "Abbreviation tag is out of range",
      };
    if (entries.has(codeNumber))
      return {
        kind: "malformed",
        message: `Duplicate abbreviation code ${String(codeNumber)}`,
      };
    const attributes: DwarfAbbrevAttribute[] = [];
    for (;;) {
      if (work.remaining <= 0) return workExhausted();
      work.remaining -= 1;
      const name = cursor.uleb();
      const form = cursor.uleb();
      if (!name.ok || !form.ok)
        return {
          kind: "malformed",
          message: "Abbreviation attribute list is truncated",
        };
      if (name.value === 0n && form.value === 0n) break;
      if (attributes.length >= MAX_DWARF_ABBREV_ATTRIBUTES)
        return {
          kind: "budget",
          message: `Abbreviation exceeds ${String(MAX_DWARF_ABBREV_ATTRIBUTES)} attributes`,
        };
      const nameNumber = safeCode(name.value);
      const formNumber = safeCode(form.value);
      if (
        nameNumber === null ||
        formNumber === null ||
        nameNumber > 0xffff_ffff ||
        formNumber > 0xffff_ffff
      )
        return {
          kind: "malformed",
          message: "Abbreviation attribute or form is out of range",
        };
      let implicit: bigint | null = null;
      if (formNumber === DW_FORM_IMPLICIT_CONST) {
        const constant = cursor.sleb();
        if (!constant.ok)
          return {
            kind: "malformed",
            message: "DW_FORM_implicit_const is missing its abbreviation value",
          };
        implicit = constant.value;
      }
      attributes.push({ name: nameNumber, form: formNumber, implicit });
    }
    entries.set(codeNumber, {
      code: codeNumber,
      tag: tagNumber,
      children: children === 1,
      attributes,
    });
  }
};
