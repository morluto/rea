import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `fs.open` and `fs.openSync` validate a literal flag string before touching the
 * filesystem and throw `ERR_INVALID_ARG_VALUE` synchronously, so no descriptor
 * exists and no resource is acquired. Node's accepted flag set is measured, not
 * guessed: `a`, `a+`, `as`, `as+`, `ax`, `ax+`, `r`, `r+`, `rs`, `rs+`, `sa`,
 * `sa+`, `sr`, `sr+`, `w`, `w+`, `wx`, `wx+`, `xa`, `xa+`, `xw`, `xw+`.
 *
 * A numeric flag is a platform bitmask and a computed value may still be a valid
 * flag, so only an exactly readable non-flag string is dropped.
 */
const acquisitionsFor = (call: string) =>
  analyzeJavaScriptSemantics(
    `import { open, openSync, createReadStream } from "node:fs";\nimport { open as openPromise } from "node:fs/promises";\nfunction g(p, cb) { ${call}; }`,
  ).resourceOperations.map(({ kind, method }) => ({ kind, method }));

it.each([
  ["a Python-style read flag", `openSync(p, "rb")`],
  ["a Python-style write flag", `openSync(p, "wb")`],
  ["an append-binary flag", `openSync(p, "ab")`],
  ["a lowercase x flag", `openSync(p, "x")`],
  ["a comma flag", `openSync(p, "r,x")`],
  ["an empty flag", `openSync(p, "")`],
  ["an uppercase flag", `openSync(p, "R")`],
  ["a callback-form read flag", `open(p, "rb", cb)`],
  ["a promise-form read flag", `openPromise(p, "rb")`],
  // Node also rejects every non-string flag that is not a nullish value or a
  // usable bitmask integer.
  ["a fractional flag", `openSync(p, 1.5)`],
  ["a negative flag", `openSync(p, -1)`],
  ["a negated fractional flag", `openSync(p, -1.5)`],
  ["a non-finite numeric flag", `openSync(p, 1e400)`],
  ["a NaN flag", `openSync(p, NaN)`],
  ["an Infinity flag", `openSync(p, Infinity)`],
  ["a BigInt flag", `openSync(p, 0n)`],
  ["a true flag", `openSync(p, true)`],
  ["a false flag", `openSync(p, false)`],
  ["an object flag", `openSync(p, {})`],
  ["an array flag", `openSync(p, [])`],
] as const)("emits no acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  ["a read flag", `openSync(p, "r")`],
  ["a read-plus flag", `openSync(p, "r+")`],
  ["an append-plus flag", `openSync(p, "a+")`],
  ["an exclusive write flag", `openSync(p, "wx")`],
  ["a symbolic-link flag", `openSync(p, "sr")`],
  ["an omitted flag", `openSync(p)`],
  ["a computed flag", `openSync(p, flag)`],
  ["a numeric bitmask", `openSync(p, 1)`],
  ["a zero bitmask", `openSync(p, 0)`],
  ["a large bitmask", `openSync(p, 65536)`],
  ["a unary-plus bitmask", `openSync(p, +5)`],
  ["an explicit undefined flag", `openSync(p, undefined)`],
  ["an explicit null flag", `openSync(p, null)`],
] as const)("keeps the acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "openSync" },
  ]);
});

it("keeps the callback-form acquisition with an accepted flag", () => {
  expect(acquisitionsFor(`open(p, "r", cb)`)).toEqual([
    { kind: "acquire", method: "open" },
  ]);
});

/**
 * `fs.createReadStream` does not validate the flag synchronously: it returns a
 * stream and surfaces the failure on the stream's error event, so the stream
 * object is still acquired.
 */
it("keeps a read stream whose flags option is invalid", () => {
  expect(acquisitionsFor(`createReadStream(p, { flags: "rb" })`)).toEqual([
    { kind: "acquire", method: "createReadStream" },
  ]);
});
