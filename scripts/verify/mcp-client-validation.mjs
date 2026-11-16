import { tokenize } from "./source-tokens.mjs";

// CI runs the architecture guards before installing dependencies, so this
// reads the call from scripts/verify/source-tokens.mjs tokens rather than a
// parser package.

const MENTIONS_CLIENT = /\bnew\s+Client\s*\(/u;
const OPENERS = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

/** The text of a quoted string token, or undefined for a template. */
const quotedText = (source, token) => {
  const quote = source[token.start];
  if (quote !== '"' && quote !== "'") return undefined;
  let text = "";
  for (let at = token.start + 1; at < source.length; at += 1) {
    if (source[at] === quote) return text;
    if (source[at] === "\\") at += 1;
    text += source[at];
  }
  return undefined;
};

/** The property name a token spells when it is an object key position. */
const keyName = (source, token) =>
  token.kind === "id" ? token.text : quotedText(source, token);

/**
 * Whether the arguments of the call whose `(` is at `open` pass an object
 * literal naming `jsonSchemaValidator` as one of its own keys (written
 * `jsonSchemaValidator: …` or as shorthand).
 */
const callNamesValidator = (source, tokens, open) => {
  const closers = [];
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "punct" && OPENERS.has(token.text)) {
      closers.push(OPENERS.get(token.text));
      continue;
    }
    if (token.kind === "punct" && token.text === closers.at(-1)) {
      closers.pop();
      if (closers.length === 0) return false;
      continue;
    }
    // A key of an object literal that is itself a direct argument.
    if (closers.length !== 2 || closers[1] !== "}") continue;
    const before = tokens[index - 1];
    const after = tokens[index + 1];
    if (
      before?.kind === "punct" &&
      (before.text === "{" || before.text === ",") &&
      after?.kind === "punct" &&
      (after.text === ":" || after.text === "," || after.text === "}") &&
      keyName(source, token) === "jsonSchemaValidator"
    )
      return true;
  }
  return false;
};

/**
 * Number of `new Client(...)` calls in `content` whose own arguments do not
 * pass a `jsonSchemaValidator` property. The source is tokenized, so the
 * option is read from the call's object-literal arguments: comments, string
 * literals, client names and neighbouring calls do not stand in for it.
 */
export const countDefaultValidationClients = (content) => {
  if (!MENTIONS_CLIENT.test(content)) return 0;
  const { tokens } = tokenize(content);
  let count = 0;
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (
      tokens[index].kind === "id" &&
      tokens[index].text === "new" &&
      tokens[index + 1].kind === "id" &&
      tokens[index + 1].text === "Client" &&
      tokens[index + 2].kind === "punct" &&
      tokens[index + 2].text === "(" &&
      !callNamesValidator(content, tokens, index + 2)
    )
      count += 1;
  }
  return count;
};
