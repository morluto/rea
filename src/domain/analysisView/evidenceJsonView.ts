import { z } from "zod";
import type { Evidence } from "../evidence.js";
import { isImmutableJsonSnapshot } from "../immutableJson.js";
import { err, ok } from "../result.js";
import { pageViewCoverage } from "./analysisViewCoverage.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";

/**
 * Default page size when `limit` is omitted, in UTF-8 bytes of the page as an
 * escaped JSON string. With the view Evidence around it the page stays inside
 * the default agent result budget whatever characters it holds.
 */
export const DEFAULT_EVIDENCE_JSON_PAGE_BYTES = 32_768;

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
      "UTF-16 code units in this page. Omit for a page of at most 32768 escaped UTF-8 bytes. A surrogate pair is never split: a page that would end inside one ends before it, or after it when the pair alone exceeds the limit.",
    ),
});

type EvidenceJsonViewRequest = z.output<typeof evidenceJsonViewRequestSchema>;

/**
 * One serialization per immutable retained record. Paging is then O(limit)
 * per call after the first; a mutable inline parent is serialized per call
 * because nothing proves it is unchanged.
 */
const serialized = new WeakMap<object, string>();

const serializeEvidence = (evidence: Evidence): string => {
  if (!isImmutableJsonSnapshot(evidence)) return JSON.stringify(evidence);
  const known = serialized.get(evidence);
  if (known !== undefined) return known;
  const text = JSON.stringify(evidence);
  serialized.set(evidence, text);
  return text;
};

const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** Whether a page ending at `end` would separate a surrogate pair. */
const splitsPair = (text: string, end: number): boolean =>
  end > 0 &&
  end < text.length &&
  isHigh(text.charCodeAt(end - 1)) &&
  isLow(text.charCodeAt(end));

/** UTF-8 bytes one code unit takes inside an escaped JSON string. */
const escapedUnitBytes = (text: string, index: number): number => {
  const unit = text.charCodeAt(index);
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
  if (isHigh(unit)) return isLow(text.charCodeAt(index + 1)) ? 2 : 6;
  if (isLow(unit)) return isHigh(text.charCodeAt(index - 1)) ? 2 : 6;
  return 3;
};

/** The end of the page that `limit`, or the default byte size, selects. */
const pageEnd = (
  text: string,
  offset: number,
  limit: number | undefined,
): number => {
  let end = offset;
  if (limit === undefined) {
    let bytes = 0;
    while (end < text.length) {
      const cost = escapedUnitBytes(text, end);
      if (bytes + cost > DEFAULT_EVIDENCE_JSON_PAGE_BYTES && end > offset)
        break;
      bytes += cost;
      end += 1;
    }
  } else end = Math.min(text.length, offset + limit);
  if (!splitsPair(text, end)) return end;
  // Keep the pair whole: end before it, or after it when it fills the page.
  return end - 1 > offset ? end - 1 : end + 1;
};

/** Page the parent record's own JSON text without interpreting it. */
export const projectEvidenceJsonView = (
  parent: AnalysisViewParent,
  view: EvidenceJsonViewRequest,
) => {
  if (parent.evidence === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view", "kind"],
          reason: "invalid_value",
          message:
            "evidence-json pages a complete Evidence record; select a retained, inline or file Evidence source.",
        },
      ]),
    );
  const text = serializeEvidence(parent.evidence);
  const start = Math.min(view.offset, text.length);
  const end = pageEnd(text, start, view.limit);
  return ok({
    kind: "evidence-json" as const,
    view,
    parent_evidence_id: parent.evidenceId,
    parent_operation: parent.operation,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact ?? null,
    text: text.slice(start, end),
    coverage: pageViewCoverage(view.offset, end - start, text.length),
    limitations: [
      "Pages are UTF-16 code unit ranges of the parent Evidence JSON text, not parsed records; join every page in offset order before parsing. Prefer the producer's own views to select facts.",
    ],
    unknowns: [] as string[],
  });
};
