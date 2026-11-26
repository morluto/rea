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
  "&&",
  "||",
  "??",
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

/** @param {import("./source-tokens.d.mts").SourceToken} token */
const opensGroup = (token) =>
  token.opensSubstitution === true ||
  (token.kind === "punct" && OPENERS.has(token.text));

/** @param {import("./source-tokens.d.mts").SourceToken} token */
const closesGroup = (token) =>
  token.kind === "substitution-end" ||
  (token.kind === "punct" && CLOSERS.has(token.text));

/**
 * A close at depth zero returns -1. Non-grouping tokens return undefined.
 * A template substitution can close one group and open the next on the same token.
 * @param {import("./source-tokens.d.mts").SourceToken} token
 * @param {number} depth
 */
const groupDepthAfter = (token, depth) => {
  if (closesGroup(token)) {
    if (depth === 0) return -1;
    return opensGroup(token) ? depth : depth - 1;
  }
  return opensGroup(token) ? depth + 1 : undefined;
};

const TYPE_CONTINUATIONS = new Set(["|", "&", ".", "[", "<", "=>"]);
const TYPE_PREFIX_OPERATORS = new Set([
  "keyof",
  "typeof",
  "readonly",
  "unique",
  "infer",
  "extends",
  "is",
]);

/**
 * Advances past the type expression immediately following `as` or `satisfies`,
 * stopping at the first token at depth 0 that terminates the type (an unmatched
 * closer, a delimiter `;` / `,` / `?` / `:`, a chained `as` / `satisfies`, an
 * ASI newline when `allowAsi` is true and the type is complete, or a binary
 * expression continuation).
 *
 * @param {string} source
 * @param {readonly import("./source-tokens.d.mts").SourceToken[]} tokens
 * @param {number} start
 * @param {number} end
 * @param {boolean} allowAsi
 * @returns {number}
 */
const skipTypeAnnotation = (source, tokens, start, end, allowAsi) => {
  let index = start;
  let bracketDepth = 0;
  let angleDepth = 0;
  while (index < end) {
    const token = tokens[index];
    if (token === undefined) break;
    if (allowAsi && bracketDepth === 0 && angleDepth === 0 && index > start) {
      const previous = tokens[index - 1];
      if (
        previous !== undefined &&
        source.slice(previous.start, token.start).includes("\n") &&
        !TYPE_CONTINUATIONS.has(previous.text) &&
        !TYPE_PREFIX_OPERATORS.has(previous.text) &&
        !TYPE_CONTINUATIONS.has(token.text)
      ) {
        break;
      }
    }
    const nextDepth = groupDepthAfter(token, bracketDepth);
    if (nextDepth !== undefined) {
      if (nextDepth < 0) break;
      bracketDepth = nextDepth;
      index += 1;
      continue;
    }
    if (bracketDepth === 0) {
      if (isPunct(token, "<")) {
        angleDepth += 1;
        index += 1;
        continue;
      }
      if (isPunct(token, ">") && angleDepth > 0) {
        angleDepth -= 1;
        index += 1;
        continue;
      }
      if (
        angleDepth === 0 &&
        (isPunct(token, ";") ||
          isPunct(token, ",") ||
          isPunct(token, "?") ||
          isPunct(token, ":") ||
          isId(token, "as") ||
          isId(token, "satisfies") ||
          (token.kind === "punct" &&
            token.text !== "." &&
            EXPRESSION_CONTINUATIONS.has(token.text)))
      ) {
        break;
      }
    }
    index += 1;
  }
  return index;
};

/**
 * Checks whether the expression starting at `start` (bounded by `end`) is a
 * standalone `"complete"` literal, unwrapping arbitrary combinations of
 * parentheses and trailing `as ...` / `satisfies ...` assertions.
 *
 * When `bounded` is `true` (a ternary true branch `[qIndex + 1, colonIndex)`),
 * the entire slice up to `end` must be consumed. When `bounded` is `false` (a
 * ternary false branch starting at `colonIndex + 1`), the expression ends at
 * the first non-continuation token once all opened parentheses are balanced.
 *
 * @param {string} source
 * @param {readonly import("./source-tokens.d.mts").SourceToken[]} tokens
 * @param {number} start
 * @param {number} end
 * @param {boolean} bounded
 * @returns {boolean}
 */
const isWrappedCompleteLiteral = (source, tokens, start, end, bounded) => {
  let index = start;
  let openParens = 0;
  while (index < end && isPunct(tokens[index], "(")) {
    openParens += 1;
    index += 1;
  }
  if (index >= end || !isCompleteLiteral(source, tokens[index])) return false;
  index += 1;
  while (index < end) {
    if (openParens > 0 && isPunct(tokens[index], ")")) {
      openParens -= 1;
      index += 1;
      continue;
    }
    if (isId(tokens[index], "as") || isId(tokens[index], "satisfies")) {
      index = skipTypeAnnotation(
        source,
        tokens,
        index + 1,
        end,
        !bounded && openParens === 0,
      );
      continue;
    }
    break;
  }
  if (openParens !== 0) return false;
  if (bounded) return index === end;
  const next = tokens[index];
  return next === undefined || !EXPRESSION_CONTINUATIONS.has(next.text);
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
    const nextDepth = groupDepthAfter(token, bracketDepth);
    if (nextDepth !== undefined) {
      if (nextDepth < 0) return false;
      bracketDepth = nextDepth;
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
    const nextDepth = groupDepthAfter(token, exprDepth);
    if (nextDepth !== undefined) {
      if (nextDepth < 0) return false;
      exprDepth = nextDepth;
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
    const closing = closesGroup(token);
    const opening = opensGroup(token);
    if (closing) {
      while (
        ternaryStack.length > 0 &&
        /** @type {{ depth: number }} */ (ternaryStack.at(-1)).depth >= depth
      ) {
        ternaryStack.pop();
      }
      depth = Math.max(0, depth - 1);
    }
    if (opening) {
      depth += 1;
      sawExtendsAtDepth[depth] = false;
      extendsAngleDepth[depth] = 0;
    }
    if (closing || opening) continue;
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
          isWrappedCompleteLiteral(
            content,
            tokens,
            open.qIndex + 1,
            index,
            true,
          ) ||
          isWrappedCompleteLiteral(
            content,
            tokens,
            index + 1,
            tokens.length,
            false,
          )
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
