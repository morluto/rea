import { parse } from "@babel/parser";
import { expect, it } from "vitest";

import { fingerprintJavaScriptAst } from "./javascriptAstFingerprint.js";

it.each([
  [
    "empty fixed object keys",
    'const value = { "": 0 };',
    'const value = { "x": 0 };',
  ],
  ["update expression prefix", "value++", "++value"],
  ["declaration kind", "var value = 1;", "const value = 1;"],
  [
    "function async flag",
    "function read() { return 1; }",
    "async function read() { return 1; }",
  ],
  ["function generator flag", "function* read() {}", "function read() {}"],
  ["class method kind", "class A { read() {} }", "class A { get read() {} }"],
  [
    "class method static flag",
    "class A { read() {} }",
    "class A { static read() {} }",
  ],
  [
    "class field static flag",
    "class A { value = 1; }",
    "class A { static value = 1; }",
  ],
  [
    "private method static flag",
    "class A { #read() {} }",
    "class A { static #read() {} }",
  ],
  [
    "private field static flag",
    "class A { #value = 1; }",
    "class A { static #value = 1; }",
  ],
  [
    "object method kind",
    "const value = { read() {} };",
    "const value = { get read() {} };",
  ],
])("distinguishes %s", (_name, left, right) => {
  expect(fingerprintJavaScriptAst(parse(left))).not.toBe(
    fingerprintJavaScriptAst(parse(right)),
  );
});

it("distinguishes public auto-accessor keys and flags while ignoring binding names", () => {
  // Auto-accessors are tested at the AST boundary because the source parser
  // does not enable Babel's auto-accessor syntax.
  const fingerprint = (source: string) =>
    fingerprintJavaScriptAst(
      parse(source, { plugins: ["decoratorAutoAccessors"] }),
    );
  const fixed = fingerprint("class A { accessor value = 1; }");
  expect(
    new Set([
      fixed,
      fingerprint("class A { accessor other = 1; }"),
      fingerprint("class A { static accessor value = 1; }"),
      fingerprint("class A { accessor [value] = 1; }"),
    ]).size,
  ).toBe(4);
  expect(
    fingerprint("const key = selectKey(); class A { accessor [key] = 1; }"),
  ).toBe(
    fingerprint(
      "const selector = selectKey(); class B { accessor [selector] = 1; }",
    ),
  );
  expect(fingerprint("class A { accessor #value = 1; }")).toBe(
    fingerprint("class A { accessor #renamed = 1; }"),
  );
});

it.each(["() {}", "= 1;"])(
  "distinguishes a computed class key from a fixed key in %s",
  (member) => {
    expect(
      fingerprintJavaScriptAst(parse(`class A { ["foo"]${member} }`)),
    ).not.toBe(fingerprintJavaScriptAst(parse(`class A { foo${member} }`)));
  },
);

it("ignores private class member renames", () => {
  expect(
    fingerprintJavaScriptAst(parse("class A { #read() {} #value = 1; }")),
  ).toBe(
    fingerprintJavaScriptAst(parse("class A { #renamed() {} #field = 1; }")),
  );
});

it("ignores local binding renames inside optional computed reads", () => {
  expect(
    fingerprintJavaScriptAst(
      parse("function read(obj, key) { return obj?.[key]; }"),
    ),
  ).toBe(
    fingerprintJavaScriptAst(
      parse("function read(value, selector) { return value?.[selector]; }"),
    ),
  );
});

it("distinguishes computed reads from fixed named members", () => {
  expect(fingerprintJavaScriptAst(parse("obj[key]"))).not.toBe(
    fingerprintJavaScriptAst(parse("obj.key")),
  );
  expect(fingerprintJavaScriptAst(parse("obj.key"))).not.toBe(
    fingerprintJavaScriptAst(parse("obj.other")),
  );
  expect(fingerprintJavaScriptAst(parse('obj["key"]'))).not.toBe(
    fingerprintJavaScriptAst(parse('obj["other"]')),
  );
});

it("distinguishes computed object keys from fixed object keys", () => {
  expect(fingerprintJavaScriptAst(parse("({ key: value })"))).not.toBe(
    fingerprintJavaScriptAst(parse("({ [key]: value })")),
  );
});

it.each([
  ["obj[``]", "obj[`right`]"],
  ["obj[true]", "obj[false]"],
  ["obj[`prefix-${key}`]", "obj[`changed-${key}`]"],
])("retains computed literal contents in %s", (left, right) => {
  expect(fingerprintJavaScriptAst(parse(left))).not.toBe(
    fingerprintJavaScriptAst(parse(right)),
  );
});
