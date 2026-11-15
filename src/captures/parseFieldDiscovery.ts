import type {
  InspectPacketFieldsInput,
  PacketFieldRecord,
} from "../domain/captures/packetFields.js";
import { literalSubstringPredicate } from "../domain/analysisSearch.js";

/**
 * The estimated representation of one page of selected glossary records. A
 * page that would exceed it ends early with `has_more`; its first record is
 * always returned, since that record is bounded by the admitted output.
 */
export const FIELD_RECORD_BUDGET = 8 * 1024 * 1024;

/** A parsed glossary record retained for in-memory selection. */
export interface ParsedFieldGlossaryRecord extends PacketFieldRecord {
  /** UTF-8 bytes of the source glossary line; drives the record budget. */
  readonly sourceByteLength: number;
}

/** TShark -G fields: P/name/abbreviation or F/name/abbreviation/type/parent/base/mask/blurb. */
export const parseFieldGlossary = (
  text: string,
): ParsedFieldGlossaryRecord[] => {
  const copy = (value: string) =>
    Buffer.from(value, "utf16le").toString("utf16le");
  const records: ParsedFieldGlossaryRecord[] = [];
  let sourceLine = 0;
  // Walk the bounded text once; detach retained fields from the much larger
  // producer string so a cached glossary never pins the raw dump.
  for (let start = 0; start < text.length;) {
    const end = text.indexOf("\n", start);
    let line = text.slice(start, end < 0 ? text.length : end);
    start = end < 0 ? text.length : end + 1;
    sourceLine++;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const columns = line.split("\t", 9);
    const [tag, name, abbreviation] = columns;
    if (
      !(
        (tag === "P" && columns.length === 3) ||
        (tag === "F" && columns.length === 8)
      ) ||
      name === undefined ||
      abbreviation === undefined ||
      abbreviation === ""
    )
      throw new Error(
        `Malformed TShark field glossary record at line ${sourceLine}`,
      );
    records.push({
      source_line: sourceLine,
      kind: tag === "P" ? "protocol" : "field",
      name: copy(name),
      abbreviation: copy(abbreviation),
      field_type: tag === "F" ? copy(columns[3] ?? "") : null,
      parent_protocol: tag === "F" ? copy(columns[4] ?? "") : null,
      display_base: tag === "F" ? copy(columns[5] ?? "") : null,
      bitmask: tag === "F" ? copy(columns[6] ?? "") : null,
      description: tag === "F" ? copy(columns[7] ?? "") : null,
      sourceByteLength: Buffer.byteLength(line, "utf8"),
    });
  }
  if (sourceLine === 0)
    throw new Error("TShark returned an empty field glossary");
  return records;
};

/**
 * Select one page from already-parsed glossary records. Filtering, paging and
 * the record budget behave exactly as the single-pass scan did, so a cached
 * glossary returns the same page a fresh producer dump would.
 */
export const selectFieldRecords = (
  records: readonly ParsedFieldGlossaryRecord[],
  input: InspectPacketFieldsInput,
) => {
  const matches = literalSubstringPredicate(input.query, false);
  const page: PacketFieldRecord[] = [];
  let examined = 0,
    matching = 0,
    budget = 0,
    recordBudgetReached = false;
  for (const record of records) {
    if ((input.kind === "protocols") !== (record.kind === "protocol")) continue;
    examined++;
    if (
      input.protocol !== null &&
      (record.kind === "protocol"
        ? record.abbreviation
        : (record.parent_protocol ?? "")) !== input.protocol
    )
      continue;
    if (
      !matches(record.name) &&
      !matches(record.abbreviation) &&
      (record.kind !== "field" || !matches(record.description ?? ""))
    )
      continue;
    matching++;
    if (
      recordBudgetReached ||
      matching <= input.offset ||
      page.length >= (input.limit ?? Number.MAX_SAFE_INTEGER)
    )
      continue;
    // Six bytes per source byte covers worst-case JSON escaping, plus record bookkeeping.
    const cost = record.sourceByteLength * 6 + 512;
    if (page.length > 0 && budget + cost > FIELD_RECORD_BUDGET) {
      // The page stays contiguous: later matches continue from offset + returned.
      recordBudgetReached = true;
      continue;
    }
    budget += cost;
    const { sourceByteLength: _sourceByteLength, ...retained } = record;
    page.push(retained);
  }
  return {
    records: page,
    output_window: {
      examined,
      matching,
      returned: page.length,
      has_more: Math.max(0, matching - input.offset) > page.length,
      record_budget_reached: recordBudgetReached,
    },
  };
};

export const parseFieldDiscovery = (
  text: string,
  input: InspectPacketFieldsInput,
) => selectFieldRecords(parseFieldGlossary(text), input);
