import { expect, it } from "vitest";

import { countDefaultValidationClients } from "../../../scripts/verify/mcp-client-validation.mjs";

// Sources spell the constructor as `NEW(` so this file is not itself counted.
const source = (text: string) => text.replaceAll("NEW(", "new " + "Client(");

it.each([
  ["NEW(info)", 1],
  ["NEW(info, { jsonSchemaValidator: validation })", 0],
  ["NEW(info, {\n  capabilities: {},\n  jsonSchemaValidator,\n})", 0],
  // A later client's validator does not hide an earlier default client.
  ["[NEW(a), NEW(b, { jsonSchemaValidator })]", 1],
  ["const a = NEW(a);\nconst b = NEW(b, { jsonSchemaValidator });", 1],
  ["NEW(a, { jsonSchemaValidator }); NEW(b)", 1],
  ["NEW(make(a), options(b))", 1],
  ["NEW(a); NEW(b);", 2],
  // Parentheses inside literals do not end the call.
  ['NEW({ name: "fixture )" }, { jsonSchemaValidator })', 0],
  ["NEW({ name: 'a)' }, { jsonSchemaValidator })", 0],
  ["NEW({ name: `a)` }, { jsonSchemaValidator })", 0],
  ['NEW({ name: "\\")" }, { jsonSchemaValidator })', 0],
  ['NEW({ name: "(" })', 1],
  // Comments, string literals and names do not stand in for the option.
  ["NEW(info, {\n  capabilities: {}, // add jsonSchemaValidator\n})", 1],
  ["NEW(info /* jsonSchemaValidator */)", 1],
  ['NEW({ name: "jsonSchemaValidator-client" })', 1],
  ["NEW(info, { note: `jsonSchemaValidator` })", 1],
  ["NEW(jsonSchemaValidator)", 1],
  ['NEW(info, { "jsonSchemaValidator": validation })', 0],
  // A commented-out call is not a client.
  ["// NEW(info)\nNEW(info, { jsonSchemaValidator })", 0],
  // Comments between the tokens do not hide the call.
  ["new /* fixture */ Client(info)", 1],
  ["new Client /* fixture */ (info)", 1],
  ["new /* a */ Client /* b */ (info, { jsonSchemaValidator })", 0],
  // Only an object literal that is a whole argument counts as the options.
  ["NEW(info, ({ jsonSchemaValidator }))", 1],
  ["NEW(info, enabled ? { jsonSchemaValidator } : {})", 1],
  ["NEW(info, { ...{ jsonSchemaValidator } })", 1],
  ["NEW(info, { capabilities: { jsonSchemaValidator } })", 1],
] as const)("counts default-validation clients in %j", (text, expected) => {
  expect(countDefaultValidationClients(source(text))).toBe(expected);
});
