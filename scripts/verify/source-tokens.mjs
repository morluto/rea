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
// A property name such as `row.return` is not a keyword.
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

// A parenthesised head after these keywords ends where a statement starts.
const controlKeywords = new Set(["if", "while", "for", "with"]);

// After a closing bracket, `++`, `--`, an operand or a complete template an
// expression has ended, so `/` divides. An expression starts after any other
// punctuator, an expression keyword, the `)` that closes a control head such
// as `if (…)`, and template text that opens a `${` substitution.
const regexAllowedAfter = (token) =>
  token === undefined ||
  token.opensSubstitution === true ||
  token.keyword === true ||
  token.closesBlock === true ||
  (token.kind === "punct" && token.controlHead === true) ||
  (token.kind === "punct" && !/^(?:[)\]}]|\+\+|--)$/u.test(token.text));

// A `{` opens a statement block at the start of a statement, after the `)`
// of a control or function head, an arrow, another brace or `;`, a block
// keyword, or a declaration name or return type (`class A {`,
// `function f(): T {`). Anywhere else it opens an object literal or type,
// whose `}` ends an operand, so a `/` after it divides.
const opensBlock = (previous) =>
  previous === undefined ||
  (previous.kind === "punct" && /^(?:[);{}]|=>)$/u.test(previous.text)) ||
  (previous.kind === "id" &&
    (previous.keyword !== true ||
      previous.text === "do" ||
      previous.text === "else"));

/**
 * End of a template's text from `at` (after a backtick or a substitution's
 * `}`), and whether that text opens a `${` substitution.
 */
const templateEnd = (source, at, braces) => {
  while (at < source.length) {
    if (source[at] === "\\") at += 2;
    else if (source[at] === "`") return { end: at + 1, opens: false };
    else if (source[at] === "$" && source[at + 1] === "{") {
      braces.push("template");
      return { end: at + 2, opens: true };
    } else at += 1;
  }
  return { end: at, opens: false };
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

/** Whether a name after this token is a property name, not a keyword. */
const isMemberAccess = (token) =>
  token?.kind === "punct" && (token.text === "." || token.text === "?.");

const whitespace = /\s+/uy;
const isWhitespace = (char) =>
  char === " " || char === "\n" || char === "\t" || /\s/u.test(char);

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
 * Scans source into code tokens and comments. The scanner reads only the last
 * two tokens, so a caller that needs only comments keeps no more than those.
 */
const scan = (source, keepTokens) => {
  /** @type {import("./source-tokens.d.mts").SourceToken[]} */
  const tokens = [];
  // One entry per open `(`: whether it opens a control head.
  const parens = [];
  /** @type {{ text: string, end: number }[]} */
  const comments = [];
  const braces = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    const start = at;
    const comment = commentEnd(source, at);
    if (isWhitespace(char)) {
      whitespace.lastIndex = at;
      whitespace.test(source);
      at = whitespace.lastIndex;
    } else if (comment !== undefined) {
      at = comment;
      comments.push({ text: source.slice(start, at), end: at });
    } else if (char === "'" || char === '"') {
      at = quotedEnd(source, at);
      tokens.push({ kind: "string", text: "", start });
    } else if (char === "`" || (char === "}" && braces.at(-1) === "template")) {
      if (char === "}") braces.pop();
      const text = templateEnd(source, at + 1, braces);
      at = text.end;
      // Template text after a substitution's `}` closes that substitution.
      tokens.push({
        kind: char === "}" ? "substitution-end" : "string",
        text: "",
        start,
        ...(text.opens ? { opensSubstitution: true } : {}),
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
      if (token.text === "(") {
        const previous = tokens.at(-1);
        // `x.if(…)` and `x?.for(…)` are member calls, not control heads.
        parens.push(
          previous?.kind === "id" &&
            controlKeywords.has(previous.text) &&
            !isMemberAccess(tokens.at(-2)),
        );
      } else if (token.text === ")" && parens.pop() === true)
        token.controlHead = true;
      else if (
        token.kind === "id" &&
        expressionKeywords.has(token.text) &&
        !isMemberAccess(tokens.at(-1))
      )
        token.keyword = true;
      if (token.text === "{")
        braces.push(opensBlock(tokens.at(-1)) ? "block" : "object");
      // After a statement block a new statement starts.
      else if (token.text === "}" && braces.pop() === "block")
        token.closesBlock = true;
      tokens.push(token);
      if (!keepTokens && tokens.length > 64) tokens.splice(0, 62);
    }
  }
  return { tokens, comments };
};

/**
 * Splits TypeScript source into code tokens and comments. Template literals
 * are tracked through nested `${…}` substitutions with a brace stack.
 */
export const tokenize = (source) => scan(source, true);

/**
 * The source with every comment replaced by spaces, keeping newlines, so
 * offsets and line numbers still match the source. Strings, templates and
 * regular expressions are kept, so `/*` or `//` inside them is not a comment.
 * @param {string} source
 * @param {readonly { text: string, end: number }[]} [comments] the source's
 *   comments, when the caller has already tokenized it
 */
export const blankComments = (
  source,
  comments = scan(source, false).comments,
) => {
  const parts = [];
  let last = 0;
  for (const { text, end } of comments) {
    parts.push(source.slice(last, end - text.length));
    // One space per UTF-16 unit, so offsets after the comment stay the same.
    parts.push(text.replace(/[^\n]+/gu, (run) => " ".repeat(run.length)));
    last = end;
  }
  parts.push(source.slice(last));
  return parts.join("");
};
