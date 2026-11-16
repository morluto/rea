// Reads the names that import and re-export declarations take from incur
// (`import { Cli, type Help } from "incur"`, `export { z } from 'incur'`).
// Declarations are read from code tokens, so the same text in a comment,
// string or template is not counted.
import { tokenize } from "./source-tokens.mjs";

const isIncurSpecifier = (source, token) =>
  token?.kind === "string" &&
  (source.startsWith('"incur"', token.start) ||
    source.startsWith("'incur'", token.start));

/**
 * The imported name of each binding, one list per declaration from incur.
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
    let at = index + 1;
    if (tokens[at]?.kind === "id" && tokens[at].text === "type") at += 1;
    if (tokens[at]?.text !== "{") continue;
    const names = [];
    let expectName = true;
    for (at += 1; at < tokens.length && tokens[at].text !== "}"; at += 1) {
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
    if (
      tokens[at + 1]?.text === "from" &&
      isIncurSpecifier(source, tokens[at + 2])
    )
      declarations.push(names);
    index = at;
  }
  return declarations;
};

/** Declarations that take zod's `z` from incur. @param {string} source */
export const incurZodImportCount = (source) =>
  incurDeclarations(source).filter((names) => names.includes("z")).length;

/** Names imported or re-exported from incur. @param {string} source */
export const incurImportedNameCount = (source) =>
  incurDeclarations(source).reduce((count, names) => count + names.length, 0);
