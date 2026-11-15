// Counts optional parsed facts defaulted to an observed value in comparison,
// coverage and count code: a property read followed by `?? 0`, `?? []` or
// `?? false`, with any whitespace (including line breaks) around `??`.
// Map accumulators (`map.get(k) ?? []`) and indexed reads (`bytes[i] ?? 0`)
// end in `)` or `]`, not a property name, so they are not counted.
const optionalFactDefault =
  /\??\.[a-z_][\w$]*\s*\?\?\s*(?:0|\[\]|false)(?![\w.$])/gu;

const comparisonOrCountFile =
  /\/[^/]*(?:compar|diff|delta|reconcil|coverage|summar|count|match)[^/]*\.ts$/iu;

/** @param {string} path */
export const isComparisonOrCountFile = (path) =>
  comparisonOrCountFile.test(path);

/** @param {string} content */
export const optionalFactDefaultCount = (content) =>
  content.match(optionalFactDefault)?.length ?? 0;
