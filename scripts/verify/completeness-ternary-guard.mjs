import { tokenize } from "./source-tokens.mjs";

// CI runs architecture-guards.mjs before `npm ci`, so this guard must use the
// zero-dependency scripts/verify/source-tokens.mjs scanner rather than a
// package parser such as `typescript6` or `@babel/parser`.

const MENTIONS_COMPLETE = /["'`]complete["'`]/u;
const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
// `,` is intentionally excluded because generic type arguments (`Record<A, B>`)
// after `extends` contain commas at the same bracket depth.
const EXTENDS_BOUNDARIES = new Set([";", "=", "?"]);
const EXPRESSION_CONTINUATIONS = new Set([
  ".",
  "?.",
  "[",
  "(",
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "===",
  "!==",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "instanceof",
]);

/**
 * @param {import("./source-tokens.d.mts").SourceToken | undefined} token
 * @param {string} text
 * @returns {boolean}
 */
const isPunct = (token, text) => token?.kind === "punct" && token.text === text;

/**
 * @param {import("./source-tokens.d.mts").SourceToken | undefined} token
 * @param {string} text
 * @returns {boolean}
 */
const isId = (token, text) => token?.kind === "id" && token.text === text;

/**
 * Whether `token` is a plain string or no-substitution template literal whose
 * exact value is `"complete"`.
 *
 * @param {string} source
 * @param {import("./source-tokens.d.mts").SourceToken | undefined} token
 * @returns {boolean}
 */
const isCompleteLiteral = (source, token) => {
  if (token?.kind !== "string" || token.opensSubstitution === true)
    return false;
  const quote = source[token.start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return false;
  return (
    source.slice(token.start + 1, token.start + 9) === "complete" &&
    source[token.start + 9] === quote
  );
};

/**
 * Checks whether the token slice `[start, end)` represents a standalone
 * `"complete"` literal (allowing wrapping parentheses and trailing `as ...` /
 * `satisfies ...` assertions).
 *
 * @param {string} source
 * @param {readonly import("./source-tokens.d.mts").SourceToken[]} tokens
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
const isCompleteWhenTrueBranch = (source, tokens, start, end) => {
  let left = start;
  let right = end;
  while (
    left + 1 < right &&
    isPunct(tokens[left], "(") &&
    isPunct(tokens[right - 1], ")")
  ) {
    left += 1;
    right -= 1;
  }
  if (!isCompleteLiteral(source, tokens[left])) return false;
  if (left + 1 === right) return true;
  const next = tokens[left + 1];
  return isId(next, "as") || isId(next, "satisfies");
};

/**
 * Checks whether the expression starting at `start` (the token immediately
 * after `:`) is a standalone `"complete"` literal (allowing wrapping
 * parentheses and trailing `as ...` / `satisfies ...` assertions).
 *
 * @param {string} source
 * @param {readonly import("./source-tokens.d.mts").SourceToken[]} tokens
 * @param {number} start
 * @returns {boolean}
 */
const isCompleteWhenFalseBranch = (source, tokens, start) => {
  let index = start;
  let openParens = 0;
  while (isPunct(tokens[index], "(")) {
    openParens += 1;
    index += 1;
  }
  if (!isCompleteLiteral(source, tokens[index])) return false;
  let after = index + 1;
  if (isId(tokens[after], "as") || isId(tokens[after], "satisfies")) {
    return true;
  }
  while (openParens > 0 && isPunct(tokens[after], ")")) {
    openParens -= 1;
    after += 1;
  }
  if (openParens > 0) return false;
  const next = tokens[after];
  if (next === undefined) return true;
  if (isId(next, "as") || isId(next, "satisfies")) return true;
  return !EXPRESSION_CONTINUATIONS.has(next.text);
};

/**
 * Distinguishes an arrow-function return-type colon (`(): string => body : alt`)
 * from a ternary `:` (`(expr) : alt` or `(expr) : () => body`).
 *
 * A `:` immediately after `)` is an arrow return-type annotation when:
 * 1. A `=>` follows at depth 0 (skipping balanced `()`, `[]`, `{}`, `<>`), and
 * 2. After that `=>`, an unmatched ternary `:` follows at depth 0 before any
 *    statement/argument boundary.
 *
 * @param {readonly import("./source-tokens.d.mts").SourceToken[]} tokens
 * @param {number} colonIndex
 * @returns {boolean}
 */
const isArrowReturnTypeColon = (tokens, colonIndex) => {
  if (!isPunct(tokens[colonIndex - 1], ")")) return false;
  let bracketDepth = 0;
  let angleDepth = 0;
  let arrowIndex = -1;

  for (let index = colonIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.opensSubstitution === true) {
      bracketDepth += 1;
      continue;
    }
    if (token.kind === "substitution-end") {
      if (bracketDepth === 0) return false;
      bracketDepth -= 1;
      continue;
    }
    if (token.kind === "punct" && OPENERS.has(token.text)) {
      bracketDepth += 1;
      continue;
    }
    if (token.kind === "punct" && CLOSERS.has(token.text)) {
      if (bracketDepth === 0) return false;
      bracketDepth -= 1;
      continue;
    }
    if (bracketDepth === 0) {
      if (isPunct(token, "<")) {
        angleDepth += 1;
        continue;
      }
      if (isPunct(token, ">") && angleDepth > 0) {
        angleDepth -= 1;
        continue;
      }
      if (angleDepth === 0) {
        if (isPunct(token, "=>")) {
          arrowIndex = index;
          break;
        }
        if (
          isPunct(token, ";") ||
          isPunct(token, ",") ||
          isPunct(token, "?") ||
          isPunct(token, ":")
        ) {
          return false;
        }
      }
    }
  }

  if (arrowIndex === -1) return false;

  let exprDepth = 0;
  let nestedTernaries = 0;
  for (let index = arrowIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.opensSubstitution === true) {
      exprDepth += 1;
      continue;
    }
    if (token.kind === "substitution-end") {
      if (exprDepth === 0) return false;
      exprDepth -= 1;
      continue;
    }
    if (token.kind === "punct" && OPENERS.has(token.text)) {
      exprDepth += 1;
      continue;
    }
    if (token.kind === "punct" && CLOSERS.has(token.text)) {
      if (exprDepth === 0) return false;
      exprDepth -= 1;
      continue;
    }
    if (exprDepth > 0) continue;
    if (isPunct(token, "?")) {
      const next = tokens[index + 1];
      if (
        !isPunct(next, ":") &&
        !isPunct(next, ",") &&
        !isPunct(next, ")") &&
        !isPunct(next, "=")
      ) {
        nestedTernaries += 1;
      }
      continue;
    }
    if (isPunct(token, ":")) {
      if (nestedTernaries === 0) return true;
      nestedTernaries -= 1;
      continue;
    }
    if (isPunct(token, ";") || isPunct(token, ",")) return false;
  }
  return false;
};

/**
 * Counts ternary (`? ... : ...`) expressions whose true or false branch
 * evaluates to the string literal `"complete"`.
 *
 * Uses `scripts/verify/source-tokens.mjs` so single-line, multiline, nested,
 * parenthesized, and `as const` / `satisfies` ternaries are counted
 * identically without any third-party dependency, while ignoring TypeScript
 * conditional types (`T extends U ? ... : ...`), optional properties/parameters
 * (`x?: "complete"`), object properties (`status: "complete"`), comparisons,
 * and comments.
 *
 * @param {string} content
 * @returns {number}
 */
export const adhocCompletenessTernaryCount = (content) => {
  if (!MENTIONS_COMPLETE.test(content)) return 0;
  const { tokens } = tokenize(content);
  /** @type {{ qIndex: number, depth: number }[]} */
  const ternaryStack = [];
  /** @type {boolean[]} */
  const sawExtendsAtDepth = [false];
  /** @type {number[]} */
  const extendsAngleDepth = [0];
  let depth = 0;
  let count = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.opensSubstitution === true) {
      depth += 1;
      sawExtendsAtDepth[depth] = false;
      extendsAngleDepth[depth] = 0;
      continue;
    }
    if (token.kind === "substitution-end") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (token.kind === "punct" && OPENERS.has(token.text)) {
      depth += 1;
      sawExtendsAtDepth[depth] = false;
      extendsAngleDepth[depth] = 0;
      continue;
    }
    if (token.kind === "punct" && CLOSERS.has(token.text)) {
      while (
        ternaryStack.length > 0 &&
        /** @type {{ depth: number }} */ (ternaryStack.at(-1)).depth >= depth
      ) {
        ternaryStack.pop();
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (isId(token, "extends")) {
      const previous = tokens[index - 1];
      if (
        !isPunct(previous, ".") &&
        !isPunct(previous, "?.") &&
        sawExtendsAtDepth[depth] !== true
      ) {
        sawExtendsAtDepth[depth] = true;
        extendsAngleDepth[depth] = 0;
      }
      continue;
    }
    if (sawExtendsAtDepth[depth] === true) {
      if (isPunct(token, "<")) {
        extendsAngleDepth[depth] = (extendsAngleDepth[depth] ?? 0) + 1;
        continue;
      }
      if (isPunct(token, ">") && (extendsAngleDepth[depth] ?? 0) > 0) {
        extendsAngleDepth[depth] = (extendsAngleDepth[depth] ?? 0) - 1;
        continue;
      }
      if (isPunct(token, ",") && (extendsAngleDepth[depth] ?? 0) === 0) {
        sawExtendsAtDepth[depth] = false;
        continue;
      }
    }
    if (isPunct(token, "?")) {
      const next = tokens[index + 1];
      const isOptionalMarker =
        isPunct(next, ":") ||
        isPunct(next, ",") ||
        isPunct(next, ")") ||
        isPunct(next, "=");
      const isConditionalType = sawExtendsAtDepth[depth] === true;
      sawExtendsAtDepth[depth] = false;
      extendsAngleDepth[depth] = 0;
      if (!isOptionalMarker && !isConditionalType) {
        ternaryStack.push({ qIndex: index, depth });
      }
      continue;
    }
    if (isPunct(token, ":")) {
      sawExtendsAtDepth[depth] = false;
      extendsAngleDepth[depth] = 0;
      const open = ternaryStack.at(-1);
      if (
        open !== undefined &&
        open.depth === depth &&
        !isArrowReturnTypeColon(tokens, index)
      ) {
        ternaryStack.pop();
        if (
          isCompleteWhenTrueBranch(content, tokens, open.qIndex + 1, index) ||
          isCompleteWhenFalseBranch(content, tokens, index + 1)
        ) {
          count += 1;
        }
      }
      continue;
    }
    if (token.kind === "punct" && EXTENDS_BOUNDARIES.has(token.text)) {
      sawExtendsAtDepth[depth] = false;
      extendsAngleDepth[depth] = 0;
    }
  }
  return count;
};
