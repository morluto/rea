import { digestCanonicalValue } from "./canonicalDigest.js";

import type {
  BrowserScenarioArtifactKind,
  BrowserScenarioDiff,
  BrowserScenarioNormalization,
  BrowserScenarioNormalizationRule,
} from "./browserScenarioDiffValues.js";

const BUILT_IN_RULES = [
  "ignore_step_elapsed_ms",
  "ignore_event_sequence",
  "ignore_event_step_index",
  "compare_screenshot_content_digest",
  "compare_normalized_text_content",
] as const;

/** Canonically order and commit a parsed browser scenario normalization policy. */
export const commitBrowserScenarioNormalization = (
  input: BrowserScenarioNormalization,
): BrowserScenarioDiff["normalization"] => {
  const rules = [...input.rules]
    .map((rule) => ({
      ...rule,
      artifacts: [...rule.artifacts].sort(),
    }))
    .sort((left, right) =>
      left.rule_id < right.rule_id ? -1 : left.rule_id > right.rule_id ? 1 : 0,
    );
  const commitment = { built_in_rules: [...BUILT_IN_RULES], rules };
  return {
    ...commitment,
    sha256: digestCanonicalValue(commitment, "Browser scenario"),
  };
};

/** Digest one artifact after applying committed exact-literal rules. */
export const digestNormalizedScenarioValue = (
  value: unknown,
  artifact: BrowserScenarioArtifactKind,
  rules: readonly BrowserScenarioNormalizationRule[],
): string =>
  digestCanonicalValue(normalize(value, artifact, rules), "Browser scenario");

const normalize = (
  value: unknown,
  artifact: BrowserScenarioArtifactKind,
  rules: readonly BrowserScenarioNormalizationRule[],
): unknown => {
  if (artifact === "screenshot") return value;
  if (typeof value === "string")
    return rules
      .filter(({ artifacts }) => artifacts.includes(artifact))
      .reduce(
        (normalized, rule) =>
          normalized.split(rule.match).join(rule.replacement),
        value,
      );
  if (Array.isArray(value))
    return value.map((item) => normalize(item, artifact, rules));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      normalize(item, artifact, rules),
    ]),
  );
};
