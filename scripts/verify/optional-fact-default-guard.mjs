import ts from "typescript6";

// Counts optional parsed facts defaulted to an observed value in comparison,
// coverage and count code: a property read (`report.count`,
// `side?.omitted`) followed by `?? 0`, `?? []` or `?? false`. Map
// accumulators (`map.get(k) ?? []`) and indexed reads (`bytes[i] ?? 0`) are
// calls and element reads, not property reads, so they are not counted.
//
// A default that is legitimate (a request default such as a pagination
// offset, a library field that is optional by contract, or absence that is
// modelled elsewhere) carries a comment on its line or the line before:
// `// optional-fact-default: <why the default is not an observation>`.
// The counter parses the source, so only executable expressions are counted
// (not text in strings, regular expressions or comments), and exemption
// markers are read only from comments.

// The reason must say something; a bare marker does not exempt a default.
const exemptionMarker = /optional-fact-default:\s*\S+(?:\s+\S+){2,}/u;

const comparisonOrCountFile =
  /\/[^/]*(?:compar|diff|delta|reconcil|coverage|summar|count|match)[^/]*\.ts$/iu;

/** @param {string} path */
export const isComparisonOrCountFile = (path) =>
  comparisonOrCountFile.test(path);

/** @param {ts.Expression} node */
const isObservedDefault = (node) =>
  (ts.isNumericLiteral(node) && node.text === "0") ||
  (ts.isArrayLiteralExpression(node) && node.elements.length === 0) ||
  node.kind === ts.SyntaxKind.FalseKeyword;

/**
 * Lines on which a comment holding an exemption marker ends. Comments are
 * read from the trivia around each parsed token, so text inside a string or
 * regular expression is never taken for one.
 */
const exemptLines = (file) => {
  const source = file.text;
  const lines = new Set();
  const seen = new Set();
  const read = (ranges) => {
    for (const range of ranges ?? []) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      if (exemptionMarker.test(source.slice(range.pos, range.end)))
        lines.add(file.getLineAndCharacterOfPosition(range.end).line);
    }
  };
  const visit = (node) => {
    read(ts.getLeadingCommentRanges(source, node.getFullStart()));
    read(ts.getTrailingCommentRanges(source, node.getEnd()));
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  return lines;
};

/** @param {string} source unstripped source, comments included */
export const optionalFactDefaultCount = (source) => {
  const file = ts.createSourceFile(
    "guard.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let exempt;
  let count = 0;
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      ts.isPropertyAccessExpression(node.left) &&
      isObservedDefault(node.right)
    ) {
      exempt ??= exemptLines(file);
      const start = file.getLineAndCharacterOfPosition(node.getStart()).line;
      const end = file.getLineAndCharacterOfPosition(node.getEnd()).line;
      let marked = false;
      for (let line = start - 1; line <= end && !marked; line += 1)
        marked = exempt.has(line);
      if (!marked) count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
};
