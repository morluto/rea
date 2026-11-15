// Splits TypeScript source into code tokens and comments without loading a
// compiler (CI runs the architecture guards before installing dependencies).
// Strings, template text, regular expressions and comments are separate
// tokens, and template substitutions are tracked through nested `${…}` with a
// brace stack, so guards count only executable code and read markers only
// from comments.

const identifier = /[\p{ID_Start}$_#][\p{ID_Continue}$‌‍]*/uy;
const number =
  /(?:0[xXbBoO][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/uy;
const punctuator =
  /\?\?=|\?\?|\?\.(?!\d)|\.\.\.|=>|[!=]==?|[<>]=?|&&=?|\|\|=?|\*\*=?|[-+*%&|^/]=|\+\+|--|[{}()[\];,.<>+\-*/%&|^!~?:=@]/uy;

// After these keywords an expression starts, so `/` opens a regular expression.
export const expressionKeywords = new Set([
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

// After a closing bracket, `++` or `--` an operand has ended, so `/` divides.
const regexAllowedAfter = (token) =>
  token === undefined ||
  (token.kind === "punct" && !/^(?:[)\]}]|\+\+|--)$/u.test(token.text)) ||
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
export const tokenize = (source) => {
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
      // Template text after a substitution's `}` closes that substitution.
      tokens.push({
        kind: char === "}" ? "substitution-end" : "string",
        text: "",
        start,
      });
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
