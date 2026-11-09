import { openSync } from "node:fs";
import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const acquisitions = (path: string) => {
  const result = analyzeJavaScriptSemantics(`
    import { open, openSync } from "node:fs";
    import { open as openPromise } from "node:fs/promises";
    async function use(p, bytes, values) {
      const sync = openSync(${path}, "r");
      open(${path}, "r", () => {});
      const promise = await openPromise(${path}, "r");
      promise.close();
    }
  `);
  expect(result.coverage.status).toBe("complete");
  return result.resourceOperations;
};

it.each([
  ["false", false],
  ["null", null],
  ["42", 42],
  ["0n", 0n],
  ["-42", -42],
  ["+42", 42],
  ["!false", true],
  ["void 0", undefined],
  [String.raw`"a\0b"`, "a\0b"],
  ["`a\\0b`", "a\0b"],
] as const)(
  "does not acquire a file for the rejected path %s",
  (source, value) => {
    expect(() => Reflect.apply(openSync, undefined, [value, "r"])).toThrow(
      TypeError,
    );
    expect(acquisitions(source)).toEqual([]);
  },
);

it.each([
  '"input.txt"',
  "`input.txt`",
  "p",
  "bytes",
  'Buffer.from("input.txt")',
  'new URL("file:///input.txt")',
  "typeof p",
  "...values",
])("keeps a potentially accepted path %s undecided", (source) => {
  expect(
    acquisitions(source).map(({ kind, method }) => ({ kind, method })),
  ).toEqual([
    { kind: "acquire", method: "openSync" },
    { kind: "acquire", method: "open" },
    { kind: "acquire", method: "open" },
    { kind: "release", method: "close" },
  ]);
});

it("keeps a stream's fd override separate from open's path validation", () => {
  const result = analyzeJavaScriptSemantics(`
    import { createReadStream } from "node:fs";
    const stream = createReadStream(false, { fd: suppliedFd });
    stream.destroy();
  `);
  expect(result.resourceOperations.map(({ kind }) => kind)).toEqual([
    "acquire",
    "release",
  ]);
});
