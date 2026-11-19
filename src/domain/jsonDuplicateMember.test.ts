import { expect, it } from "vitest";

import {
  findDuplicateJsonMember,
  parseJsonStringLiteral,
  parseJsonWithDuplicatePolicy,
  parseLastWinsJson,
} from "./jsonDuplicateMember.js";

it.each([
  ['{"a":1,"a":2}', { name: "a", offset: 7 }],
  ['{"x":{"a":1,"b":{"a":2},"a":3}}', { name: "a", offset: 24 }],
  ['{"a":1,"\\u0061":2}', { name: "a", offset: 7 }],
  ['[{"k":"k"},{"k":["k","k"],"k":0}]', { name: "k", offset: 26 }],
])("finds the repeated name in %s", (text, expected) => {
  expect(findDuplicateJsonMember(text)).toEqual(expected);
});

it.each([
  '{"a":"a","b":"a"}',
  '{"a":{"a":{"a":1}}}',
  '["a","a",{"a":1},{"a":2}]',
  '{"a\\"b":1,"a":2,"b":"\\\\"}',
  '"a"',
  "{}",
])("accepts distinct names in %s", (text) => {
  expect(findDuplicateJsonMember(text)).toBeUndefined();
});

it("scans nesting deeper than the call stack allows", () => {
  const depth = 200_000;
  const text = `${'{"d":'.repeat(depth)}{"a":1,"a":2}${"}".repeat(depth)}`;
  expect(findDuplicateJsonMember(text)).toMatchObject({ name: "a" });
});

it("parses JSON with an explicit duplicate-member policy and string-literal helper", () => {
  expect(parseJsonWithDuplicatePolicy('{"a":1,"a":2}', "reject")).toEqual({
    ok: false,
    duplicate: { name: "a", offset: 7 },
  });
  expect(parseJsonWithDuplicatePolicy('{"a":1,"a":2}', "last-wins")).toEqual({
    ok: true,
    value: { a: 2 },
  });
  expect(parseJsonWithDuplicatePolicy("{", "reject")).toMatchObject({
    ok: false,
    cause: expect.any(SyntaxError),
  });
  expect(parseLastWinsJson('{"a":1,"a":2}')).toEqual({ a: 2 });
  expect(parseJsonStringLiteral('"\\u0061"')).toBe("a");
});

it("preserves the duplicate offset past long strings and escaped boundaries", () => {
  const literal = 'quote: " and slash: \\ '.repeat(8);
  const value = "a".repeat(30) + '"' + literal;
  const key = "member".repeat(12);
  const source = `{${JSON.stringify(key)}:${JSON.stringify(value)},`;
  const escapedKey = `"\\u006d${key.slice(1)}"`;
  expect(findDuplicateJsonMember(`${source}${escapedKey}:0}`)).toEqual({
    name: key,
    offset: source.length,
  });
});
