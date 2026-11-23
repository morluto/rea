import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
/**
 * Files that predate the rule, with their count of untyped constructions. A
 * count may only shrink: the rule reports a file above or below its entry.
 */
const baseline = JSON.parse(
  readFileSync(
    new URL("./typed-resource-refusal-baseline.json", import.meta.url),
    "utf8",
  ),
);

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
    const filename = relative(
      root,
      context.physicalFilename ?? context.filename,
    ).replaceAll("\\", "/");
    const untyped = [];
    return {
      NewExpression(node) {
        if (
          node.callee.type !== "Identifier" ||
          node.callee.name !== "AnalysisResourceConstraintError"
        )
          return;
        if (!isTyped(node.arguments[4])) untyped.push(node);
      },
      "Program:exit"(program) {
        const allowed = baseline[filename] ?? 0;
        if (untyped.length > allowed)
          for (const node of untyped)
            context.report({ node, messageId: "untyped" });
        else if (untyped.length < allowed)
          context.report({
            node: program,
            messageId: "stale",
            data: {
              allowed: String(allowed),
              actual: String(untyped.length),
            },
          });
      },
    };
  },
};
