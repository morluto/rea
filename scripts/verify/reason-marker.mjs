// Counts a guard's matches in raw source, skipping the ones a reason marker
// exempts. A marker is a line comment `// <name>: <reason>` with a non-empty
// reason, either trailing the matched line or in the run of whole-line
// comments directly above it. A marker without a reason exempts nothing.
//
// Matches are taken from code with whole-line `//` comments and block comments
// blanked (newlines kept), the same text the architecture guards count, so a
// pattern counts the same sites with or without this helper.

const blankComments = (raw) =>
  raw
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " "))
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");

const markerIn = (comment, names) =>
  names.some((name) => new RegExp(`//\\s*${name}:\\s*\\S`, "u").test(comment));

const exempted = (lines, index, names) => {
  if (markerIn(lines[index] ?? "", names)) return true;
  for (let above = index - 1; above >= 0; above -= 1) {
    const line = lines[above].trimStart();
    if (!line.startsWith("//")) return false;
    if (markerIn(line, names)) return true;
  }
  return false;
};

/**
 * @param {string} raw
 * @param {RegExp} pattern a global pattern
 * @param {readonly string[]} names
 */
export const unmarkedMatchCount = (raw, pattern, names) => {
  const lines = raw.split("\n");
  const code = blankComments(raw);
  let count = 0;
  for (const match of code.matchAll(pattern)) {
    const line = code.slice(0, match.index).split("\n").length - 1;
    if (!exempted(lines, line, names)) count += 1;
  }
  return count;
};
