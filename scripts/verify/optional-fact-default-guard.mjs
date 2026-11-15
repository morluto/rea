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
// The counter reads unstripped source: it matches defaults in code with
// comments blanked out (offsets and line breaks kept), and reads exemption
// markers from the original lines.
const optionalFactDefault =
  /\??\.[a-z_][\w$]*\s*\?\?\s*(?:0|\[\]|false)(?![\w.$])/gu;

// The reason must say something; a bare marker does not exempt a default.
const exemptionMarker = /optional-fact-default:\s*\S+(?:\s+\S+){2,}/u;

const comparisonOrCountFile =
  /\/[^/]*(?:compar|diff|delta|reconcil|coverage|summar|count|match)[^/]*\.ts$/iu;

/** @param {string} path */
export const isComparisonOrCountFile = (path) =>
  comparisonOrCountFile.test(path);

/**
 * Replace comment text with spaces, keeping line breaks, so offsets and line
 * numbers still match the source. String and template literals are skipped so
 * `"https://…"` is not a comment. Regular expression literals are not
 * recognised; a `//` or `/*` inside one would blank the rest of its line.
 * @param {string} source
 */
export const blankComments = (source) => {
  let out = "";
  let index = 0;
  const blank = (text) => text.replace(/[^\n]/gu, " ");
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(index, stop));
      index = stop;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(index, stop));
      index = stop;
    } else if (char === '"' || char === "'" || char === "`") {
      let stop = index + 1;
      while (stop < source.length && source[stop] !== char) {
        if (source[stop] === "\\") stop += 1;
        stop += 1;
      }
      stop = Math.min(stop + 1, source.length);
      out += source.slice(index, stop);
      index = stop;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
};

/** @param {string} source unstripped source, comments included */
export const optionalFactDefaultCount = (source) => {
  const code = blankComments(source);
  const lines = source.split("\n");
  let count = 0;
  for (const match of code.matchAll(optionalFactDefault)) {
    const start = code.slice(0, match.index).split("\n").length - 1;
    const end = start + match[0].split("\n").length - 1;
    const exempt = lines
      .slice(Math.max(0, start - 1), end + 1)
      .some((line) => exemptionMarker.test(line));
    if (!exempt) count += 1;
  }
  return count;
};
