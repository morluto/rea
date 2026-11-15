import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
/**
 * Files that predate the rule, with their count of per-site classifier
 * functions. A count may only shrink: the rule reports a file above or below
 * its entry.
 */
const baseline = JSON.parse(
  readFileSync(
    new URL("./provider-failure-classifier-baseline.json", import.meta.url),
    "utf8",
  ),
);

const isUnknownParameter = (parameter) => {
  const target =
    parameter.type === "AssignmentPattern"
      ? parameter.left
      : parameter.type === "TSParameterProperty"
        ? parameter.parameter
        : parameter;
  return target?.typeAnnotation?.typeAnnotation?.type === "TSUnknownKeyword";
};

const namesAnalysisError = (type) => {
  if (type === undefined || type === null) return false;
  if (type.type === "TSUnionType") return type.types.some(namesAnalysisError);
  return (
    type.type === "TSTypeReference" &&
    type.typeName.type === "Identifier" &&
    type.typeName.name === "AnalysisError"
  );
};

/**
 * A per-site classifier takes an unexamined `unknown` failure and returns an
 * `AnalysisError`, re-deriving what kind of failure it was.
 */
const isClassifier = (node) =>
  node.params.some(isUnknownParameter) &&
  namesAnalysisError(node.returnType?.typeAnnotation);

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Classify raw provider failures through the shared ProviderOutcome classifier, not a new per-site function.",
    },
    schema: [],
    messages: {
      classifier:
        "Do not add a per-site `(cause: unknown) => AnalysisError` classifier. Read the supervisor's facts with providerOutcomeOf(cause) and classify them with classifyProviderOutcome(...), putting provider-specific refusals in its dialect.",
      stale:
        "provider-failure-classifier-baseline.json allows {{allowed}} per-site classifiers in this file but {{actual}} remain; lower the entry to {{actual}}.",
    },
  },
  create(context) {
    const filename = relative(
      root,
      context.physicalFilename ?? context.filename,
    ).replaceAll("\\", "/");
    const classifiers = [];
    const visit = (node) => {
      if (isClassifier(node)) classifiers.push(node);
    };
    return {
      ArrowFunctionExpression: visit,
      FunctionDeclaration: visit,
      FunctionExpression: visit,
      "Program:exit"(program) {
        const allowed = baseline[filename] ?? 0;
        if (classifiers.length > allowed)
          for (const node of classifiers)
            context.report({ node, messageId: "classifier" });
        else if (classifiers.length < allowed)
          context.report({
            node: program,
            messageId: "stale",
            data: {
              allowed: String(allowed),
              actual: String(classifiers.length),
            },
          });
      },
    };
  },
};
