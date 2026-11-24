import { tokenize } from "./source-tokens.mjs";

// CI runs the architecture guards before installing dependencies, so this
// reads the call from scripts/verify/source-tokens.mjs tokens rather than a
// parser package.

// Skips files that never name Client. Comments between `new`, `Client` and
// `(` are read from the tokens, so this test must not require them adjacent.
const MENTIONS_CLIENT = /\bClient\b/u;
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

const isPunct = (token, text) => token?.kind === "punct" && token.text === text;

/**
 * Read the SDK constructor's second argument. Its whole expression must
 * be an object literal naming its own jsonSchemaValidator option.
 */
const callNamesValidator = (source, tokens, open) => {
  const closers = [];
  let inOptions = false;
  let argumentObject = false;
  let named = false;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (closers.length === 1 && isPunct(token, ",")) {
      if (inOptions) return false;
      inOptions = true;
      continue;
    }
    if (token.kind === "punct" && OPENERS.has(token.text)) {
      if (closers.length === 1 && token.text === "{") {
        const before = tokens[index - 1];
        argumentObject = inOptions && isPunct(before, ",");
        named = false;
      }
      closers.push(OPENERS.get(token.text));
      continue;
    }
    if (token.kind === "punct" && token.text === closers.at(-1)) {
      closers.pop();
      if (closers.length === 0) return false;
      if (
        closers.length === 1 &&
        token.text === "}" &&
        argumentObject &&
        named &&
        (isPunct(tokens[index + 1], ",") || isPunct(tokens[index + 1], ")"))
      )
        return true;
      continue;
    }
    if (closers.length !== 2 || closers[1] !== "}" || !argumentObject) continue;
    const before = tokens[index - 1];
    const after = tokens[index + 1];
    if (
      (isPunct(before, "{") || isPunct(before, ",")) &&
      (isPunct(after, ":") || isPunct(after, ",") || isPunct(after, "}")) &&
      keyName(source, token) === "jsonSchemaValidator"
    )
      named = true;
  }
  return false;
};

/**
 * Number of `new Client(...)` calls in `content` whose own arguments do not
 * pass a `jsonSchemaValidator` property. The source is tokenized, so the
 * option is read from the second argument's own object literal. Comments,
 * client metadata and neighbouring calls cannot stand in for options.
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
