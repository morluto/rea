import { expect, it } from "vitest";
import { parseOpenStep } from "plist";

import { plistNestingLimitMessage } from "./apple/plistValue.js";
import { decodeOpenStepPropertyList } from "./propertyListOpenStep.js";

it.each([
  "{ numeric = (42, -2.5, 0x10, YES); path = /a/b:c$; }",
  String.raw`{ escapes = "\n\r\t\0\"\\\q\137\U0041"; }`,
  "{ bytes = (<ffzz0>, <0>, <a b c d>, <>); }",
  '/* header */ ("//text", "/*text*/", /* before */ value, // after\n)',
  "{ first = x second = y; third = (a, b,); }",
  "{ (one, two) = array; { nested = key; } = object; <01ff> = data; }",
  "{} /* unterminated",
  "() ((((((((((",
])("preserves pinned lexical and container values for %s", (text) => {
  expect(decodeOpenStepPropertyList(text)).toEqual(parseOpenStep(text));
});

const syntaxFailure = (read: () => unknown): Error => {
  try {
    read();
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw cause;
  }
  throw new Error("Expected syntax failure");
};

it.each([
  "(}",
  "{)",
  "(@",
  "{key @",
  "(x @",
  "(x ",
  "{key ",
  "{key = x,",
  '{ key = "unterminated',
  '{ key = "escape\\',
  "{ key = <01",
  "{ /* unterminated",
  "(x, /* unterminated",
  "{ { toString = text; } @",
  "{ { toString = text; } = value; }",
])(
  "preserves pinned syntax diagnosis before later deep input after %s",
  (prefix) => {
    for (const text of [prefix, prefix + "(".repeat(130)]) {
      const pinned = syntaxFailure(() => parseOpenStep(text));
      const owned = syntaxFailure(() => decodeOpenStepPropertyList(text));
      expect(owned.constructor).toBe(pinned.constructor);
      expect(owned.message).toBe(pinned.message);
    }
  },
);

it("retains every compound-coerced dictionary key with last assignment winning", () => {
  const value = decodeOpenStepPropertyList(
    '{ (__proto__) = first; (("__proto__")) = last; nested = { __proto__ = { x = y; }; }; constructor = text; }',
  ) as Record<string, unknown>;
  expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toBe(
    "last",
  );
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  const nested = value["nested"] as object;
  expect(Object.getOwnPropertyDescriptor(nested, "__proto__")?.value).toEqual({
    x: "y",
  });
  expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
  expect(JSON.stringify(value)).toBe(
    '{"__proto__":"last","nested":{"__proto__":{"x":"y"}},"constructor":"text"}',
  );
});

it("bounds compound keys and later siblings at their owning parse", () => {
  const deep = "(".repeat(30_000) + "x" + ")".repeat(30_000);
  for (const source of [`((x),${deep})`, `{(key)=${deep};}`, `{${deep}=x;}`])
    expect(() => decodeOpenStepPropertyList(source)).toThrow(
      plistNestingLimitMessage(),
    );
  // A scalar key identifies its parent's member rather than adding value depth.
  expect(decodeOpenStepPropertyList("{ key = (); }", 1)).toEqual({ key: [] });
  expect(() => decodeOpenStepPropertyList("{ (key) = (); }", 1)).toThrow(
    plistNestingLimitMessage(1),
  );
});

it.each(["(x,", "{ key ="])(
  "retains incomplete-value syntax for %s",
  (text) => {
    expect(syntaxFailure(() => decodeOpenStepPropertyList(text)).message).toBe(
      syntaxFailure(() => parseOpenStep(text)).message,
    );
  },
);
