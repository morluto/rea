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

it.each([
  ["closing quote after a split slash run", 29, ""],
  ["closing quote after an even slash run", 36, ""],
  ["escaped quote after a split slash run", 29, '"{"decoy":0}'],
  ["escaped quote after an odd slash run", 36, '"{"decoy":0}'],
] as const)(
  "preserves the duplicate offset past a %s",
  (_case, padding, tail) => {
    const value = "a".repeat(padding) + "\\".repeat(2) + tail;
    const key = "member".repeat(12);
    const source = `{${JSON.stringify(key)}:${JSON.stringify(value)},`;
    const escapedKey = `"\\u006d${key.slice(1)}"`;
    expect(findDuplicateJsonMember(`${source}${escapedKey}:0}`)).toEqual({
      name: key,
      offset: source.length,
    });
  },
);

it("observes decimal member source in its decoded object, including escaped keys", () => {
  const observed: string[] = [];
  const parsed = parseJsonWithDuplicatePolicy(
    String.raw`{"files":{"__proto__":{"si\u007ae":1.0000000000000000001},"integer":{"size":1}},"nonFiles":[{"size":1e-1000}]}`,
    "reject",
    {
      name: "size",
      read: (owner, _value, source) => {
        observed.push(source);
        owner.size = source;
      },
    },
  );
  expect(observed).toEqual(["1.0000000000000000001"]);
  expect(parsed).toMatchObject({
    ok: true,
    firstObjectMember: "files",
    value: {
      files: Object.fromEntries([
        ["__proto__", { size: "1.0000000000000000001" }],
        ["integer", { size: 1 }],
      ]),
      nonFiles: [{ size: 0 }],
    },
  });
});

it("observes a decimal member deeper than the native reviver can recurse", () => {
  const depth = 5000;
  const source = `${'{"child":'.repeat(depth)}{"size":1e-1000}${"}".repeat(depth)}`;
  const observed: string[] = [];
  const parsed = parseJsonWithDuplicatePolicy(source, "reject", {
    name: "size",
    read: (_owner, _value, raw) => observed.push(raw),
  });
  expect(parsed.ok).toBe(true);
  expect(observed).toEqual(["1e-1000"]);
});
