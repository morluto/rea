import type {
  InspectPacketFieldsInput,
  PacketFieldRecord,
} from "../domain/captures/packetFields.js";
import { literalSubstringPredicate } from "../domain/analysisSearch.js";
import { decodeLimit } from "../domain/parseFailure.js";

/**
 * The estimated representation of one page of selected glossary records. A
 * page that would exceed it ends early with `has_more`; its first record is
 * always returned, since that record is bounded by the admitted output.
 */
export const FIELD_RECORD_BUDGET = 8 * 1024 * 1024;

/** Retention cap names for the in-memory field glossary snapshot. */
export const FIELD_GLOSSARY_CACHE_SOURCE_BYTES_LIMIT =
  "field-glossary-cache-source-bytes";
export const FIELD_GLOSSARY_CACHE_RECORDS_LIMIT =
  "field-glossary-cache-records";

/** Retention caps for a parsed glossary kept in memory across requests. */
export interface FieldGlossaryParseLimits {
  /** Upper bound on retained glossary source bytes. */
  readonly maxSourceBytes: number;
  /** Upper bound on retained glossary records. */
  readonly maxRecords: number;
}

/** A parsed glossary record retained for in-memory selection. */
export interface ParsedFieldGlossaryRecord extends PacketFieldRecord {
  /** UTF-8 bytes of the source glossary line; drives the record budget. */
  readonly sourceByteLength: number;
}

/**
 * Lazily parse TShark -G fields lines into detached records, one at a time.
 * Callers that only need one page must use this iterator through
 * {@link selectFieldRecords} so an oversized glossary never materializes
 * every record; callers that retain the glossary must cap the iteration with
 * {@link parseFieldGlossary}. Malformed lines and an empty glossary throw
 * while the iterator is consumed, exactly as the eager parse does.
 */
export function* iterateFieldGlossaryRecords(
  text: string,
): Iterable<ParsedFieldGlossaryRecord> {
  const copy = (value: string) =>
    Buffer.from(value, "utf16le").toString("utf16le");
  let sourceLine = 0;
  // Walk the bounded text once; detach retained fields from the much larger
  // producer string so a retained glossary never pins the raw dump.
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
    yield {
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
    };
  }
  if (sourceLine === 0)
    throw new Error("TShark returned an empty field glossary");
}

/**
 * Parse the whole glossary into retained records. When limits are given,
 * the caps are checked while parsing — before the next record is allocated —
 * so a glossary over the caps raises a `decodeLimit` parse failure instead of
 * materializing every record first. Callers must then answer the page from
 * {@link parseFieldDiscovery}, which selects without retaining.
 */
export const parseFieldGlossary = (
  text: string,
  limits?: FieldGlossaryParseLimits,
): ParsedFieldGlossaryRecord[] => {
  const records: ParsedFieldGlossaryRecord[] = [];
  let sourceBytes = 0;
  for (const record of iterateFieldGlossaryRecords(text)) {
    sourceBytes += record.sourceByteLength;
    if (limits !== undefined) {
      if (sourceBytes > limits.maxSourceBytes)
        throw decodeLimit(
          "tshark -G fields",
          "Field glossary exceeds the cache retention source-bytes cap",
          {
            name: FIELD_GLOSSARY_CACHE_SOURCE_BYTES_LIMIT,
            maximum: limits.maxSourceBytes,
            required: sourceBytes,
          },
        );
      if (records.length + 1 > limits.maxRecords)
        throw decodeLimit(
          "tshark -G fields",
          "Field glossary exceeds the cache retention record cap",
          {
            name: FIELD_GLOSSARY_CACHE_RECORDS_LIMIT,
            maximum: limits.maxRecords,
            required: records.length + 1,
          },
        );
    }
    records.push(record);
  }
  return records;
};

/**
 * Select one page from glossary records. Filtering, paging and the record
 * budget behave exactly as the single-pass scan did, so a cached glossary
 * returns the same page a fresh producer dump would. Accepts any iterable so
 * the streaming path can select without retaining every record.
 */
export const selectFieldRecords = (
  records: Iterable<ParsedFieldGlossaryRecord>,
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

/**
 * Answer one page from a fresh producer dump without retaining the glossary.
 * Records are parsed lazily and only the selected page is allocated, so an
 * oversized glossary stays bounded by the page representation budget.
 */
export const parseFieldDiscovery = (
  text: string,
  input: InspectPacketFieldsInput,
) => selectFieldRecords(iterateFieldGlossaryRecords(text), input);
