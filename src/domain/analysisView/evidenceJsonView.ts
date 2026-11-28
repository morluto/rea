import { z } from "zod";
import type { Evidence } from "../evidence.js";
import { Budget } from "../budget.js";
import { isImmutableJsonSnapshot } from "../immutableJson.js";
import { DEFAULT_AGENT_RESULT_BUDGET_BYTES } from "../analysisResourceLimits.js";
import { jsonParts } from "../jsonSerialization.js";
import { ok } from "../result.js";
import { pageViewCoverage } from "./analysisViewCoverage.js";
import { invalidAnalysisView } from "./analysisViewErrors.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";

/** Room for the view Evidence around a page: identity, source and coverage. */
const EVIDENCE_JSON_PAGE_ENVELOPE_BYTES = 8_192;

/**
 * Default page size when `limit` is omitted, in UTF-8 bytes of the page as an
 * escaped JSON string. With the view Evidence around it the page stays inside
 * the default agent result budget whatever characters it holds.
 */
export const DEFAULT_EVIDENCE_JSON_PAGE_BYTES =
  DEFAULT_AGENT_RESULT_BUDGET_BYTES - EVIDENCE_JSON_PAGE_ENVELOPE_BYTES;

/**
 * Largest page. Escaping one code unit as `\uXXXX` takes six bytes, so a full
 * page of escaped text stays within the 10 MiB stdio frame floor.
 */
export const MAXIMUM_EVIDENCE_JSON_PAGE_CODE_UNITS = 1_048_576;

export const evidenceJsonViewRequestSchema = z.strictObject({
  kind: z
    .literal("evidence-json")
    .describe(
      "Page the exact JSON serialization of the complete parent Evidence. Concatenating every page's text in offset order reproduces it; JSON.parse restores the retained record.",
    ),
  offset: z
    .int()
    .nonnegative()
    .default(0)
    .describe("UTF-16 code unit offset; follow coverage.next_offset."),
  limit: z
    .int()
    .positive()
    .max(MAXIMUM_EVIDENCE_JSON_PAGE_CODE_UNITS)
    .optional()
    .describe(
      `UTF-16 code units in this page. Omit for a page of at most ${String(DEFAULT_EVIDENCE_JSON_PAGE_BYTES)} escaped UTF-8 bytes. A surrogate pair is never split: a page that would end inside one ends before it, or after it when the pair alone exceeds the limit.`,
    ),
});

type EvidenceJsonViewRequest = z.output<typeof evidenceJsonViewRequestSchema>;

interface SerializedEvidenceJson {
  readonly chunks: readonly string[];
  /** Cumulative UTF-16 code unit start of each chunk, ending with `totalLength`. */
  readonly starts: readonly number[];
  readonly totalLength: number;
}

/**
 * Code units of serialized Evidence kept across calls, summed over records.
 * It is a delivery cache, not an admission limit: a record that does not fit
 * is still paged, by a streaming pass that keeps only the requested window.
 */
export const EVIDENCE_JSON_CACHE_CODE_UNITS = 16 * 1024 * 1024;

/** Units kept around a window: one before it for surrogate checks, one after. */
const WINDOW_MARGIN_CODE_UNITS = 2;

/**
 * Serialize `evidence` once with `jsonParts`, so records past Node's single
 * string limit stay pageable. It keeps every part while the total fits
 * `wholeLimit`; past that it keeps only parts overlapping `[from, to)`, so
 * memory stays bounded by the window. Offsets in `starts` stay absolute.
 */
const scanSerializedChunks = (
  evidence: Evidence,
  wholeLimit: number,
  from: number,
  to: number,
): SerializedEvidenceJson & { readonly whole: boolean } => {
  let chunks: string[] = [];
  let starts: number[] = [];
  let whole = true;
  let totalLength = 0;
  for (const part of jsonParts(evidence)) {
    if (part.length === 0) continue;
    const start = totalLength;
    totalLength += part.length;
    if (whole && totalLength > wholeLimit) {
      whole = false;
      const kept = chunks.flatMap((chunk, index) =>
        starts[index]! + chunk.length > from && starts[index]! < to
          ? [[chunk, starts[index]!] as const]
          : [],
      );
      chunks = kept.map(([chunk]) => chunk);
      starts = kept.map(([, at]) => at);
    }
    if (whole || (totalLength > from && start < to)) {
      starts.push(start);
      chunks.push(part);
    }
  }
  starts.push(totalLength);
  return { chunks, starts, totalLength, whole };
};

interface CacheEntry {
  /** Weak, so a cached record is released when its owner releases it. */
  readonly record: WeakRef<object>;
  readonly codeUnits: number;
}

/**
 * Whole serializations of immutable records, least recently used first, so
 * repeated paging of a record is O(log(chunks) + limit). Their total stays
 * within the cache's code units. Records are held weakly: the cache never
 * extends a record's lifetime, and a collected record's units are released.
 * A mutable inline parent is never cached because nothing proves it is
 * unchanged; it and any record too large to fit are paged from a window.
 */
export class EvidenceJsonSerializationCache {
  readonly #documents = new WeakMap<
    object,
    { readonly document: SerializedEvidenceJson; readonly entry: CacheEntry }
  >();
  readonly #order = new Set<CacheEntry>();
  readonly #collected = new FinalizationRegistry<CacheEntry>((entry) => {
    if (this.#order.delete(entry)) this.#budget.refund(entry.codeUnits);
  });
  readonly #budget: Budget;

  constructor(readonly maximumCodeUnits = EVIDENCE_JSON_CACHE_CODE_UNITS) {
    this.#budget = new Budget(maximumCodeUnits);
  }

  /** Code units of the whole serializations currently cached. */
  get cachedCodeUnits(): number {
    return this.#budget.used;
  }

  /** Whether `record`'s whole serialization is cached. */
  holds(record: object): boolean {
    return this.#documents.has(record);
  }

  /** The serialization one page of `evidence` reads. */
  serialize(
    evidence: Evidence,
    offset: number,
    limit: number | undefined,
  ): SerializedEvidenceJson {
    const cacheable = isImmutableJsonSnapshot(evidence);
    if (cacheable) {
      const known = this.#documents.get(evidence);
      if (known !== undefined) {
        this.#order.delete(known.entry);
        this.#order.add(known.entry);
        return known.document;
      }
    }
    // A default page is at most DEFAULT_EVIDENCE_JSON_PAGE_BYTES escaped
    // bytes, and every code unit escapes to at least one byte.
    const window = limit ?? DEFAULT_EVIDENCE_JSON_PAGE_BYTES;
    const document = scanSerializedChunks(
      evidence,
      cacheable ? this.maximumCodeUnits : 0,
      Math.max(0, offset - WINDOW_MARGIN_CODE_UNITS),
      offset + window + WINDOW_MARGIN_CODE_UNITS,
    );
    if (document.whole && cacheable) this.#remember(evidence, document);
    return document;
  }

  #remember(record: object, document: SerializedEvidenceJson): void {
    const charged = this.#budget.chargeEvicting(document.totalLength, () => {
      const oldest = this.#order.values().next().value;
      if (oldest === undefined) return undefined;
      this.#order.delete(oldest);
      this.#collected.unregister(oldest);
      const evicted = oldest.record.deref();
      if (evicted !== undefined) this.#documents.delete(evicted);
      return oldest.codeUnits;
    });
    if (!charged) return;
    const entry: CacheEntry = {
      record: new WeakRef(record),
      codeUnits: document.totalLength,
    };
    this.#documents.set(record, { document, entry });
    this.#order.add(entry);
    this.#collected.register(record, entry, entry);
  }
}

const sharedSerializations = new EvidenceJsonSerializationCache();

/** Chunk index containing UTF-16 offset `index` (`0 <= index < doc.totalLength`). */
const locateChunk = (doc: SerializedEvidenceJson, index: number): number => {
  let low = 0;
  let high = doc.chunks.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (doc.starts[mid]! <= index) low = mid;
    else high = mid - 1;
  }
  return low;
};

const codeUnitAt = (doc: SerializedEvidenceJson, index: number): number => {
  const chunkIndex = locateChunk(doc, index);
  return doc.chunks[chunkIndex]!.charCodeAt(index - doc.starts[chunkIndex]!);
};

const sliceChunks = (
  doc: SerializedEvidenceJson,
  start: number,
  end: number,
): string => {
  if (end <= start) return "";
  const first = locateChunk(doc, start);
  const last = locateChunk(doc, end - 1);
  if (first === last) {
    const base = doc.starts[first]!;
    return doc.chunks[first]!.slice(start - base, end - base);
  }
  const parts: string[] = [];
  for (let index = first; index <= last; index += 1) {
    const chunk = doc.chunks[index]!;
    const base = doc.starts[index]!;
    const from = index === first ? start - base : 0;
    const to = index === last ? end - base : chunk.length;
    parts.push(chunk.slice(from, to));
  }
  return parts.join("");
};

const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** Whether `boundary` sits between the two halves of a surrogate pair. */
const splitsPair = (doc: SerializedEvidenceJson, boundary: number): boolean =>
  boundary > 0 &&
  boundary < doc.totalLength &&
  isHigh(codeUnitAt(doc, boundary - 1)) &&
  isLow(codeUnitAt(doc, boundary));

/** UTF-8 bytes one code unit takes inside an escaped JSON string. */
const escapedUnitBytes = (
  unit: number,
  doc: SerializedEvidenceJson,
  index: number,
): number => {
  if (unit === 0x22 || unit === 0x5c) return 2;
  if (unit < 0x20)
    return unit === 0x08 ||
      unit === 0x09 ||
      unit === 0x0a ||
      unit === 0x0c ||
      unit === 0x0d
      ? 2
      : 6;
  if (unit < 0x80) return 1;
  if (unit < 0x800) return 2;
  // A paired surrogate is half of one four-byte character; a lone one is escaped.
  if (isHigh(unit))
    return index + 1 < doc.totalLength && isLow(codeUnitAt(doc, index + 1))
      ? 2
      : 6;
  if (isLow(unit))
    return index > 0 && isHigh(codeUnitAt(doc, index - 1)) ? 2 : 6;
  return 3;
};

/** The end of the page that `limit`, or the default byte size, selects. */
const pageEnd = (
  doc: SerializedEvidenceJson,
  offset: number,
  limit: number | undefined,
): number => {
  let end = offset;
  if (limit === undefined) {
    if (offset < doc.totalLength) {
      let chunkIndex = locateChunk(doc, offset);
      let inChunk = offset - doc.starts[chunkIndex]!;
      let bytes = 0;
      while (end < doc.totalLength) {
        const chunk = doc.chunks[chunkIndex]!;
        const cost = escapedUnitBytes(chunk.charCodeAt(inChunk), doc, end);
        if (bytes + cost > DEFAULT_EVIDENCE_JSON_PAGE_BYTES && end > offset)
          break;
        bytes += cost;
        end += 1;
        inChunk += 1;
        if (inChunk === chunk.length) {
          chunkIndex += 1;
          inChunk = 0;
        }
      }
    }
  } else end = Math.min(doc.totalLength, offset + limit);
  if (!splitsPair(doc, end)) return end;
  // Keep the pair whole: end before it, or after it when it fills the page.
  return end - 1 > offset ? end - 1 : end + 1;
};

/** Page the parent record's own JSON text without interpreting it. */
export const projectEvidenceJsonView = (
  parent: AnalysisViewParent,
  view: EvidenceJsonViewRequest,
  serializations: EvidenceJsonSerializationCache = sharedSerializations,
) => {
  if (parent.evidence === undefined)
    return invalidAnalysisView(
      "evidence-json pages a complete Evidence record; select a retained, inline or file Evidence source.",
      "kind",
    );
  const doc = serializations.serialize(
    parent.evidence,
    view.offset,
    view.limit,
  );
  const start = Math.min(view.offset, doc.totalLength);
  if (splitsPair(doc, start))
    return invalidAnalysisView(
      "Evidence JSON offset splits a UTF-16 surrogate pair.",
      "offset",
    );
  const end = pageEnd(doc, start, view.limit);
  return ok({
    kind: "evidence-json" as const,
    view,
    parent_evidence_id: parent.evidenceId,
    parent_operation: parent.operation,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact ?? null,
    text: sliceChunks(doc, start, end),
    coverage: pageViewCoverage(view.offset, end - start, doc.totalLength),
    limitations: [
      "Pages are UTF-16 code unit ranges of the parent Evidence JSON text, not parsed records; join every page in offset order before parsing. Prefer the producer's own views to select facts.",
    ],
    unknowns: [] as string[],
  });
};
