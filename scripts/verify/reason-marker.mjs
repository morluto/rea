// Counts a guard's matches in source, skipping the ones a reason marker
// exempts. A marker is a line comment `// <name>: <reason>` with a non-empty
// reason, either trailing the matched line or in the run of whole-line
// comments directly above it. A marker without a reason exempts nothing, and
// marker text inside a block comment or a string is not a marker.
//
// One pass separates comments from code, so a quote inside a comment or `//`
// inside a string cannot be mistaken for the other. Matches are taken from the
// code with every comment blanked (newlines kept).

const token =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`/gu;

const blank = (text) => text.replace(/[^\n]/gu, " ");

/** The code with comments blanked, and each line's `//` comment. */
const scan = (raw) => {
  const lineComments = new Map();
  let code = "";
  let last = 0;
  let line = 0;
  for (const match of raw.matchAll(token)) {
    const before = raw.slice(last, match.index);
    code += before;
    line += before.split("\n").length - 1;
    const [text] = match;
    if (text.startsWith("//")) lineComments.set(line, text);
    code += text.startsWith("/") ? blank(text) : text;
    line += text.split("\n").length - 1;
    last = match.index + text.length;
  }
  return { code: code + raw.slice(last), lineComments };
};

const markerIn = (comment, names) =>
  comment !== undefined &&
  names.some((name) => new RegExp(`^//\\s*${name}:\\s*\\S`, "u").test(comment));

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
 * @param {string} raw
 * @param {RegExp} pattern a global pattern
 * @param {readonly string[]} names
 */
export const unmarkedMatchCount = (raw, pattern, names) => {
  const { code, lineComments } = scan(raw);
  const source = { codeLines: code.split("\n"), lineComments };
  let count = 0;
  for (const match of code.matchAll(pattern)) {
    const line = code.slice(0, match.index).split("\n").length - 1;
    if (!exempted(source, line, names)) count += 1;
  }
  return count;
};
