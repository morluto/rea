import { countedFindings, readBaseline } from "./counted-findings.mjs";

/**
 * `owners` hold the one shared raw-failure classifier. `counts` lists files
 * that predate the rule with their count of per-site classifier functions; a
 * count may only shrink: the rule reports a file above or below its entry.
 */
const { owners, counts: baseline } = readBaseline(
  "./provider-failure-classifier-baseline.json",
);
const ownerFiles = new Set(owners);

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
        "Do not add a per-site `(cause: unknown) => AnalysisError` classifier. Classify the raw failure with classifyProviderFailure(cause, dialect), putting provider-specific refusals, command settings and file naming in that dialect.",
      stale:
        "provider-failure-classifier-baseline.json allows {{allowed}} per-site classifiers in this file but {{actual}} remain; lower the entry to {{actual}}.",
    },
  },
  create(context) {
    const findings = countedFindings(context, baseline, "classifier");
    if (ownerFiles.has(findings.filename)) return {};
    const visit = (node) => {
      if (isClassifier(node)) findings.add(node);
    };
    return {
      ArrowFunctionExpression: visit,
      FunctionDeclaration: visit,
      FunctionExpression: visit,
      "Program:exit": findings.report,
    };
  },
};
