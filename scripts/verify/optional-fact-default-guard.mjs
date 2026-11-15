// Counts optional parsed facts defaulted to an observed value in comparison,
// coverage and count code: a property read followed by `?? 0`, `?? []` or
// `?? false`, with any whitespace (including line breaks) around `??`.
// Map accumulators (`map.get(k) ?? []`) and indexed reads (`bytes[i] ?? 0`)
// end in `)` or `]`, not a property name, so they are not counted.
//
// A default that is legitimate (a request default such as a pagination
// offset, a library field that is optional by contract, or absence that is
// modelled elsewhere) carries a comment on its line or the line before:
// `// optional-fact-default: <why the default is not an observation>`.
// The counter reads unstripped source and skips matches in comment lines.
const optionalFactDefault =
  /\??\.[a-z_][\w$]*\s*\?\?\s*(?:0|\[\]|false)(?![\w.$])/gu;

// The reason must say something; a bare marker does not exempt a default.
const exemptionMarker = /optional-fact-default:\s*\S+(?:\s+\S+){2,}/u;

const commentLine = /^\s*(?:\/\/|\/?\*)/u;

const comparisonOrCountFile =
  /\/[^/]*(?:compar|diff|delta|reconcil|coverage|summar|count|match)[^/]*\.ts$/iu;

/** @param {string} path */
export const isComparisonOrCountFile = (path) =>
  comparisonOrCountFile.test(path);

/** @param {string} content */
export const optionalFactDefaultCount = (content) => {
  const lines = content.split("\n");
  let count = 0;
  for (const match of content.matchAll(optionalFactDefault)) {
    const start = content.slice(0, match.index).split("\n").length - 1;
    const end = start + match[0].split("\n").length - 1;
    if (commentLine.test(lines[start] ?? "")) continue;
    const exempt = lines
      .slice(Math.max(0, start - 1), end + 1)
      .some((line) => exemptionMarker.test(line));
    if (!exempt) count += 1;
  }
  return count;
};
