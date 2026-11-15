// Counts optional parsed facts defaulted to an observed value in comparison,
// coverage and count code: a property read (`report.count`,
// `side?.omitted`) followed by `?? 0`, `?? []` or `?? false`, including the
// last link of a chain (`left.count ?? right.count ?? 0`). Map accumulators
// (`map.get(k) ?? []`) and indexed reads (`bytes[i] ?? 0`) end in a call or
// element read, not a property read, so they are not counted.
//
// A default that is legitimate (a request default such as a pagination
// offset, a library field that is optional by contract, or absence that is
// modelled elsewhere) carries a comment on its line or the line before:
// `// optional-fact-default: <why the default is not an observation>`.
//
// CI runs the architecture guards before installing dependencies, so this
// guard tokenizes the source itself instead of loading a compiler. Strings,
// template text, regular expressions and comments are separate tokens, so
// only executable expressions are counted and exemption markers are read only
// from comments.

// The reason must say something; a bare marker does not exempt a default.
const exemptionMarker = /optional-fact-default:\s*\S+(?:\s+\S+){2,}/u;

const comparisonOrCountFile =
  /\/[^/]*(?:compar|diff|delta|reconcil|coverage|summar|count|match)[^/]*\.ts$/iu;

/** @param {string} path */
export const isComparisonOrCountFile = (path) =>
  comparisonOrCountFile.test(path);

const identifier = /[\p{ID_Start}$_#][\p{ID_Continue}$‌‍]*/uy;
const number =
  /(?:0[xXbBoO][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/uy;
const punctuator =
  /\?\?=|\?\?|\?\.(?!\d)|\.\.\.|=>|[!=]==?|[<>]=?|&&=?|\|\|=?|\*\*=?|[-+*%&|^/]=|\+\+|--|[{}()[\];,.<>+\-*/%&|^!~?:=@]/uy;

// After these keywords an expression starts, so `/` opens a regular expression.
const expressionKeywords = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const regexAllowedAfter = (token) =>
  token === undefined ||
  (token.kind === "punct" && !/^[)\]}]$/u.test(token.text)) ||
  (token.kind === "id" && expressionKeywords.has(token.text));

/** End of a template's text from `at` (after a backtick or a substitution's `}`). */
const templateEnd = (source, at, braces) => {
  while (at < source.length) {
    if (source[at] === "\\") at += 2;
    else if (source[at] === "`") return at + 1;
    else if (source[at] === "$" && source[at + 1] === "{") {
      braces.push("template");
      return at + 2;
    } else at += 1;
  }
  return at;
};

/** End of a quoted string opened at `at`. */
const quotedEnd = (source, at) => {
  const quote = source[at];
  at += 1;
  while (at < source.length && source[at] !== quote && source[at] !== "\n")
    at += source[at] === "\\" ? 2 : 1;
  return at + 1;
};

/** End of a regular expression literal (with flags) opened at `at`. */
const regexEnd = (source, at) => {
  at += 1;
  let inClass = false;
  while (at < source.length && source[at] !== "\n") {
    const char = source[at];
    if (char === "\\") at += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) break;
    at += 1;
  }
  identifier.lastIndex = at + 1;
  return identifier.test(source) ? identifier.lastIndex : at + 1;
};

/** End of a comment opened at `at`, or undefined when none starts there. */
const commentEnd = (source, at) => {
  if (source[at] !== "/") return undefined;
  if (source[at + 1] === "/") {
    const end = source.indexOf("\n", at);
    return end === -1 ? source.length : end;
  }
  if (source[at + 1] !== "*") return undefined;
  const end = source.indexOf("*/", at + 2);
  return end === -1 ? source.length : end + 2;
};

const wordPatterns = [
  ["id", identifier],
  ["number", number],
  ["punct", punctuator],
];

/** An identifier, number or punctuator token at `at`. */
const wordToken = (source, at) => {
  for (const [tokenKind, pattern] of wordPatterns) {
    pattern.lastIndex = at;
    if (pattern.test(source))
      return {
        kind: tokenKind,
        text: source.slice(at, pattern.lastIndex),
        start: at,
      };
  }
  return undefined;
};

/**
 * Splits TypeScript source into code tokens and comments. Template literals
 * are tracked through nested `${…}` substitutions with a brace stack.
 */
const tokenize = (source) => {
  /** @type {{ kind: string, text: string, start: number }[]} */
  const tokens = [];
  /** @type {{ text: string, end: number }[]} */
  const comments = [];
  const braces = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    const start = at;
    const comment = commentEnd(source, at);
    if (/\s/u.test(char)) at += 1;
    else if (comment !== undefined) {
      at = comment;
      comments.push({ text: source.slice(start, at), end: at });
    } else if (char === "'" || char === '"') {
      at = quotedEnd(source, at);
      tokens.push({ kind: "string", text: "", start });
    } else if (char === "`" || (char === "}" && braces.at(-1) === "template")) {
      if (char === "}") braces.pop();
      at = templateEnd(source, at + 1, braces);
      tokens.push({ kind: "string", text: "", start });
    } else if (char === "/" && regexAllowedAfter(tokens.at(-1))) {
      at = regexEnd(source, at);
      tokens.push({ kind: "regex", text: "", start });
    } else {
      const token = wordToken(source, at);
      if (token === undefined) {
        at += 1;
        continue;
      }
      at = start + token.text.length;
      tokens.push(token);
      if (token.text === "{") braces.push("block");
      else if (token.text === "}") braces.pop();
    }
  }
  return { tokens, comments };
};

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
  (token?.kind === "id" && !expressionKeywords.has(token.text)) ||
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
  if (next === undefined || endsDefault.has(kind(next))) return true;
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
      .filter(({ text }) => exemptionMarker.test(text))
      .map(({ end }) => lineOf(end - 1)),
  );
  let count = 0;
  tokens.forEach((token, at) => {
    if (kind(token) !== "??" || !isPropertyRead(tokens, at - 1)) return;
    const last = isObservedDefault(tokens, at + 1);
    if (last === undefined) return;
    if (!isWholeDefault(tokens, last, lineOf)) return;
    const start = lineOf(tokens[chainStart(tokens, at - 1)].start);
    const end = lineOf(tokens[last].start);
    for (let line = start - 1; line <= end; line += 1)
      if (exempt.has(line)) return;
    count += 1;
  });
  return count;
};
