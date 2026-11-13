import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { analyzeCommonJsSemanticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";

const functionValues = [
  ["arrow", "() => {}"],
  ["function", "function () {}"],
  ["async function", "async function () {}"],
  ["generator", "function* () {}"],
  ["class", "class {}"],
] as const;

const resourcesFor = (call: string) =>
  analyzeJavaScriptSemantics(`
    import {open, openSync} from "node:fs";
    import {open as openPromise} from "node:fs/promises";
    function f(p, cb, ...args) { ${call}; }
  `).resourceOperations;

it.each([
  "open(p)",
  'open(p, "r")',
  'open(p, "r", 0o644)',
  'open(p, "r", 0o644, 17)',
  'open(p, "r", 0o644, null)',
  'open(p, "r", 0o644, {})',
  'open(p, "r", 0o644, void sideEffect())',
])(
  "omits an open whose normalized callback is missing or nonfunction: %s",
  (call) => {
    expect(resourcesFor(call)).toEqual([]);
  },
);

it.each([
  'open(p, "r", cb, 17)',
  'open(p, "r", 0o644, cb)',
  'open(p, "r", 0o644, ...args)',
])("preserves an unknown callback or overload: %s", (call) => {
  expect(resourcesFor(call)).toHaveLength(1);
});

it.each(functionValues)(
  "rejects a %s in fs flag/mode value slots",
  (_kind, value) => {
    for (const call of [
      `openSync(p, ${value})`,
      `openSync(p, "r", ${value})`,
      `openPromise(p, ${value})`,
      `openPromise(p, "r", ${value})`,
      `open(p, ${value}, cb)`,
      `open(p, ${value}, ...args, cb)`,
    ])
      expect(resourcesFor(call), call).toEqual([]);
  },
);

it.each(functionValues)(
  "preserves %s callback overloads and an empty trailing spread",
  (_kind, value) => {
    for (const call of [
      `open(p, ${value})`,
      `open(p, "r", ${value})`,
      `open(p, "r", ${value}, 17)`,
      `open(p, ${value}, ...args)`,
    ])
      expect(resourcesFor(call), call).toMatchObject([
        { kind: "acquire", method: "open" },
      ]);
  },
);

it.each([
  "openSync(...args, () => {})",
  "openPromise(p, ...args, () => {})",
  "open(...args, () => {}, cb)",
  "openSync(p, flags)",
  'openPromise(p, "r", mode)',
])("leaves unresolved argument positions and values undecided: %s", (call) => {
  expect(resourcesFor(call)).toHaveLength(1);
});

it.each(["openSync(p, () => {})", 'openSync(p, "r", () => {})'])(
  "applies Node's rejection only to an established builtin: %s",
  (call) => {
    const source = `const {openSync}=require("node:fs"); function f(p) { ${call}; }`;
    expect(analyzeJavaScriptSemantics(source).resourceOperations).toMatchObject(
      [{ kind: "acquire", method: "openSync", builtinAuthority: "candidate" }],
    );
    expect(analyzeCommonJsSemanticFixture(source).resourceOperations).toEqual(
      [],
    );
  },
);
