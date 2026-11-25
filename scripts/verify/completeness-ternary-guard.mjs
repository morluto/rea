import ts from "typescript6";

/**
 * Unwraps transparent TypeScript wrappers around a literal expression so
 * parenthesized or asserted branches (`("complete" as const)`) are still
 * recognized as a `"complete"` literal.
 *
 * @param {ts.Expression} expression
 * @returns {boolean}
 */
const isCompleteStringLiteral = (expression) => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return (
    (ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)) &&
    current.text === "complete"
  );
};

/**
 * Counts `ConditionalExpression` AST nodes whose `whenTrue` or `whenFalse`
 * branch evaluates to the string literal `"complete"`.
 *
 * Parsing with the TypeScript AST catches single-line and multiline ternary
 * layouts identically while ignoring type-level conditional types, object
 * properties (`status: "complete"`), comparisons, and comments.
 *
 * @param {string} content
 * @param {{ readonly path?: string } | undefined} [file]
 * @returns {number}
 */
export const adhocCompletenessTernaryCount = (content, file) => {
  const source = ts.createSourceFile(
    file?.path ?? "source.ts",
    content,
    ts.ScriptTarget.Latest,
    false,
  );
  let count = 0;
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      ts.isConditionalExpression(node) &&
      (isCompleteStringLiteral(node.whenTrue) ||
        isCompleteStringLiteral(node.whenFalse))
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
};
