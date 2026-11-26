// The TargetFailure model (#14239) is the only vocabulary for why a target
// could not be read. These retired carriers and spellings must not return:
// each one restated a kind the model owns. Worker protocols use the model's
// kinds (`malformed`, `truncated`) on the wire, too.
const RETIRED_TARGET_FAILURE_VOCABULARY = [
  /\bAnalysisUnsupportedTargetError\b/u,
  /\bAnalysisMalformedTargetError\b/u,
  /\bMachoReadIssue\b/u,
  /\bFatSliceRangeIssue\b/u,
  /\bformat_failure\b/u,
  // A "format" failure reason in TypeScript, on a JSON wire, or in a Python
  // bridge's failure constructor.
  /\breason\s*(?::|===|!==)\s*["']format["']/u,
  /"reason"\s*:\s*"format"/u,
  /Failure\(\s*["']format["']\s*,/u,
  // A failure-kind union that spells malformed bytes as "format" beside a
  // TargetFailure kind. Unrelated "format" kinds (a desktop draft change, a
  // `Pick<..., "format" | ...>` field list) are not failure unions.
  /["']format["']\s*\|\s*["'](?:unsupported|malformed|truncated|unrecognized)["']/u,
  /["'](?:unsupported|malformed|truncated|unrecognized)["']\s*\|\s*["']format["']/u,
];

/** Whether source text reintroduces a retired target-failure vocabulary. */
export const usesRetiredTargetFailureVocabulary = (content) =>
  RETIRED_TARGET_FAILURE_VOCABULARY.some((pattern) => pattern.test(content));
