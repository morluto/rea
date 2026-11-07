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
  // A value outside the signed 32-bit range cannot be a bitmask at all.
  ["an int32-overflow flag", `openSync(p, 2147483648)`],
  ["an int32-underflow flag", `openSync(p, -2147483649)`],
  ["a negated fractional flag", `openSync(p, -1.5)`],
  ["a non-finite numeric flag", `openSync(p, 1e400)`],
  ["a NaN flag", `openSync(p, NaN)`],
  ["an Infinity flag", `openSync(p, Infinity)`],
  ["a BigInt flag", `openSync(p, 0n)`],
  ["a true flag", `openSync(p, true)`],
  ["a false flag", `openSync(p, false)`],
  ["an object flag", `openSync(p, {})`],
  ["an array flag", `openSync(p, [])`],
  // A unary operator is judged by its result, not by its operand: `!` yields a
  // boolean and `~0` yields `-1`.
  ["a logical-not flag", `openSync(p, !0)`],
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
  // `void <expr>` is `undefined`, which Node accepts as the default read flag,
  // so the operand must never decide the outcome.
  ["a void flag over a fraction", `openSync(p, void 1.5)`],
  ["a void flag over a string", `openSync(p, void "r")`],
  // `-0` is the valid zero bitmask, and `~-1` is `0`.
  // The sign does not prove rejection: Node accepts some signed bitmasks such as
  // `-2147483648` and rejects others such as `-1`, so an in-range negative is
  // deliberately left undecided and keeps its acquisition.
  ["a minimum int32 bitmask", `openSync(p, -2147483648)`],
  ["a negative power-of-two bitmask", `openSync(p, -1073741824)`],
  ["an in-range negative bitmask", `openSync(p, -1)`],
  // `~0` is `-1` and `~1` is `-2`. Node happens to reject both, but that is the
  // same undecidable signed-bitmask question, so they stay undecided too.
  ["a bitwise-not of zero", `openSync(p, ~0)`],
  ["a bitwise-not of one", `openSync(p, ~1)`],
  ["a maximum int32 bitmask", `openSync(p, 2147483647)`],
  ["a negative-zero flag", `openSync(p, -0)`],
  ["a negative-zero expression flag", `openSync(p, -0.0)`],
  ["a unary-plus zero flag", `openSync(p, +0)`],
  ["a bitwise-not of negative one", `openSync(p, ~-1)`],
  // A spread before the flag slot shifts the runtime position, so argument 1 is
  // not provably the flag: `openSync(...args, "0600")` opens with a mode.
  ["a spread before the flag", `openSync(...args, "0600")`],
  ["a spread supplying every argument", `openSync(...args)`],
  ["a spread in the flag slot", `openSync(p, ...flags)`],
  // A spread before the mode slot shifts the runtime position, and a spread in
  // the mode slot hides the value, so the guard must keep the acquisition.
  [
    "a spread in the flag that shifts the mode slot",
    `openSync(...args, "r", "0600")`,
  ],
  ["a spread in the mode slot", `openSync(p, "r", ...modes)`],
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

/**
 * Node validates the `mode` in slot 2 before touching the filesystem. A numeric
 * mode must be an unsigned 32-bit integer and a string mode must be a canonical
 * octal digit string; anything else throws synchronously and no descriptor
 * exists. `null`, `undefined` and `void <expr>` default the mode, and a computed
 * value may still be valid, so those are kept.
 *
 *   fs.openSync(p, "r", -1)        -> THREW ERR_OUT_OF_RANGE
 *   fs.openSync(p, "r", 1.5)       -> THREW ERR_OUT_OF_RANGE
 *   fs.openSync(p, "r", true)      -> THREW ERR_INVALID_ARG_TYPE
 *   fs.openSync(p, "r", "8")       -> THREW ERR_INVALID_ARG_VALUE
 *   fs.openSync(p, "r", "")        -> THREW ERR_INVALID_ARG_VALUE
 *   fs.openSync(p, "r", 0o644)     -> ok
 *   fs.openSync(p, "r", "0644")    -> ok
 *   fs.openSync(p, "r", null)      -> ok
 */
it.each([
  ["a negative mode", `openSync("x", "r", -1)`],
  ["a fractional mode", `openSync("x", "r", 1.5)`],
  ["a NaN mode", `openSync("x", "r", NaN)`],
  ["an Infinity mode", `openSync("x", "r", Infinity)`],
  ["an overflowing mode", `openSync("x", "r", 1e21)`],
  ["a boolean mode", `openSync("x", "r", true)`],
  ["a BigInt mode", `openSync("x", "r", 0n)`],
  ["an object mode", `openSync("x", "r", {})`],
  ["an array mode", `openSync("x", "r", [])`],
  ["a non-octal mode string", `openSync("x", "r", "8")`],
  ["an empty mode string", `openSync("x", "r", "")`],
  ["a prefixed mode string", `openSync("x", "r", "0o644")`],
  ["a padded mode string", `openSync("x", "r", " 644 ")`],
  ["a rejected fs/promises mode", `openPromise("x", "r", -1)`],
] as const)("emits no fs acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  ["a zero mode", `openSync("x", "r", 0)`, "openSync"],
  ["an octal numeric mode", `openSync("x", "r", 0o644)`, "openSync"],
  ["the largest usable mode", `openSync("x", "r", 2147483647)`, "openSync"],
  ["a negated zero mode", `openSync("x", "r", -0)`, "openSync"],
  ["an octal mode string", `openSync("x", "r", "644")`, "openSync"],
  ["a zero-padded mode string", `openSync("x", "r", "0644")`, "openSync"],
  ["a null mode", `openSync("x", "r", null)`, "openSync"],
  ["an undefined mode", `openSync("x", "r", undefined)`, "openSync"],
  ["a void mode", `openSync("x", "r", void 0)`, "openSync"],
  ["an omitted mode", `openSync("x", "r")`, "openSync"],
  ["a computed mode", `openSync("x", "r", mode)`, "openSync"],
] as const)("keeps the fs acquisition for %s", (_name, call, method) => {
  expect(acquisitionsFor(call)).toEqual([
    { kind: "acquire", method: method ?? "openSync" },
  ]);
});

/**
 * Review findings on the mode guard.
 *
 * A no-expression template literal is exactly readable, so it is the same string
 * Node receives:
 *
 *   fs.openSync(p, `bad`)        -> THREW ERR_INVALID_ARG_VALUE
 *   fs.openSync(p, `r`)          -> ok
 *   fs.openSync(p, "r", `644`)   -> ok
 *   fs.openSync(p, "r", `8`)     -> THREW ERR_INVALID_ARG_VALUE
 *
 * An octal mode string above the uint32 maximum throws ERR_OUT_OF_RANGE, while the
 * maximum itself belongs to the range that aborts the process and so stays
 * undecided:
 *
 *   fs.openSync(p, "r", "37777777777")  -> 4294967295, abort, kept
 *   fs.openSync(p, "r", "40000000000")  -> 4294967296, THREW ERR_OUT_OF_RANGE
 *   fs.openSync(p, "r", "0644")         -> ok
 */
it.each([
  ["a rejected template flag", `openSync("x", ` + "`bad`" + `)`],
  ["a rejected template mode", `openSync("x", "r", ` + "`8`" + `)`],
  ["an octal mode above uint32", `openSync("x", "r", "40000000000")`],
  ["an octal mode far above uint32", `openSync("x", "r", "777777777777")`],
  ["a mode above uint32", `openSync("x", "r", 4294967296)`],
] as const)("emits no fs acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  ["an accepted template flag", `openSync("x", ` + "`r`" + `)`, "openSync"],
  [
    "an interpolated template flag",
    `openSync("x", ` + "`${flag}`" + `)`,
    "openSync",
  ],
  [
    "an accepted template mode",
    `openSync("x", "r", ` + "`644`" + `)`,
    "openSync",
  ],
  [
    "an interpolated template mode",
    `openSync("x", "r", ` + "`${mode}`" + `)`,
    "openSync",
  ],
  ["the uint32 mode boundary", `openSync("x", "r", 2147483647)`, "openSync"],
  [
    "the process-abort mode boundary",
    `openSync("x", "r", 2147483648)`,
    "openSync",
  ],
  [
    "the uint32 octal boundary",
    `openSync("x", "r", "37777777777")`,
    "openSync",
  ],
] as const)("keeps the fs acquisition for %s", (_name, call, method) => {
  expect(acquisitionsFor(call)).toEqual([{ kind: "acquire", method }]);
});

/**
 * Two further review findings.
 *
 * Leading zeros pad an octal mode without changing its value, so the range bound
 * must read the significant digits:
 *
 *   fs.openSync(p, "r", "00000000000000644") -> ok  (420)
 *   fs.openSync(p, "r", "0000040000000000")  -> THREW ERR_OUT_OF_RANGE (2^32)
 *
 * A unary operator over a BigInt literal is still a BigInt, which Node rejects in
 * both slots:
 *
 *   fs.openSync(p, -1n)      -> THREW ERR_INVALID_ARG_TYPE
 *   fs.openSync(p, "r", -1n) -> THREW ERR_INVALID_ARG_TYPE
 */
it.each([
  [
    "a zero-padded octal mode above uint32",
    `openSync("x", "r", "0000040000000000")`,
  ],
  ["a negated BigInt flag", `openSync("x", -1n)`],
  ["a unary-plus BigInt flag", `openSync("x", +1n)`],
  ["a negated BigInt mode", `openSync("x", "r", -1n)`],
  ["a unary-plus BigInt mode", `openSync("x", "r", +1n)`],
] as const)("emits no fs acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  [
    "a zero-padded octal mode",
    `openSync("x", "r", "00000000000000644")`,
    "openSync",
  ],
  [
    "a shorter zero-padded octal mode",
    `openSync("x", "r", "00000000644")`,
    "openSync",
  ],
] as const)("keeps the fs acquisition for %s", (_name, call, method) => {
  expect(acquisitionsFor(call)).toEqual([{ kind: "acquire", method }]);
});

/**
 * Two review findings.
 *
 * A regex literal is an object, which Node rejects in both slots, and a unary
 * operator applied to an unshadowed `NaN` or `Infinity` is the same non-finite
 * number the bare global is:
 *
 *   fs.openSync(p, /r/)          -> THREW ERR_INVALID_ARG_TYPE
 *   fs.openSync(p, -NaN)         -> THREW ERR_OUT_OF_RANGE
 *   fs.openSync(p, "r", -Infinity) -> THREW ERR_OUT_OF_RANGE
 *   --- accepted ---
 *   fs.openSync(p, void 0)       -> ok
 *   fs.openSync(p, -0)           -> ok
 */
it.each([
  ["a regex flag", `openSync("x", /r/)`],
  ["a regex mode", `openSync("x", "r", /644/)`],
  ["a negated NaN flag", `openSync("x", -NaN)`],
  ["a unary-plus Infinity flag", `openSync("x", +Infinity)`],
  ["a negated Infinity mode", `openSync("x", "r", -Infinity)`],
] as const)("emits no fs acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it("keeps the fs acquisition for a shadowed NaN flag", () => {
  expect(acquisitionsFor(`const NaN = 0o644; openSync("x", NaN)`)).toEqual([
    { kind: "acquire", method: "openSync" },
  ]);
});

/**
 * Review finding: a unary operator over an exact non-numeric primitive is coerced
 * by JavaScript, so the result is decidable rather than unknown:
 *
 *   fs.openSync(p, "r", -true)   -> mode -1, THREW ERR_OUT_OF_RANGE
 *   fs.openSync(p, "r", +"bad")  -> mode NaN, THREW ERR_OUT_OF_RANGE
 *   fs.openSync(p, +"bad")       -> flag NaN, THREW ERR_INVALID_ARG_VALUE
 */
it.each([
  ["a negated boolean mode", `openSync("x", "r", -true)`],
  ["a unary-plus bad string mode", `openSync("x", "r", +"bad")`],
  ["a bitwise-not null mode", `openSync("x", "r", ~null)`],
  ["a negated octal-looking string mode", `openSync("x", "r", -"644")`],
  ["a unary-plus bad string flag", `openSync("x", +"bad")`],
] as const)("emits no fs acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

/**
 * A nested unary chain resolves through its innermost readable operand, so the
 * conversion branch is actually exercised. Measured on Node 24.22.1:
 *
 *   ~-1       =  0   -> ok, `0` is the O_RDONLY bitmask
 *   ~~NaN     =  0   -> ok
 *   ~NaN      = -1   -> in-range negative, left undecided (some signed bitmasks and
 *                       `~NaN` itself return a descriptor on Linux)
 *   -(-1.5)   =  1.5 -> THREW ERR_OUT_OF_RANGE as a mode
 *   -(~NaN)   =  1   -> ok as a mode
 *   ~(-1.5)   = -1   -> in-range negative, left undecided
 */
it.each([
  ["a negated fractional mode", `openSync("x", "r", -(-1.5))`],
  ["a double-negated fractional flag", `openSync("x", -(-1.5))`],
] as const)("emits no fs acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  ["a nested bitwise-not flag", `openSync("x", ~-1)`],
  ["a doubly nested bitwise-not flag", `openSync("x", ~~NaN)`],
  ["a coerced valid mode", `openSync("x", "r", -(~NaN))`],
] as const)("keeps the fs acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "openSync" },
  ]);
});

it("leaves a bitwise-not NaN flag undecided", () => {
  // `~NaN` is `-1`: in range, and a negative bitmask is accepted on Linux, so the
  // guard must not claim it throws.
  expect(acquisitionsFor(`openSync("x", ~NaN)`)).toEqual([
    { kind: "acquire", method: "openSync" },
  ]);
});

/**
 * Review finding: `staticFlagBits` reports "not a bitmask" for `!`, `typeof` and
 * `delete` as `Number.NaN`. Recursing into that marker treated it as an operand value,
 * so `openSync(p, "r", +!0)` was rejected although it receives mode `1`.
 *
 * A nested boolean or string result is left undecided instead: `+!0` is `1` at
 * runtime, but deciding it needs the operand's truthiness rather than a bitmask read.
 */
it.each([
  ["a unary-plus boolean mode", `openSync("x", "r", +!0)`],
  ["a unary-plus false mode", `openSync("x", "r", +!1)`],
  ["a unary-plus boolean flag", `openSync("x", +!1)`],
] as const)("keeps the fs acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "openSync" },
  ]);
});

it("leaves a negated boolean mode undecided", () => {
  // `-!0` is `-1`, which Node rejects, but the outer operator cannot be decided from
  // a boolean marker, so the guard must not claim a throw.
  expect(acquisitionsFor(`openSync("x", "r", -!0)`)).toEqual([
    { kind: "acquire", method: "openSync" },
  ]);
});

/**
 * Review finding: a real `NaN` result and the "not a bitmask" answer must not share a
 * return slot. `staticFlagBits` reports a boolean or string operand as `Number.NaN`,
 * and `unaryOperandNumber` used `Object.is(nested, NaN)` to exclude it — which also
 * discarded an actual numeric `NaN`, so `-(-NaN)` kept a rejected acquisition.
 *
 * Measured on Node 24.22.1:
 *
 *   -(-NaN)  = NaN  -> THREW ERR_OUT_OF_RANGE
 *   +(~NaN)  = -1   -> THREW ERR_OUT_OF_RANGE
 *   ~~NaN    = 0    -> ok
 */
it.each([
  ["a double-negated NaN mode", `openSync("x", "r", -(-NaN))`],
  ["a unary-plus bitwise-not NaN mode", `openSync("x", "r", +(~NaN))`],
  ["a negated fractional mode", `openSync("x", "r", -(-1.5))`],
  ["a negated Infinity mode", `openSync("x", "r", -Infinity)`],
] as const)("emits no fs acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([]);
});

it.each([
  ["a doubly nested bitwise-not mode", `openSync("x", "r", ~~NaN)`],
  ["a unary-plus boolean mode", `openSync("x", "r", +!0)`],
  ["a negated boolean mode", `openSync("x", "r", -!0)`],
  ["a bitwise-not NaN flag", `openSync("x", ~NaN)`],
] as const)("keeps the fs acquisition for %s", (_name, call) => {
  expect(acquisitionsFor(call)).toEqual([
    { kind: "acquire", method: "openSync" },
  ]);
});
/**
 * `fs.createReadStream` and `fs.createWriteStream` validate their options object
 * before constructing the stream, so a refused member throws and no handle exists.
 *
 * Measured on Node 24.22.1, per member:
 *
 *   start / end   -1, 1.5, NaN, Infinity  -> THREW ERR_OUT_OF_RANGE
 *                 "10", null, true, 1n    -> THREW ERR_INVALID_ARG_TYPE
 *                 -0, 0, undefined        -> stream
 *   fd            -1, 1.5                 -> THREW ERR_OUT_OF_RANGE
 *                 "x"                     -> THREW ERR_INVALID_ARG_TYPE
 *                 null, 0                 -> stream
 *   highWaterMark -1, 1.5, "x"            -> THREW ERR_INVALID_ARG_VALUE
 *                 null, 0                 -> stream
 *   encoding      "nope", 1, true         -> THREW ERR_INVALID_ARG_VALUE
 *                 "utf8", "", null, 0, false -> stream
 *   start > end                            -> THREW ERR_OUT_OF_RANGE
 *   createWriteStream ignores `end`        -> stream even for `{end: -1}`
 *   flags / mode / autoClose are not validated eagerly
 */
const streamAcquisitionsFor = (call: string) =>
  analyzeJavaScriptSemantics(
    `import fs from "node:fs";\nfunction g(p, opts, n) { ${call}; }`,
  ).resourceOperations.map(({ kind, method }) => ({ kind, method }));

it.each(["createReadStream", "createWriteStream"] as const)(
  "retains %s and its release when Object.prototype may intercept option copying",
  (method) => {
    const operations = analyzeJavaScriptSemantics(`
      import fs from "node:fs";
      Object.defineProperty(Object.prototype, "start", { set(value) {}, configurable: true });
      const stream = fs.${method}("input", { start: -1 });
      stream.close();
    `).resourceOperations;
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "acquire", method }),
        expect.objectContaining({ kind: "release", method: "close" }),
      ]),
    );
  },
);

it("keeps native rejection when the other stream prototype changes or the change is later", () => {
  for (const setup of [
    'Object.defineProperty(fs.WriteStream.prototype, "start", { set(value) {} }); fs.createReadStream("input", { start: -1 });',
    'fs.createReadStream("input", { start: -1 }); Object.defineProperty(fs.ReadStream.prototype, "start", { set(value) {} });',
  ]) {
    const operations = analyzeJavaScriptSemantics(
      `const fs = require("node:fs"); ${setup}`,
    ).resourceOperations;
    expect(operations.filter(({ kind }) => kind === "acquire")).toEqual([]);
  }
});

it.each([
  ["createReadStream", "ReadStream"],
  ["createWriteStream", "WriteStream"],
] as const)(
  "retains %s when its constructor may be replaced",
  (method, constructor) => {
    const operations = analyzeJavaScriptSemantics(`
    import fs from "node:fs";
    const Native = fs.${constructor};
    fs.${constructor} = class extends Native { constructor(p, opts) { super(p, { ...opts, start: 0 }); } };
    const stream = fs.${method}("input", { start: -1 });
    stream.close();
  `).resourceOperations;
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "acquire",
          method,
          resolution: "partial",
        }),
        expect.objectContaining({
          kind: "release",
          method: "close",
          resolution: "partial",
        }),
      ]),
    );
  },
);

it("still rejects a bad read option when only the write constructor changed", () => {
  const operations = analyzeJavaScriptSemantics(`
    import fs from "node:fs";
    fs.WriteStream = Custom;
    fs.createReadStream("input", { start: -1 });
  `).resourceOperations;
  expect(operations.filter(({ kind }) => kind === "acquire")).toEqual([]);
});

it.each([
  ["ReadStream", "createReadStream"],
  ["WriteStream", "createWriteStream"],
] as const)(
  "retains %s prototype effects through named imports",
  (constructor, method) => {
    const operations = analyzeJavaScriptSemantics(`
    import fs, { ${constructor} } from "node:fs";
    Object.defineProperty(${constructor}.prototype, "start", { get() { return 0; }, set(value) {} });
    const stream = fs.${method}("input", { start: -1 });
    stream.close();
  `).resourceOperations;
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "acquire",
          method,
          resolution: "partial",
        }),
        expect.objectContaining({
          kind: "release",
          method: "close",
          resolution: "partial",
        }),
      ]),
    );
  },
);

it.each([
  ["ReadStream", "createReadStream", "FileReadStream", "Readable"],
  ["WriteStream", "createWriteStream", "FileWriteStream", "Writable"],
] as const)(
  "retains %s after shared constructor escapes or inherited mutations",
  (constructor, method, alias, parent) => {
    for (const setup of [
      `import { ${constructor} } from "node:fs"; configure(${constructor});`,
      `Object.defineProperty(fs.${alias}.prototype, "start", { get() { return 0; }, set(value) {} });`,
      `Object.defineProperty(require("node:stream").${parent}.prototype, "start", { get() { return 0; }, set(value) {} });`,
      `import { ${parent} } from "node:stream"; Object.defineProperty(${parent}.prototype, "start", { get() { return 0; }, set(value) {} });`,
    ]) {
      const preamble = setup.includes('require("node:stream")')
        ? 'const fs = require("node:fs");'
        : 'import fs from "node:fs";';
      const operations = analyzeJavaScriptSemantics(
        `${preamble} ${setup} const stream = fs.${method}("input", { start: -1 }); stream.close();`,
      ).resourceOperations;
      expect(operations, setup).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "acquire", method }),
          expect.objectContaining({ kind: "release", method: "close" }),
        ]),
      );
    }
  },
);

it("retains write streams when the named Buffer constructor escapes", () => {
  const operations = analyzeJavaScriptSemantics(
    `import fs from "node:fs"; import { Buffer as B } from "node:buffer"; configure(B); const stream = fs.createWriteStream("input", { encoding: "nope" }); stream.close();`,
  ).resourceOperations;
  expect(operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "acquire", method: "createWriteStream" }),
      expect.objectContaining({ kind: "release", method: "close" }),
    ]),
  );
});

it("keeps native rejection after unrelated prototype or local binding changes", () => {
  for (const setup of [
    'const { Writable } = require("node:stream"); Object.defineProperty(Writable.prototype, "start", { set(value) {} });',
    'let { ReadStream } = require("node:fs"); ReadStream = Custom;',
    "fs.FileReadStream = Custom;",
  ]) {
    const operations = analyzeJavaScriptSemantics(
      `const fs = require("node:fs"); ${setup} fs.createReadStream("input", { start: -1 });`,
    ).resourceOperations;
    expect(
      operations.filter(({ kind }) => kind === "acquire"),
      setup,
    ).toEqual([]);
  }
});

it.each([
  "Buffer.isEncoding = () => true",
  "globalThis.Buffer.isEncoding = () => true",
  "const { Buffer: B } = require('node:buffer'); B.isEncoding = () => true",
  "import { Buffer as B } from 'node:buffer'; B.isEncoding = () => true",
  "import * as b from 'node:buffer'; b.Buffer.isEncoding = () => true",
])("retains write streams after validator mutation: %s", (setup) => {
  const operations = analyzeJavaScriptSemantics(`
    ${setup.startsWith("import") ? 'import fs from "node:fs";' : 'const fs = require("node:fs");'} ${setup};
    const stream = fs.createWriteStream("input", { encoding: "nope" });
    stream.close();
  `).resourceOperations;
  expect(operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "acquire", method: "createWriteStream" }),
      expect.objectContaining({ kind: "release", method: "close" }),
    ]),
  );
});

it.each([
  "Buffer.isEncoding = () => true",
  "globalThis.Buffer.isEncoding = () => true",
  "const { Buffer: B } = require('node:buffer'); B.isEncoding = () => true",
  "import { Buffer as B } from 'node:buffer'; B.isEncoding = () => true",
])(
  "retains read streams with a boxed encoding after validator mutation: %s",
  (setup) => {
    const operations = analyzeJavaScriptSemantics(`
    ${setup.startsWith("import") ? 'import fs from "node:fs";' : 'const fs = require("node:fs");'} ${setup};
    const stream = fs.createReadStream("input", { encoding: new String("utf8") });
    stream.close();
  `).resourceOperations;
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "acquire",
          method: "createReadStream",
        }),
        expect.objectContaining({ kind: "release", method: "close" }),
      ]),
    );
  },
);

it("keeps independent rejection and later or unrelated validator writes precise", () => {
  for (const body of [
    'fs.createWriteStream("input", { encoding: "nope" }); Buffer.isEncoding = () => true;',
    'Buffer.other = 1; fs.createWriteStream("input", { encoding: "nope" });',
    'Buffer.isEncoding = () => true; fs.createWriteStream("input", { start: -1, encoding: "nope" });',
    'Buffer.isEncoding = () => true; fs.createReadStream("input", { encoding: "nope" });',
  ]) {
    const operations = analyzeJavaScriptSemantics(
      `const fs = require("node:fs"); ${body}`,
    ).resourceOperations;
    expect(operations.filter(({ kind }) => kind === "acquire")).toEqual([]);
  }
});

it.each([
  ["ReadStream", "createReadStream"],
  ["WriteStream", "createWriteStream"],
] as const)(
  "retains %s acquisition and release when its prototype intercepts start",
  (constructor, method) => {
    const operations = analyzeJavaScriptSemantics(`
    const fs = require("node:fs");
    Object.defineProperty(fs.${constructor}.prototype, "start", { get() { return 0; }, set(value) {} });
    const stream = fs.${method}("input", { start: -1 });
    stream.close();
  `).resourceOperations;
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "acquire",
          method,
          resolution: "partial",
        }),
        expect.objectContaining({
          kind: "release",
          method: "close",
          resolution: "partial",
        }),
      ]),
    );
  },
);

it.each(["createReadStream", "createWriteStream"] as const)(
  "does not attribute %s to fs after mutating the result of defineProperty",
  (method) => {
    const operations = analyzeJavaScriptSemantics(`
    const fs = require("node:fs");
    const alias = Object.defineProperty(fs, "tag", { value: 1 });
    alias.${method} = () => null;
    const stream = fs.${method}("input");
    stream.close();
  `).resourceOperations;
    expect(operations.filter(({ kind }) => kind === "acquire")).toEqual([]);
  },
);

it.each(["createReadStream", "createWriteStream"] as const)(
  "keeps descriptor-installed accessors conservative for %s",
  (method) => {
    for (const [descriptor, use] of [
      [`get: function () { this.${method} = () => null; }`, "fs.tag;"],
      [`set: function (_) { this.${method} = () => null; }`, "fs.tag = 1;"],
    ]) {
      const operations = analyzeJavaScriptSemantics(`
        const fs = require("node:fs");
        Object.defineProperty(fs, "tag", { ${descriptor} });
        ${use}
        const stream = fs.${method}("input");
        stream.close();
      `).resourceOperations;
      expect(operations.filter(({ kind }) => kind === "acquire")).toEqual([]);
    }
  },
);

it("checks the constructor at the factory call even when the factory was saved earlier", () => {
  const operations = analyzeJavaScriptSemantics(`
    const fs = require("node:fs");
    const read = fs.createReadStream;
    fs.ReadStream = Custom;
    const stream = read("input", { start: -1 });
    stream.close();
  `).resourceOperations;
  expect(operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "acquire", method: "createReadStream" }),
      expect.objectContaining({ kind: "release", method: "close" }),
    ]),
  );
});

it("still rejects a bad option when the matching constructor changes afterward", () => {
  const operations = analyzeJavaScriptSemantics(`
    const fs = require("node:fs");
    fs.createReadStream("input", { start: -1 });
    fs.ReadStream = Custom;
  `).resourceOperations;
  expect(operations.filter(({ kind }) => kind === "acquire")).toEqual([]);
});

it("retains a stream when its constructor is replaced through a module alias", () => {
  const operations = analyzeJavaScriptSemantics(`
    const fs = require("fs");
    const alias = require("node:fs");
    alias.ReadStream = Custom;
    fs.createReadStream("input", { start: -1 });
  `).resourceOperations;
  expect(operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "acquire", method: "createReadStream" }),
    ]),
  );
});

it("retains a stream when Object.defineProperty replaces its constructor through a module alias", () => {
  const operations = analyzeJavaScriptSemantics(`
    const fs = require("fs");
    const alias = require("node:fs");
    Object.defineProperty(alias, "ReadStream", { value: Custom });
    const stream = fs.createReadStream("input", { start: -1 });
    stream.close();
  `).resourceOperations;
  expect(operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "acquire",
        method: "createReadStream",
        resolution: "partial",
      }),
      expect.objectContaining({
        kind: "release",
        method: "close",
        resolution: "partial",
      }),
    ]),
  );
});

it("keeps native rejection when Object.defineProperty changes an unrelated fs slot", () => {
  const operations = analyzeJavaScriptSemantics(`
    const fs = require("node:fs");
    Object.defineProperty(fs, "WriteStream", { value: Custom });
    fs.createReadStream("input", { start: -1 });
  `).resourceOperations;
  expect(operations.filter(({ kind }) => kind === "acquire")).toEqual([]);
});

it("does not trust a replaced Object.defineProperty as a confined mutation", () => {
  const operations = analyzeJavaScriptSemantics(`
    const fs = require("node:fs");
    Object.defineProperty = patched;
    Object.defineProperty(fs, "WriteStream", { value: Custom });
    fs.createReadStream("input", { start: -1 });
  `).resourceOperations;
  expect(operations.filter(({ kind }) => kind === "acquire")).toEqual([]);
});

it("does not attribute a redefined factory to the native built-in", () => {
  const operations = analyzeJavaScriptSemantics(`
    const fs = require("node:fs");
    Object.defineProperty(fs, "createReadStream", { value: Custom });
    fs.createReadStream("input", { start: 0 });
  `).resourceOperations;
  expect(operations.filter(({ kind }) => kind === "acquire")).toEqual([]);
});

it("still rejects a bad option when a prototype change is definitely later", () => {
  const operations = analyzeJavaScriptSemantics(`
    import fs from "node:fs";
    fs.createReadStream("input", { start: -1 });
    Object.defineProperty(Object.prototype, "start", { set(value) {}, configurable: true });
  `).resourceOperations;
  expect(operations.filter(({ kind }) => kind === "acquire")).toEqual([]);
});

it("retains a bad option when prototype mutation timing crosses a callable", () => {
  const operations = analyzeJavaScriptSemantics(`
    import fs from "node:fs";
    function configure() { Object.defineProperty(Object.prototype, "start", { set(value) {}, configurable: true }); }
    function open() { return fs.createReadStream("input", { start: -1 }); }
  `).resourceOperations;
  expect(operations.filter(({ kind }) => kind === "acquire")).toHaveLength(1);
});

it.each(["createReadStream", "createWriteStream"] as const)(
  "rejects boxed numeric and encoding values for %s while leaving constructed fd unknown",
  (method) => {
    for (const member of [
      "start: new Number(0)",
      "highWaterMark: new Number(0)",
      "encoding: new String('utf8')",
    ])
      expect(streamAcquisitionsFor(`fs.${method}(p, { ${member} })`)).toEqual(
        [],
      );
    expect(
      streamAcquisitionsFor(`fs.${method}(p, { end: new Number(0) })`),
    ).toHaveLength(method === "createReadStream" ? 0 : 1);
    expect(
      streamAcquisitionsFor(`fs.${method}(p, { fd: new Handle() })`),
    ).toHaveLength(1);
  },
);

it.each(["createReadStream", "createWriteStream"] as const)(
  "keeps %s and its close when delete may evaluate to false",
  (method) => {
    const operations = analyzeJavaScriptSemantics(`
      const fs = require("node:fs");
      function open(p) {
        const o = {};
        Object.defineProperty(o, "x", { value: 1 });
        const stream = fs.${method}(p, { encoding: delete o.x });
        stream.close();
      }
    `).resourceOperations;
    const acquire = operations.find(
      (operation) => operation.kind === "acquire",
    );
    const release = operations.find(
      (operation) => operation.kind === "release",
    );
    expect(acquire).toMatchObject({ kind: "acquire", method });
    expect(release).toMatchObject({ kind: "release", method: "close" });
    expect(release?.linkedResourceIds).toContain(acquire?.resourceId);
  },
);

it.each([
  ["a negative start", `fs.createReadStream(p, {start: -1})`],
  ["a fractional start", `fs.createReadStream(p, {start: 1.5})`],
  ["a NaN start", `fs.createReadStream(p, {start: NaN})`],
  ["an Infinity start", `fs.createReadStream(p, {start: Infinity})`],
  ["a string start", `fs.createReadStream(p, {start: "10"})`],
  ["a null start", `fs.createReadStream(p, {start: null})`],
  ["a boolean start", `fs.createReadStream(p, {start: true})`],
  ["a BigInt start", `fs.createReadStream(p, {start: 1n})`],
  ["a negative end", `fs.createReadStream(p, {end: -1})`],
  ["a fractional end", `fs.createReadStream(p, {end: 1.5})`],
  ["a string end", `fs.createReadStream(p, {end: "x"})`],
  ["a null end", `fs.createReadStream(p, {end: null})`],
  ["a start above the end", `fs.createReadStream(p, {start: 10, end: 2})`],
  ["a negative fd", `fs.createReadStream(p, {fd: -1})`],
  ["a fractional fd", `fs.createReadStream(p, {fd: 1.5})`],
  ["a string fd", `fs.createReadStream(p, {fd: "x"})`],
  ["a negative high-water mark", `fs.createReadStream(p, {highWaterMark: -1})`],
  [
    "a fractional high-water mark",
    `fs.createReadStream(p, {highWaterMark: 1.5})`,
  ],
  ["a string high-water mark", `fs.createReadStream(p, {highWaterMark: "x"})`],
  ["an unknown encoding", `fs.createReadStream(p, {encoding: "nope"})`],
  ["a numeric encoding", `fs.createReadStream(p, {encoding: 5})`],
  ["a truthy boolean encoding", `fs.createReadStream(p, {encoding: true})`],
  ["a write-stream negative start", `fs.createWriteStream(p, {start: -1})`],
  ["a write-stream fractional start", `fs.createWriteStream(p, {start: 1.5})`],
  ["a write-stream string start", `fs.createWriteStream(p, {start: "x"})`],
  ["a write-stream negative fd", `fs.createWriteStream(p, {fd: -1})`],
  [
    "a write-stream negative high-water mark",
    `fs.createWriteStream(p, {highWaterMark: -1})`,
  ],
  ["a write-stream numeric encoding", `fs.createWriteStream(p, {encoding: 5})`],
] as const)("emits no stream acquisition for %s", (_name, call) => {
  expect(streamAcquisitionsFor(call)).toEqual([]);
});

it.each([
  [
    "a descriptor with an unknown prototype",
    `fs.createReadStream(p, {fd: {__proto__: opts}})`,
  ],
  [
    "a copied prototype setter",
    `fs.createReadStream(p, {["__proto__"]: {set start(v) {}}, start: -1})`,
  ],
  [
    "a spread that may supply a prototype setter",
    `fs.createReadStream(p, {...opts, start: -1})`,
  ],
  [
    "a computed key that may be a prototype setter",
    `fs.createWriteStream(p, {[n]: opts, start: -1})`,
  ],
  ["a zero start", `fs.createReadStream(p, {start: 0})`],
  ["a negative zero start", `fs.createReadStream(p, {start: -0})`],
  ["an undefined start", `fs.createReadStream(p, {start: undefined})`],
  ["a zero end", `fs.createReadStream(p, {end: 0})`],
  ["an end equal to the start", `fs.createReadStream(p, {start: 2, end: 2})`],
  ["an end above the start", `fs.createReadStream(p, {start: 2, end: 10})`],
  ["a null fd", `fs.createReadStream(p, {fd: null})`],
  ["a null high-water mark", `fs.createReadStream(p, {highWaterMark: null})`],
  ["a known encoding", `fs.createReadStream(p, {encoding: "utf8"})`],
  [
    "an upper-case known encoding",
    `fs.createReadStream(p, {encoding: "UTF8"})`,
  ],
  ["an empty encoding", `fs.createReadStream(p, {encoding: ""})`],
  ["a null encoding", `fs.createReadStream(p, {encoding: null})`],
  ["a zero encoding", `fs.createReadStream(p, {encoding: 0})`],
  ["a false encoding", `fs.createReadStream(p, {encoding: false})`],
  ["an unvalidated flags value", `fs.createReadStream(p, {flags: 123})`],
  ["an unvalidated mode value", `fs.createReadStream(p, {mode: -1})`],
  ["an ignored end on a write stream", `fs.createWriteStream(p, {end: -1})`],
  ["an unreadable start", `fs.createReadStream(p, {start: n})`],
  ["no options object", `fs.createReadStream(p)`],
] as const)("keeps the stream acquisition for %s", (_name, call) => {
  expect(streamAcquisitionsFor(call)).toEqual([
    {
      kind: "acquire",
      method: call.includes("createWriteStream")
        ? "createWriteStream"
        : "createReadStream",
    },
  ]);
});
/**
 * Five shapes where the stream-option filter disagreed with Node 24.22.1:
 *
 * 1. A write stream ignores `end`, so neither its own check nor the `start > end`
 *    ordering applies: `createWriteStream(p, {start: 10, end: 2})` creates a handle.
 * 2. `end: Infinity` is a valid unlimited end on a read stream, while `start: Infinity`
 *    is out of range and `end: -Infinity` and `end: NaN` throw.
 * 3. A unary member is not always `+`: `~0` is `-1` and throws, `~-1` is `0` and does
 *    not, and `!0`, `!1` and `typeof 1` yield a boolean or a string Node refuses.
 * 4. Each integer member has its own upper bound: `start` and `end` stop at
 *    `Number.MAX_SAFE_INTEGER`, `fd` at `2_147_483_647`, and `highWaterMark` has none
 *    (`1e21` is accepted, `Infinity` is not).
 * 5. An object, array, function or regular expression member throws
 *    `ERR_INVALID_ARG_TYPE`.
 */
it.each([
  [`fs.createReadStream(p, {start: 10, end: 2})`],
  [`fs.createReadStream(p, {start: Infinity})`],
  [`fs.createReadStream(p, {end: -Infinity})`],
  [`fs.createReadStream(p, {end: NaN})`],
  [`fs.createReadStream(p, {start: ~0})`],
  [`fs.createReadStream(p, {end: ~0})`],
  [`fs.createReadStream(p, {start: !0})`],
  [`fs.createReadStream(p, {start: !1})`],
  [`fs.createReadStream(p, {start: typeof 1})`],
  [`fs.createReadStream(p, {start: 9007199254740992})`],
  [`fs.createReadStream(p, {end: 9007199254740992})`],
  [`fs.createReadStream(p, {fd: 2147483648})`],
  [`fs.createReadStream(p, {fd: -2147483648})`],
  [`fs.createWriteStream(p, {fd: 2147483648})`],
  [`fs.createReadStream(p, {highWaterMark: Infinity})`],
  [`fs.createReadStream(p, {highWaterMark: NaN})`],
  [`fs.createReadStream(p, {start: []})`],
  [`fs.createReadStream(p, {start: {}})`],
  [`fs.createReadStream(p, {start: () => {}})`],
  [`fs.createReadStream(p, {start: /x/})`],
] as const)("emits no stream acquisition for %s", (call) => {
  expect(streamAcquisitionsFor(call)).toEqual([]);
});

it.each([
  [
    "a write stream ignoring end",
    `fs.createWriteStream(p, {start: 10, end: 2})`,
  ],
  [
    "a write stream ignoring a negative end",
    `fs.createWriteStream(p, {end: -1})`,
  ],
  [
    "a write stream ignoring an infinite end",
    `fs.createWriteStream(p, {end: Infinity})`,
  ],
  ["an infinite end", `fs.createReadStream(p, {end: Infinity})`],
  ["an overflowing end", `fs.createReadStream(p, {end: 1e400})`],
  [
    "an infinite end above a start",
    `fs.createReadStream(p, {start: 5, end: Infinity})`,
  ],
  ["a complemented minus one", `fs.createReadStream(p, {start: ~-1})`],
  ["a complemented uint32 max", `fs.createReadStream(p, {start: ~4294967295})`],
  ["a void start", `fs.createReadStream(p, {start: void 0})`],
  [
    "an offset at the safe-integer ceiling",
    `fs.createReadStream(p, {start: 9007199254740991})`,
  ],
  ["a descriptor at int32 max", `fs.createReadStream(p, {fd: 2147483647})`],
  [
    "a descriptor above int32 on a write stream",
    `fs.createWriteStream(p, {fd: 2147483647})`,
  ],
  [
    "a high-water mark above int32",
    `fs.createReadStream(p, {highWaterMark: 2147483648})`,
  ],
  [
    "a high-water mark of 1e21",
    `fs.createReadStream(p, {highWaterMark: 1e21})`,
  ],
] as const)("keeps the stream acquisition for %s", (_name, call) => {
  expect(streamAcquisitionsFor(call)).toHaveLength(1);
});
/**
 * A getter in the options literal runs while Node enumerates and copies the object, so
 * it can replace another member before that member is read. Measured on Node 24.22.1:
 *
 *   createReadStream(p, {get reset(){this.start=0}, start:-1})  -> stream
 *   createReadStream(p, {get reset(){}, start:-1})              -> stream
 *   createReadStream(p, {set x(v){}, start:-1})                 -> THREW
 *   createReadStream(p, {reset(){this.start=0}, start:-1})      -> THREW (methods are not invoked)
 *   createReadStream(p, {start:-1, get z(){}})                  -> THREW (the getter runs after)
 *
 * A `set` accessor and a plain method do not run during the copy, so a bad member there
 * is still decided.
 */
it.each([
  [`fs.createReadStream(p, {get reset(){this.start=0}, start:-1})`],
  [`fs.createReadStream(p, {get reset(){}, start:-1})`],
  [`fs.createReadStream(p, {start:-1, get z(){}})`],
  [`fs.createReadStream(p, {get z(){this.highWaterMark=-1}, highWaterMark:0})`],
  [`fs.createWriteStream(p, {get reset(){this.start=0}, start:-1})`],
] as const)("leaves a getter-bearing options literal undecided: %s", (call) => {
  expect(streamAcquisitionsFor(call)).toHaveLength(1);
});

it.each([
  [`fs.createReadStream(p, {set x(v){}, start:-1})`],
  [`fs.createReadStream(p, {reset(){this.start=0}, start:-1})`],
  [`fs.createReadStream(p, {start:-1})`],
] as const)(
  "still decides a literal whose accessors do not run: %s",
  (call) => {
    expect(streamAcquisitionsFor(call)).toEqual([]);
  },
);
/**
 * A computed string key does not stop a getter from running while Node copies the
 * literal. Measured on Node 24.22.1:
 *
 *   createReadStream(p, {get ["reset"](){this.start=0}, start:-1})  -> stream
 *   createReadStream(p, {get ["reset"](){}, start:-1})              -> stream
 */
it("treats a computed string-key getter as eager", () => {
  expect(
    streamAcquisitionsFor(
      `fs.createReadStream(p, {get ["reset"](){this.start=0}, start:-1})`,
    ),
  ).toHaveLength(1);
  expect(
    streamAcquisitionsFor(
      `fs.createReadStream(p, {get ["reset"](){}, start:-1})`,
    ),
  ).toHaveLength(1);
});

/**
 * A method written in shorthand reaches the reader as an `ObjectMethod`, and a class
 * expression has the same runtime type as a function. Measured on Node 24.22.1, all of
 * `{start(){}}`, `{start: function(){}}`, `{start: class{}}` and `{start: function*(){}}`
 * throw `ERR_INVALID_ARG_TYPE`, and `{encoding(){}}` throws `ERR_INVALID_ARG_VALUE`.
 */
it.each([
  [`fs.createReadStream(p, {start(){}})`],
  [`fs.createReadStream(p, {end(){}})`],
  [`fs.createReadStream(p, {fd(){}})`],
  [`fs.createReadStream(p, {highWaterMark(){}})`],
  [`fs.createReadStream(p, {start: class{}})`],
  [`fs.createReadStream(p, {start: function*(){}})`],
  [`fs.createReadStream(p, {encoding(){}})`],
] as const)("emits no acquisition for a method-valued member: %s", (call) => {
  expect(streamAcquisitionsFor(call)).toEqual([]);
});

/**
 * Any truthy non-string `encoding` reaches Node's check and is refused; a falsy one is
 * skipped first. Measured on Node 24.22.1: `-1`, `1.5`, `Infinity`, `-Infinity`, `{}`
 * and `[]` throw `ERR_INVALID_ARG_VALUE`, while `0`, `-0`, `""`, `false`, `0n` and `NaN`
 * all construct a stream.
 */
it.each([
  [`fs.createReadStream(p, {encoding: -1})`],
  [`fs.createReadStream(p, {encoding: 1.5})`],
  [`fs.createReadStream(p, {encoding: Infinity})`],
  [`fs.createReadStream(p, {encoding: -Infinity})`],
  [`fs.createReadStream(p, {encoding: {}})`],
  [`fs.createReadStream(p, {encoding: []})`],
] as const)(
  "emits no acquisition for a truthy non-string encoding: %s",
  (call) => {
    expect(streamAcquisitionsFor(call)).toEqual([]);
  },
);

it.each([
  [`fs.createReadStream(p, {encoding: NaN})`],
  [`fs.createReadStream(p, {encoding: -0})`],
  [`fs.createReadStream(p, {encoding: 0})`],
  [`fs.createReadStream(p, {encoding: ""})`],
  [`fs.createReadStream(p, {encoding: false})`],
] as const)("keeps the acquisition for a falsy encoding: %s", (call) => {
  expect(streamAcquisitionsFor(call)).toHaveLength(1);
});
/**
 * `encoding` truthiness is a separate question from the numeric bounds. Measured on
 * Node 24.22.1:
 *
 *   {encoding: !1}        -> false, skipped          -> stream
 *   {encoding: !0}        -> true,  refused          -> THREW ERR_INVALID_ARG_VALUE
 *   {encoding: ~-1}       -> 0,     skipped          -> stream
 *   {encoding: ~0}        -> -1,    refused          -> THREW
 *   {encoding: typeof 1}  -> "number", refused       -> THREW
 *   {encoding: `utf8`}                               -> stream
 *   {encoding: `ut${"f8"}`}                          -> stream (interpolated, undecided)
 *   {encoding: `nope${"x"}`}                         -> THREW, but undecided here
 */
it.each([
  [`fs.createReadStream(p, {encoding: !1})`],
  [`fs.createReadStream(p, {encoding: ~-1})`],
  [`fs.createReadStream(p, {encoding: \`utf8\`})`],
  [`fs.createReadStream(p, {encoding: \`ut\${"f8"}\`})`],
  [`fs.createReadStream(p, {encoding: \`nope\${"x"}\`})`],
] as const)(
  "keeps the acquisition for a skipped or undecided encoding: %s",
  (call) => {
    expect(streamAcquisitionsFor(call)).toHaveLength(1);
  },
);

it.each([
  [`fs.createReadStream(p, {encoding: !0})`],
  [`fs.createReadStream(p, {encoding: ~0})`],
  [`fs.createReadStream(p, {encoding: typeof 1})`],
  // A regular expression is an object at runtime, and Node refuses it as an encoding.
  [`fs.createReadStream(p, {encoding: /x/})`],
  [`fs.createWriteStream(p, {encoding: /x/})`],
] as const)(
  "emits no acquisition for a truthy non-string encoding: %s",
  (call) => {
    expect(streamAcquisitionsFor(call)).toEqual([]);
  },
);
