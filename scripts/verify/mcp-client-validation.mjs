import { parse } from "@babel/parser";
import { traverseFast } from "@babel/types";

const CLIENT = /\bnew\s+Client\s*\(/gu;
const MENTIONS_CLIENT = /\bnew\s+Client\s*\(/u;

const keyName = (key) =>
  key.type === "Identifier"
    ? key.name
    : key.type === "StringLiteral"
      ? key.value
      : undefined;

/** Whether one argument is an object literal that names the option itself. */
const namesValidator = (argument) =>
  argument.type === "ObjectExpression" &&
  argument.properties.some(
    (property) =>
      property.type === "ObjectProperty" &&
      !property.computed &&
      keyName(property.key) === "jsonSchemaValidator",
  );

/**
 * Number of `new Client(...)` calls in `content` whose own arguments do not
 * pass a `jsonSchemaValidator` property. The source is parsed, so the option
 * is read from the call's object-literal arguments: comments, string
 * literals, client names and neighbouring calls do not stand in for it. A
 * source that does not parse counts every textual `new Client(` call, so a
 * syntax the parser rejects cannot hide a default client.
 */
export const countDefaultValidationClients = (content) => {
  if (!MENTIONS_CLIENT.test(content)) return 0;
  let tree;
  try {
    tree = parse(content, { sourceType: "module", plugins: ["typescript"] });
  } catch {
    return [...content.matchAll(CLIENT)].length;
  }
  let count = 0;
  traverseFast(tree, (node) => {
    if (
      node.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "Client" &&
      !node.arguments.some(namesValidator)
    )
      count += 1;
  });
  return count;
};
