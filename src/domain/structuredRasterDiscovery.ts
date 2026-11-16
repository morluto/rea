/** Explicit grammar hypotheses, not inference of arbitrary descriptor ABIs. */
export interface StructuredRasterField {
  offset: number;
  byteWidth: 1 | 2 | 4;
}
export interface StructuredRasterGrammar {
  recordStride: number;
  endianness: "little" | "big";
  scanAlignment: number;
  fields: {
    format: StructuredRasterField;
    width: StructuredRasterField;
    height: StructuredRasterField;
    payloadOffset: StructuredRasterField;
    reserved?: StructuredRasterField;
  };
  requireZeroReserved: boolean;
  requireMonotonicOffsets: boolean;
  payloadBase: "table-end";
  maxDimension: number;
  maxFormat: number;
}
export const DEFAULT_STRUCTURED_RASTER_GRAMMAR: StructuredRasterGrammar = {
  recordStride: 12,
  endianness: "little",
  scanAlignment: 2,
  fields: {
    format: { offset: 0, byteWidth: 1 },
    width: { offset: 2, byteWidth: 2 },
    height: { offset: 4, byteWidth: 2 },
    payloadOffset: { offset: 8, byteWidth: 4 },
    reserved: { offset: 6, byteWidth: 2 },
  },
  requireZeroReserved: true,
  requireMonotonicOffsets: true,
  payloadBase: "table-end",
  maxDimension: 4096,
  maxFormat: 15,
};
export interface StructuredRasterRange {
  offset: number;
  length: number;
}
export interface StructuredRasterDiscoveryOptions {
  grammar?: StructuredRasterGrammar;
  coverage?: StructuredRasterRange[];
  minRecords?: number;
  minConsistency?: number;
  maxWork?: number;
  maxTables?: number;
  maxRecords?: number;
  bitsPerPixel?: number[];
  offsetUnits?: number[];
}
export interface StructuredRasterFormatHypothesis {
  bitsPerPixel: number;
  offsetUnit: number;
  matches: number;
  consistency: number;
}
export interface StructuredRasterResource {
  descriptorOffset: number;
  format: number;
  width: number;
  height: number;
  payloadOffset: number;
  status: "unique" | "ambiguous" | "unresolved";
  hypotheses: (StructuredRasterFormatHypothesis & {
    stride: number;
    payloadRange: StructuredRasterRange;
    covered: boolean;
  })[];
}
export interface StructuredRasterTable {
  offset: number;
  length: number;
  recordCount: number;
  formats: {
    format: number;
    comparisons: number;
    hypotheses: StructuredRasterFormatHypothesis[];
  }[];
  resources: StructuredRasterResource[];
}
export interface StructuredRasterReport {
  grammar: StructuredRasterGrammar;
  tables: StructuredRasterTable[];
  coverage: {
    complete: boolean;
    work: number;
    maxWork: number;
    testedPositions: number;
    retainedRecords: number;
    rejectedUncorroboratedTables: number;
    nextOffset: number | null;
    reason: "work-limit" | "table-limit" | "record-limit" | null;
  };
  limitations: string[];
}
const integer = (n: number, name: string, min: number, max: number): number => {
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new RangeError(`${name} must be an integer in ${min}..${max}`);
  return n;
};
/** Every candidate record read and every size-equation comparison consumes work.
 * No source, decoded pixel or palette allocation is performed by this core.
 */
export function discoverStructuredRasters(
  bytes: Uint8Array,
  options: StructuredRasterDiscoveryOptions = {},
  signal?: AbortSignal,
): StructuredRasterReport {
  integer(bytes.length, "materialized bytes", 1, 16 * 1024 * 1024);
  const sourceGrammar = options.grammar ?? DEFAULT_STRUCTURED_RASTER_GRAMMAR;
  const grammar: StructuredRasterGrammar = {
    ...sourceGrammar,
    fields: Object.fromEntries(
      Object.entries(sourceGrammar.fields).map(([key, value]) => [
        key,
        { ...value },
      ]),
    ) as StructuredRasterGrammar["fields"],
  };
  integer(grammar.recordStride, "recordStride", 4, 128);
  integer(grammar.scanAlignment, "scanAlignment", 1, 128);
  if (grammar.recordStride % grammar.scanAlignment !== 0)
    throw new RangeError("recordStride must be divisible by scanAlignment");
  if (grammar.endianness !== "little" && grammar.endianness !== "big")
    throw new RangeError("Unsupported endianness");
  if (grammar.payloadBase !== "table-end")
    throw new RangeError(
      "Only the explicit table-end base hypothesis is supported",
    );
  integer(grammar.maxDimension, "maxDimension", 1, 4096);
  integer(grammar.maxFormat, "maxFormat", 0, 65535);
  if (
    typeof grammar.requireZeroReserved !== "boolean" ||
    typeof grammar.requireMonotonicOffsets !== "boolean"
  )
    throw new RangeError("Grammar predicates must be boolean");
  const occupied = new Set<number>();
  for (const name of [
    "format",
    "width",
    "height",
    "payloadOffset",
    "reserved",
  ] as const) {
    const field = grammar.fields[name];
    if (field === undefined) {
      if (name === "reserved") continue;
      throw new RangeError(`Missing ${name} field`);
    }
    integer(field.offset, `${name}.offset`, 0, grammar.recordStride - 1);
    if (
      ![1, 2, 4].includes(field.byteWidth) ||
      field.offset + field.byteWidth > grammar.recordStride
    )
      throw new RangeError("Field lies outside descriptor record");
    for (let i = field.offset; i < field.offset + field.byteWidth; i++) {
      if (occupied.has(i))
        throw new RangeError("Descriptor fields must not overlap");
      occupied.add(i);
    }
  }
  if (grammar.requireZeroReserved && grammar.fields.reserved === undefined)
    throw new RangeError("Zero-reserved predicate requires a reserved field");
  const minRecords = integer(options.minRecords ?? 8, "minRecords", 2, 4096);
  const minConsistency = options.minConsistency ?? 0.9;
  if (
    !Number.isFinite(minConsistency) ||
    minConsistency < 0.5 ||
    minConsistency > 1
  )
    throw new RangeError("minConsistency must be in 0.5..1");
  const maxWork = integer(options.maxWork ?? 10000000, "maxWork", 1, 50000000);
  const maxTables = integer(options.maxTables ?? 32, "maxTables", 1, 128);
  const maxRecords = integer(
    options.maxRecords ?? 4096,
    "maxRecords",
    minRecords,
    4096,
  );
  const choices = (values: number[], allowed: number[], name: string) => {
    integer(values.length, name + " count", 1, allowed.length);
    if (values.some((v) => !allowed.includes(v)))
      throw new RangeError(`Unsupported ${name}`);
    return [...new Set(values)].sort((a, b) => a - b);
  };
  const bits = choices(
    options.bitsPerPixel ?? [1, 2, 4, 8, 16, 24, 32],
    [1, 2, 4, 8, 16, 24, 32],
    "bitsPerPixel",
  );
  const units = choices(
    options.offsetUnits ?? [1, 2, 4],
    [1, 2, 4],
    "offsetUnits",
  );
  const ranges = options.coverage ?? [{ offset: 0, length: bytes.length }];
  integer(ranges.length, "coverage count", 0, 65536);
  const sorted = ranges
    .map((r) => {
      integer(r.offset, "coverage.offset", 0, bytes.length);
      integer(r.length, "coverage.length", 1, bytes.length);
      if (r.length > bytes.length - r.offset)
        throw new RangeError("Coverage extends beyond materialized bytes");
      return { ...r };
    })
    .sort((a, b) => a.offset - b.offset);
  const coverage: StructuredRasterRange[] = [];
  for (const range of sorted) {
    const last = coverage.at(-1);
    if (last && range.offset <= last.offset + last.length)
      last.length =
        Math.max(last.offset + last.length, range.offset + range.length) -
        last.offset;
    else coverage.push(range);
  }
  const covered = (offset: number, length: number): boolean => {
    if (
      offset < 0 ||
      length <= 0 ||
      offset > bytes.length ||
      length > bytes.length - offset
    )
      return false;
    let low = 0,
      high = coverage.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (coverage[mid]!.offset <= offset) low = mid + 1;
      else high = mid;
    }
    const r = coverage[low - 1];
    return r !== undefined && offset + length <= r.offset + r.length;
  };
  const result: StructuredRasterReport = {
    grammar,
    tables: [],
    coverage: {
      complete: true,
      work: 0,
      maxWork,
      testedPositions: 0,
      retainedRecords: 0,
      rejectedUncorroboratedTables: 0,
      nextOffset: null,
      reason: null,
    },
    limitations: [
      "Explicit descriptor grammar and table-end payload-base hypotheses, not arbitrary ABI inference or verified image identity. Structurally equivalent non-image tables can pass.",
      "Plausible runs with no passing size-consistency hypothesis are counted but omitted, not proven non-images. Unfinished runs are omitted when budgets prevent establishing their table end.",
      "Size consistency does not establish palette/LUT binding, active colors, alpha, channel order, bit order or row direction. No palette is inferred.",
      "Only maximal runs on the selected alignment and covered logical bytes are considered. Gaps are not zero-filled evidence. Empty output never proves absence.",
      "Unique means one retained bpp/offset-unit size hypothesis, not a verified format. Ambiguous alternatives and uncovered payloads remain explicit.",
      "nextOffset is a restart hint, not a lossless cursor. Work or retention limits may leave tables unreported; raising budgets or selecting a smaller range can help.",
    ],
  };
  signal?.throwIfAborted();
  const spend = () => {
    signal?.throwIfAborted();
    if (result.coverage.work === maxWork) return false;
    result.coverage.work++;
    return true;
  };
  const stop = (
    reason: NonNullable<StructuredRasterReport["coverage"]["reason"]>,
    offset: number,
  ) => {
    result.coverage.complete = false;
    result.coverage.reason = reason;
    result.coverage.nextOffset = offset;
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    little = grammar.endianness === "little";
  const readField = (at: number, f: StructuredRasterField) =>
    f.byteWidth === 1
      ? view.getUint8(at + f.offset)
      : f.byteWidth === 2
        ? view.getUint16(at + f.offset, little)
        : view.getUint32(at + f.offset, little);
  type RecordValue = {
    descriptorOffset: number;
    format: number;
    width: number;
    height: number;
    payloadOffset: number;
  };
  const read = (at: number): RecordValue | null => {
    if (!covered(at, grammar.recordStride)) return null;
    const f = grammar.fields,
      format = readField(at, f.format),
      width = readField(at, f.width),
      height = readField(at, f.height);
    if (
      format > grammar.maxFormat ||
      width < 1 ||
      height < 1 ||
      width > grammar.maxDimension ||
      height > grammar.maxDimension
    )
      return null;
    if (grammar.requireZeroReserved && readField(at, f.reserved!) !== 0)
      return null;
    return {
      descriptorOffset: at,
      format,
      width,
      height,
      payloadOffset: readField(at, f.payloadOffset),
    };
  };
  // Per alignment phase retain the end of the previously visited maximal run.
  // There are at most 128 phases, rather than one retained marker per source byte.
  const visitedEnd = new Map<number, number>();
  scan: for (
    let at = 0;
    at + grammar.recordStride <= bytes.length;
    at += grammar.scanAlignment
  ) {
    const phase = at % grammar.recordStride;
    if (at < (visitedEnd.get(phase) ?? 0)) continue;
    if (!spend()) {
      stop("work-limit", at);
      break;
    }
    result.coverage.testedPositions++;
    const first = read(at);
    if (first === null) continue;
    const records: RecordValue[] = [first];
    let cursor = at + grammar.recordStride;
    while (cursor + grammar.recordStride <= bytes.length) {
      if (!spend()) {
        stop("work-limit", at);
        break scan;
      }
      const next = read(cursor);
      if (next === null) break;
      if (
        grammar.requireMonotonicOffsets &&
        next.payloadOffset < records.at(-1)!.payloadOffset
      )
        break;
      if (records.length + result.coverage.retainedRecords >= maxRecords) {
        stop("record-limit", at);
        break scan;
      }
      records.push(next);
      cursor += grammar.recordStride;
    }
    visitedEnd.set(phase, cursor);
    if (records.length < minRecords) continue;
    const pairsByFormat = new Map<
      number,
      { record: RecordValue; delta: number }[]
    >();
    for (const record of records)
      if (!pairsByFormat.has(record.format))
        pairsByFormat.set(record.format, []);
    for (let i = 0; i + 1 < records.length; i++) {
      const record = records[i]!;
      pairsByFormat.get(record.format)!.push({
        record,
        delta: records[i + 1]!.payloadOffset - record.payloadOffset,
      });
    }
    const formatValues = [...pairsByFormat.keys()].sort((a, b) => a - b);
    const formats: StructuredRasterTable["formats"] = [];
    for (const format of formatValues) {
      const pairs = pairsByFormat.get(format)!;
      const hypotheses: StructuredRasterFormatHypothesis[] = [];
      if (pairs.length > 0)
        for (const bitsPerPixel of bits)
          for (const offsetUnit of units) {
            let matches = 0;
            for (const { record, delta } of pairs) {
              if (!spend()) {
                stop("work-limit", at);
                break scan;
              }
              if (
                Math.ceil((record.width * bitsPerPixel) / 8) * record.height ===
                delta * offsetUnit
              )
                matches++;
            }
            const consistency = matches / pairs.length;
            if (consistency >= minConsistency)
              hypotheses.push({
                bitsPerPixel,
                offsetUnit,
                matches,
                consistency,
              });
          }
      formats.push({ format, comparisons: pairs.length, hypotheses });
    }
    if (!formats.some((f) => f.hypotheses.length > 0)) {
      result.coverage.rejectedUncorroboratedTables++;
      continue;
    }
    if (result.tables.length === maxTables) {
      stop("table-limit", at);
      break;
    }
    const byFormat = new Map(formats.map((f) => [f.format, f.hypotheses]));
    const resources: StructuredRasterResource[] = records.map((record) => {
      const hypotheses = (byFormat.get(record.format) ?? []).map((h) => {
        const stride = Math.ceil((record.width * h.bitsPerPixel) / 8),
          length = stride * record.height,
          offset = cursor + record.payloadOffset * h.offsetUnit;
        return {
          ...h,
          stride,
          payloadRange: { offset, length },
          covered: covered(offset, length),
        };
      });
      return {
        ...record,
        status:
          hypotheses.length === 0
            ? "unresolved"
            : hypotheses.length === 1
              ? "unique"
              : "ambiguous",
        hypotheses,
      };
    });
    result.tables.push({
      offset: at,
      length: cursor - at,
      recordCount: records.length,
      formats,
      resources,
    });
    result.coverage.retainedRecords += records.length;
  }
  return result;
}
