import ts from "typescript6";

// A refusal names the owner of the limit that stopped it: a registered
// setting or per-call parameter (`limit`), a fixed ceiling whose format,
// protocol or representation reason is registered (`fixedAllowance`), or an
// observed exhaustion (`measuredExhaustion`). These helpers find the two
// constructions that bypass that ownership: a fixed-ceiling declaration,
// which must be listed with its reason, and a refusal whose only recovery is
// authored prose, which names no control a caller can adjust.

/**
 * Helpers that declare a fixed ceiling, with the index of the argument that
 * names (or is) the allowance. A wrapper that forwards its own parameter is
 * listed here so its callers are checked, not only the wrapper.
 */
const FIXED_CEILING_HELPERS = new Map([
  ["fixedAllowanceOptions", 0],
  ["fixedNativeAllowance", 0],
  ["fixedProducerInputAllowance", 1],
  ["artifactFixedLimitFailure", 0],
]);

/** Option keys that bind a refusal to its owner. */
const OWNER_KEYS = new Set(["limit", "fixedAllowance", "measuredExhaustion"]);

const propertyName = (property) =>
  property.name !== undefined &&
  (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ? property.name.text
    : undefined;

const normalized = (node, source) =>
  node.getText(source).replace(/\s+/gu, " ").trim();

const namedProperty = (literal, name) =>
  literal.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) && propertyName(property) === name,
  );

/** The allowance a declaration names: the helper's first argument or the literal's `name`. */
const allowanceText = (node, source) => {
  if (!ts.isObjectLiteralExpression(node)) return normalized(node, source);
  const name = namedProperty(node, "name");
  return name === undefined
    ? normalized(node, source)
    : normalized(name.initializer, source);
};

const parse = (content, path) =>
  ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);

/**
 * Each fixed-ceiling declaration in one file, keyed by the allowance text it
 * names: a call to one of `FIXED_CEILING_HELPERS`, or an inline `fixedAllowance: { ... }`
 * object. Forwarding an existing allowance (`fixedAllowance: cause.fixedAllowance`)
 * declares nothing and is not listed.
 *
 * @param {string} content
 * @param {string} path
 * @returns {Map<string, number>} allowance text to its declaration line
 */
export const fixedCeilingDeclarations = (content, path) => {
  const source = parse(content, path);
  const found = new Map();
  const record = (allowance, node) => {
    const text = allowanceText(allowance, source);
    if (!found.has(text))
      found.set(
        text,
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      );
  };
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      FIXED_CEILING_HELPERS.has(node.expression.text)
    ) {
      const allowance =
        node.arguments[FIXED_CEILING_HELPERS.get(node.expression.text)];
      if (allowance !== undefined) record(allowance, node);
    }
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node) === "fixedAllowance" &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      record(node.initializer, node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/**
 * How many visible option literals author recovery without naming an owner.
 * A conditional chooses between option objects, so each branch counts.
 */
const authoredOnly = (options) => {
  if (options === undefined) return 0;
  if (ts.isParenthesizedExpression(options))
    return authoredOnly(options.expression);
  if (ts.isConditionalExpression(options))
    return authoredOnly(options.whenTrue) + authoredOnly(options.whenFalse);
  return ts.isObjectLiteralExpression(options) &&
    !options.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) ||
        OWNER_KEYS.has(propertyName(property)),
    ) &&
    options.properties.some(
      (property) => propertyName(property) === "remediationAction",
    )
    ? 1
    : 0;
};

/**
 * Count refusals whose only recovery is an authored `remediationAction`: a
 * `new AnalysisResourceConstraintError(...)` (options are the fifth argument)
 * or `parseLimitConstraint(...)` (options are the fourth). Options built by a
 * helper, a variable or a spread are trusted, as the typed-refusal lint rule
 * trusts them.
 *
 * @param {string} content
 * @param {string} path
 * @returns {number}
 */
export const authoredOnlyRefusalCount = (content, path) => {
  if (
    !content.includes("AnalysisResourceConstraintError") &&
    !content.includes("parseLimitConstraint")
  )
    return 0;
  const source = parse(content, path);
  let count = 0;
  const visit = (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "AnalysisResourceConstraintError"
    )
      count += authoredOnly(node.arguments?.[4]);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "parseLimitConstraint"
    )
      count += authoredOnly(node.arguments[3]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
};
