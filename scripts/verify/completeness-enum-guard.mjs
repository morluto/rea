// Counts local zod enums that spell a completeness vocabulary: their literal
// list contains "complete". A detail level (`"complete" | "summary"`) chooses
// how much to return, not what was examined, so a list with "summary" is not
// counted. Whitespace, including line breaks, may separate `z`, `.enum(` and
// `[`, so a formatter's chained layout (`z\n  .enum([...])`) is counted like
// the inline one.
//
// An enum whose "complete" is not coverage carries a reason marker on the line
// of its `z` (or in the comment run directly above it) (#11409):
// `// detail-level: <reason>` for a caller-chosen amount of output,
// `// lifecycle-state: <reason>` for how far a command, session or capture
// got, and `// domain-vocabulary: <reason>` for a format's or tool's own
// states that are not an examined universe.

import { unmarkedMatchCount } from "./reason-marker.mjs";

const zodEnumLiterals = /\bz\s*\.\s*enum\s*\(\s*\[([^\]]*)\]/gu;

export const COMPLETENESS_ENUM_MARKERS = [
  "detail-level",
  "lifecycle-state",
  "domain-vocabulary",
];

const isCompletenessVocabulary = ([, literals]) =>
  literals.includes('"complete"') && !literals.includes('"summary"');

/**
 * @param {string} content source with comments blanked (`blankComments`)
 * @param {{ readonly source: string } | undefined} file the raw source, read
 *   for reason markers
 */
export const localCompletenessEnumCount = (content, file) =>
  file === undefined
    ? [...content.matchAll(zodEnumLiterals)].filter(isCompletenessVocabulary)
        .length
    : unmarkedMatchCount(
        file.source,
        zodEnumLiterals,
        COMPLETENESS_ENUM_MARKERS,
        isCompletenessVocabulary,
      );
