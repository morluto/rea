// Counts optional parsed facts defaulted to an observed value in comparison,
// coverage and count code: a property read (`report.count`,
// `side?.omitted`) followed by `?? 0`, `?? []` or `?? false`, including the
// last link of a chain (`left.count ?? right.count ?? 0`). Map accumulators
// (`map.get(k) ?? []`) and indexed reads (`bytes[i] ?? 0`) end in a call or
// element read, not a property read, so they are not counted.
//
// A default that is legitimate (a request default such as a pagination
// offset, a library field that is optional by contract, or absence that is
// modelled elsewhere) carries a comment on the line before its expression,
// on that expression's first line, or on the default's line:
// `// optional-fact-default: <why the default is not an observation>`.
//
// The source is tokenized by source-tokens.mjs, so only executable
// expressions are counted and exemption markers are read only from comments.

import { isReasonMarker } from "./reason-marker.mjs";
import { tokenize } from "./source-tokens.mjs";

const comparisonOrCountFile =
  /\/[^/]*(?:compar|diff|delta|reconcil|coverage|summar|count|match)[^/]*\.ts$/iu;

/** @param {string} path */
export const isComparisonOrCountFile = (path) =>
  comparisonOrCountFile.test(path);

const kind = (token) => (token?.kind === "punct" ? token.text : undefined);

const isPropertyRead = (tokens, end) =>
  tokens[end]?.kind === "id" &&
  (kind(tokens[end - 1]) === "." || kind(tokens[end - 1]) === "?.");

const closers = { ")": "(", "]": "[", "}": "{" };

/** Index of the bracket that opens the group closed at `close`. */
const matchingOpen = (tokens, close) => {
  let depth = 0;
  for (let at = close; at >= 0; at -= 1) {
    const text = kind(tokens[at]);
    if (text !== undefined && text in closers) depth += 1;
    else if (text === "(" || text === "[" || text === "{") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return undefined;
};

/** Ends a callee or object, so a following `(` or `[` is a call or element read. */
const endsOperand = (token) =>
  (token?.kind === "id" && token.keyword !== true) ||
  kind(token) === ")" ||
  kind(token) === "]";

/** First token of the member, call and element chain ending at `end`. */
const operandStart = (tokens, end) => {
  let at = end;
  for (;;) {
    const text = kind(tokens[at]);
    if (text === ")" || text === "]") {
      const open = matchingOpen(tokens, at);
      if (open === undefined) return at;
      at = open;
    }
    const previous = tokens[at - 1];
    if ((kind(previous) === "." || kind(previous) === "?.") && at >= 2) at -= 2;
    else if (
      (kind(tokens[at]) === "(" || kind(tokens[at]) === "[") &&
      endsOperand(previous)
    )
      at -= 1;
    else return at;
  }
};

/** First token of the `??` chain whose last operand ends at `end`. */
const chainStart = (tokens, end) => {
  let at = operandStart(tokens, end);
  while (kind(tokens[at - 1]) === "??" && at >= 2)
    at = operandStart(tokens, at - 2);
  return at;
};

const isObservedDefault = (tokens, at) => {
  const token = tokens[at];
  if (token?.kind === "number" && token.text === "0") return at;
  if (token?.kind === "id" && token.text === "false") return at;
  if (kind(token) === "[" && kind(tokens[at + 1]) === "]") return at + 1;
  return undefined;
};

// Tokens that end the `??` expression, so the literal is the whole right
// operand. Any other operator binds tighter (`?? 0 | mask`, `?? 0 + 1`) and
// makes the default a computed value.
const endsDefault = new Set([")", "]", "}", ",", ";", ":", "?", "??"]);

const isWholeDefault = (tokens, last, lineOf) => {
  const next = tokens[last + 1];
  if (
    next === undefined ||
    next.kind === "substitution-end" ||
    endsDefault.has(kind(next))
  )
    return true;
  // A statement that ends without a semicolon continues on a later line.
  return (
    next.kind !== "punct" &&
    !["as", "satisfies", "in", "instanceof"].includes(next.text) &&
    lineOf(next.start) > lineOf(tokens[last].start)
  );
};

/** @param {string} source unstripped source, comments included */
export const optionalFactDefaultCount = (source) => {
  const { tokens, comments } = tokenize(source);
  const lineStarts = [0];
  for (
    let at = source.indexOf("\n");
    at !== -1;
    at = source.indexOf("\n", at + 1)
  )
    lineStarts.push(at + 1);
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const exempt = new Set(
    comments
      // A marker without a reason does not exempt a default.
      .filter(({ text }) => isReasonMarker(text, "optional-fact-default"))
      .map(({ end }) => lineOf(end - 1)),
  );
  let count = 0;
  tokens.forEach((token, at) => {
    if (kind(token) !== "??" || !isPropertyRead(tokens, at - 1)) return;
    const last = isObservedDefault(tokens, at + 1);
    if (last === undefined) return;
    if (!isWholeDefault(tokens, last, lineOf)) return;
    // A marker belongs to the expression it opens or ends: the line before
    // the chain, its first line, or the default's line. A marker on a line in
    // between explains a nested expression, not this default.
    const start = lineOf(tokens[chainStart(tokens, at - 1)].start);
    const end = lineOf(tokens[last].start);
    if ([start - 1, start, end].some((line) => exempt.has(line))) return;
    count += 1;
  });
  return count;
};
