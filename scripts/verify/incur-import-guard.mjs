// Counts import and re-export declarations that take zod's `z` from incur
// (`import { z } from "incur"`, `import type { z as Zod } from 'incur'`,
// `export { z } from "incur"`). Declarations are read from code tokens, so the
// same text in a comment, string or template is not counted.
import { tokenize } from "./source-tokens.mjs";

const isIncurSpecifier = (source, token) =>
  token?.kind === "string" &&
  (source.startsWith('"incur"', token.start) ||
    source.startsWith("'incur'", token.start));

/** @param {string} source */
export const incurZodImportCount = (source) => {
  const { tokens } = tokenize(source);
  let count = 0;
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
    let importsZ = false;
    for (at += 1; at < tokens.length && tokens[at].text !== "}"; at += 1)
      // In `{ z as zod }` the imported name is z; in `{ zod as z }` it is not.
      if (tokens[at].text === "z" && tokens[at - 1]?.text !== "as")
        importsZ = true;
    if (
      importsZ &&
      tokens[at + 1]?.text === "from" &&
      isIncurSpecifier(source, tokens[at + 2])
    )
      count += 1;
    index = at;
  }
  return count;
};
