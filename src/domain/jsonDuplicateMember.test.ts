import { expect, it } from "vitest";

import { findDuplicateJsonMember } from "./jsonDuplicateMember.js";

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
