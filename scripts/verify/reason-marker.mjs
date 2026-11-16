// Counts a guard's matches in source, skipping the ones a reason marker
// exempts. A marker is a line comment `// <name>: <reason>` with a non-empty
// reason, either trailing the matched line or in the run of whole-line
// comments directly above it. A marker without a reason exempts nothing, and
// marker text inside a block comment, a string, a template or a regular
// expression is not a marker.
//
// Comments come from source-tokens.mjs, which tells them apart from strings,
// templates (including `${…}` substitutions) and regular expressions. Matches
// are taken from the code with every comment blanked (newlines kept).

import { blankComments, tokenize } from "./source-tokens.mjs";

const newlines = (text) => text.split("\n").length - 1;

/** The code with comments blanked, and each line's `//` comment. */
const scan = (raw) => {
  const { comments } = tokenize(raw);
  const lineComments = new Map();
  let last = 0;
  let line = 0;
  for (const { text, end } of comments) {
    const start = end - text.length;
    line += newlines(raw.slice(last, start));
    if (text.startsWith("//")) lineComments.set(line, text);
    line += newlines(text);
    last = end;
  }
  return { code: blankComments(raw, comments), lineComments };
};

/**
 * Whether a comment is a `// <name>: <reason>` marker with a non-empty reason.
 * @param {string} comment
 * @param {string} name
 */
export const isReasonMarker = (comment, name) =>
  new RegExp(`^//\\s*${name}:\\s*\\S`, "u").test(comment);

const markerIn = (comment, names) =>
  comment !== undefined && names.some((name) => isReasonMarker(comment, name));

const exempted = ({ codeLines, lineComments }, index, names) => {
  if (markerIn(lineComments.get(index), names)) return true;
  for (let above = index - 1; above >= 0; above -= 1) {
    const comment = lineComments.get(above);
    if (comment === undefined || codeLines[above].trim() !== "") return false;
    if (markerIn(comment, names)) return true;
  }
  return false;
};

/**
 * The zero-based numbers of the code lines a marker exempts.
 * @param {string} raw
 * @param {readonly string[]} names
 * @returns {Set<number>}
 */
export const markedLineNumbers = (raw, names) => {
  const { code, lineComments } = scan(raw);
  const source = { codeLines: code.split("\n"), lineComments };
  const marked = new Set();
  source.codeLines.forEach((text, index) => {
    if (text.trim() !== "" && exempted(source, index, names)) marked.add(index);
  });
  return marked;
};

/**
 * @param {string} raw
 * @param {RegExp} pattern a global pattern
 * @param {readonly string[]} names
 * @param {(match: RegExpMatchArray) => boolean} [counts] which matches the
 *   guard counts at all; the rest are neither counted nor exempted
 */
export const unmarkedMatchCount = (
  raw,
  pattern,
  names,
  counts = () => true,
) => {
  const { code, lineComments } = scan(raw);
  const source = { codeLines: code.split("\n"), lineComments };
  let count = 0;
  for (const match of code.matchAll(pattern)) {
    if (!counts(match)) continue;
    const line = newlines(code.slice(0, match.index));
    if (!exempted(source, line, names)) count += 1;
  }
  return count;
};
