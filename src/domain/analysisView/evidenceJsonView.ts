import { z } from "zod";
import type { Evidence } from "../evidence.js";
import { isImmutableJsonSnapshot } from "../immutableJson.js";
import { err, ok } from "../result.js";
import { pageViewCoverage } from "./analysisViewCoverage.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";

/**
 * Default page of serialized Evidence, in UTF-16 code units. JSON-in-JSON
 * escaping grows a page by about a quarter for typical Evidence, so this
 * default stays inside the default agent result budget.
 */
export const DEFAULT_EVIDENCE_JSON_PAGE_CODE_UNITS = 32_768;

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
    .default(DEFAULT_EVIDENCE_JSON_PAGE_CODE_UNITS)
    .describe("UTF-16 code units in this page."),
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

/** A page end that would split a surrogate pair moves back by one unit. */
const pageEnd = (text: string, offset: number, limit: number): number => {
  const end = Math.min(text.length, offset + limit);
  if (end <= offset || end >= text.length) return end;
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  const splitsPair =
    last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return splitsPair && end - 1 > offset ? end - 1 : end;
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
