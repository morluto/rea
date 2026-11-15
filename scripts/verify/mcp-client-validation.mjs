import { closingParen } from "./keyed-first-match.mjs";

const CLIENT = /\bnew Client\(/gu;

/**
 * Number of `new Client(...)` calls in `content` whose own arguments do not
 * name `jsonSchemaValidator`. Each call is read to its matching parenthesis,
 * so a neighbouring client that passes a validator does not hide one that
 * does not.
 */
export const countDefaultValidationClients = (content) =>
  [...content.matchAll(CLIENT)].filter((match) => {
    const open = match.index + match[0].length - 1;
    const end = closingParen(content, open);
    return !content
      .slice(open, end < 0 ? content.length : end)
      .includes("jsonSchemaValidator");
  }).length;
