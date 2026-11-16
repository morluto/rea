// Reads the bindings that import and re-export declarations take from incur:
// named (`import { Cli, type Help } from "incur"`, `export { z } from 'incur'`),
// default, namespace (`import * as Incur from "incur"`), star re-exports
// (`export * from "incur"`), side-effect imports and dynamic `import("incur")`.
// Declarations are read from code tokens, so the same text in a comment,
// string or template is not counted.
import { tokenize } from "./source-tokens.mjs";

const isIncurSpecifier = (source, token) =>
  token?.kind === "string" &&
  (source.startsWith('"incur"', token.start) ||
    source.startsWith("'incur'", token.start));

/**
 * Read `{ a, type b, c as d }` starting at the `{` token.
 * @returns {{ names: string[], end: number } | undefined} imported names and
 *   the index after `}`
 */
const namedBindings = (tokens, open) => {
  const names = [];
  let expectName = true;
  let at = open + 1;
  for (; at < tokens.length && tokens[at].text !== "}"; at += 1) {
    const token = tokens[at];
    if (token.text === ",") expectName = true;
    // In `{ z as zod }` the imported name is z; in `{ type Cli }`, Cli.
    else if (
      expectName &&
      token.kind === "id" &&
      !(token.text === "type" && tokens[at + 1]?.kind === "id")
    ) {
      names.push(token.text);
      expectName = false;
    }
  }
  return at < tokens.length ? { names, end: at + 1 } : undefined;
};

/**
 * The bindings of the declaration whose `import` or `export` keyword is at
 * `index`, or undefined when it does not take anything from incur.
 * @returns {string[] | undefined}
 */
const incurBindings = (source, tokens, index) => {
  let at = index + 1;
  // `import("incur")` and `import "incur"` bind nothing by name.
  if (tokens[index].text === "import" && tokens[at]?.text === "(")
    return isIncurSpecifier(source, tokens[at + 1]) ? ["import()"] : undefined;
  if (tokens[index].text === "import" && tokens[at]?.kind === "string")
    return isIncurSpecifier(source, tokens[at]) ? ["import"] : undefined;
  if (tokens[at]?.kind === "id" && tokens[at].text === "type") at += 1;
  const names = [];
  // A default import may precede a named or namespace clause.
  if (
    tokens[index].text === "import" &&
    tokens[at]?.kind === "id" &&
    tokens[at].text !== "from"
  ) {
    names.push("default");
    at += 1;
    if (tokens[at]?.text !== ",") return finish(source, tokens, at, names);
    at += 1;
  }
  if (tokens[at]?.text === "*") {
    names.push("*");
    at += 1;
    if (tokens[at]?.kind === "id" && tokens[at].text === "as") at += 2;
  } else if (tokens[at]?.text === "{") {
    const named = namedBindings(tokens, at);
    if (named === undefined) return undefined;
    names.push(...named.names);
    at = named.end;
  } else if (names.length === 0) return undefined;
  return finish(source, tokens, at, names);
};

const finish = (source, tokens, at, names) =>
  tokens[at]?.text === "from" && isIncurSpecifier(source, tokens[at + 1])
    ? names
    : undefined;

/**
 * The bindings of each declaration that takes something from incur.
 * @param {string} source
 * @returns {string[][]}
 */
const incurDeclarations = (source) => {
  const { tokens } = tokenize(source);
  const declarations = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const keyword = tokens[index];
    if (
      keyword.kind !== "id" ||
      (keyword.text !== "import" && keyword.text !== "export")
    )
      continue;
    const bindings = incurBindings(source, tokens, index);
    if (bindings !== undefined) declarations.push(bindings);
  }
  return declarations;
};

/** Declarations that take zod's `z` from incur. @param {string} source */
export const incurZodImportCount = (source) =>
  incurDeclarations(source).filter((names) => names.includes("z")).length;

/**
 * Bindings taken from incur: one per named binding, and one for each default,
 * namespace, star, side-effect or dynamic import. @param {string} source
 */
export const incurImportedNameCount = (source) =>
  incurDeclarations(source).reduce((count, names) => count + names.length, 0);
