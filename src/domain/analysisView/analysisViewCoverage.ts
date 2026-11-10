import { uniqueSorted } from "../canonicalOrdering.js";
import { z } from "zod";

export const analysisViewCoverageSchema = z.strictObject({
  status: z.enum(["complete-within-view", "page", "empty"]),
  examined: z.int().nonnegative(),
  total: z.int().nonnegative(),
  next_offset: z.int().nonnegative().nullable(),
  exhausted: z.boolean(),
});

const unavailableViewCoverageSchema = z.strictObject({
  status: z.literal("unavailable"),
  examined: z.literal(0),
  total: z.null(),
  next_offset: z.null(),
  exhausted: z.literal(false),
});

/** Only views with nullable collections can report unavailable page coverage. */
export const nullableCollectionViewCoverageSchema = z.union([
  analysisViewCoverageSchema,
  unavailableViewCoverageSchema,
]);

export type AnalysisViewCoverage = z.output<typeof analysisViewCoverageSchema>;

/** Unrecorded or inapplicable collections have no known total or continuation. */
export const unavailableViewCoverage = (): z.output<
  typeof unavailableViewCoverageSchema
> => ({
  status: "unavailable",
  examined: 0,
  total: null,
  next_offset: null,
  exhausted: false,
});

/** Coverage for a summary, facet, or single selected object. */
export const completeWithinViewCoverage = (
  examined: number,
  total: number,
): AnalysisViewCoverage => ({
  status: "complete-within-view",
  examined,
  total,
  next_offset: null,
  exhausted: true,
});

/** Coverage for a stable page, including an offset past the collection. */
export const pageViewCoverage = (
  offset: number,
  examined: number,
  total: number,
): AnalysisViewCoverage => {
  const exhausted = offset >= total || offset + examined >= total;
  return {
    status: examined === 0 ? "empty" : "page",
    examined,
    total,
    next_offset: exhausted ? null : offset + examined,
    exhausted,
  };
};

/** Per-field repeated MCP message budget, independent of the selected page. */
export const ANALYSIS_VIEW_MESSAGE_BYTE_LIMIT = 256 * 1024;

// A UTF-16 unit needs at most six JSON bytes, or twelve when that JSON is
// escaped into MCP text. Reserve both forms across three Evidence projections.
// This upper bound rejects giant messages without allocating their JSON copies.
const messageWireBytes = (value: string): number => (value.length * 18 + 6) * 3;

/** Deduplicate and bound messages by count and repeated serialized bytes. */
export const boundedViewMessages = (
  values: readonly string[],
  parentEvidenceId: string,
  field: "limitations" | "unknowns",
  required: readonly string[] = [],
): string[] => {
  const priority = uniqueSorted(required);
  const unique = uniqueSorted([...priority, ...values]);
  const notice = (omitted: number): string =>
    `${String(omitted)} additional ${field} omitted from this view; consult source parent Evidence ${parentEvidenceId} for the complete list (the caller-supplied record, or its retaining session).`;
  const totalBytes = unique.reduce(
    (total, value) => total + messageWireBytes(value),
    0,
  );
  if (totalBytes <= ANALYSIS_VIEW_MESSAGE_BYTE_LIMIT) return unique;

  // Reserve notice space only after proving the complete source set does not fit.
  let remaining =
    ANALYSIS_VIEW_MESSAGE_BYTE_LIMIT - messageWireBytes(notice(unique.length));
  const retained = new Set<string>();
  for (const value of [...priority, ...unique]) {
    if (retained.has(value)) continue;
    const bytes = messageWireBytes(value);
    if (bytes > remaining) continue;
    retained.add(value);
    remaining -= bytes;
  }
  const omitted = unique.length - retained.size;
  return omitted === 0
    ? unique
    : [...uniqueSorted([...retained]), notice(omitted)];
};
