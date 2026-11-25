import { countedFindings, readBaseline } from "./counted-findings.mjs";

/**
 * Files that predate the rule, with their count of untyped constructions. A
 * count may only shrink: the rule reports a file above or below its entry.
 */
const baseline = readBaseline("./typed-resource-refusal-baseline.json");

/** Option keys that type a resource constraint's recovery. */
const TYPED_KEYS = new Set([
  "fixedAllowance",
  "limit",
  "remediationAction",
  "measuredExhaustion",
]);

const keyName = (property) =>
  property.key?.type === "Identifier"
    ? property.key.name
    : property.key?.type === "Literal"
      ? String(property.key.value)
      : undefined;

/**
 * Options typed elsewhere (a helper call, a variable or a spread) are trusted;
 * the rule flags only constructions that visibly name no recovery.
 */
const isTyped = (options) => {
  if (options === undefined) return false;
  if (options.type !== "ObjectExpression") return true;
  return options.properties.some(
    (property) =>
      property.type === "SpreadElement" || TYPED_KEYS.has(keyName(property)),
  );
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Type each resource refusal so recovery never falls back to generic worker-limit text.",
    },
    schema: [],
    messages: {
      untyped:
        "Type this resource constraint: pass fixedAllowanceOptions(...) for a fixed ceiling, an AnalysisSettingLimit `limit` for an adjustable budget, an authored remediationAction, or measuredExhaustion: true for an observed exhaustion or occupied admission.",
      stale:
        "typed-resource-refusal-baseline.json allows {{allowed}} untyped resource constraints in this file but {{actual}} remain; lower the entry to {{actual}}.",
    },
  },
  create(context) {
    const findings = countedFindings(context, baseline, "untyped");
    return {
      NewExpression(node) {
        if (
          node.callee.type !== "Identifier" ||
          node.callee.name !== "AnalysisResourceConstraintError"
        )
          return;
        if (!isTyped(node.arguments[4])) findings.add(node);
      },
      "Program:exit": findings.report,
    };
  },
};
