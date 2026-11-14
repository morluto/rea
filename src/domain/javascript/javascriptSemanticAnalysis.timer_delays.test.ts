import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const operations = (source: string) =>
  analyzeJavaScriptSemantics(source).timerOperations;

it.each(["setTimeout", "setInterval"])(
  "does not create a %s handle when delay conversion must throw",
  (method) => {
    const result = operations(`
      import { ${method}, clearTimeout } from "node:timers";
      const positive = ${method}(() => {}, 1n);
      const negative = ${method}(() => {}, -1n);
      const zero = ${method}(() => {}, 0n);
      const symbol = ${method}(() => {}, Symbol("delay"));
      const converted = ${method}(() => {}, BigInt("1"));
      clearTimeout(positive);
    `);
    expect(result.filter(({ kind }) => kind === "schedule")).toEqual([]);
    expect(result).toMatchObject([
      { kind: "cancel", resolution: "unresolved", linkedTimerId: null },
    ]);
  },
);

it("keeps supported delays and the immediate callback's BigInt argument", () => {
  const result = operations(`
    import { setTimeout, setInterval, setImmediate } from "node:timers";
    setTimeout(() => {}, "2");
    setInterval(() => {}, null);
    setTimeout(() => {}, !1n);
    setTimeout(() => {}, void 1n);
    setImmediate(() => {}, 1n);
  `);
  expect(result.map(({ method }) => method)).toEqual([
    "setTimeout",
    "setInterval",
    "setTimeout",
    "setTimeout",
    "setImmediate",
  ]);
});

it("retains uncertain delays, shifted arguments and shadowed constructors", () => {
  const result = operations(`
    import { setTimeout } from "node:timers";
    function schedule(delay, args, Symbol, BigInt) {
      setTimeout(() => {}, delay);
      setTimeout(...args, 1n);
      setTimeout(() => {}, ...args);
      setTimeout(() => {}, Symbol("delay"));
      setTimeout(() => {}, BigInt("1"));
    }
  `);
  expect(result).toHaveLength(5);
});

it.each([
  'eval("Symbol = () => 1; BigInt = () => 1");',
  '(0, eval)("Symbol = () => 1; BigInt = () => 1");',
  'Function("Symbol = () => 1; BigInt = () => 1")();',
])(
  "retains delays after global code may replace constructors: %s",
  (effect) => {
    expect(
      operations(`
    import { setTimeout, setInterval } from "node:timers";
    ${effect}
    setTimeout(() => {}, Symbol("delay"));
    setInterval(() => {}, BigInt("1"));
  `).map(({ method }) => method),
    ).toEqual(["setTimeout", "setInterval"]);
  },
);

it("keeps literal rejection independent of global code effects", () => {
  expect(
    operations(`
    import { setTimeout } from "node:timers";
    eval(code);
    setTimeout(() => {}, 1n);
  `),
  ).toEqual([]);
});

it("ignores later global code and shadowed eval for constructor identity", () => {
  expect(
    operations(`
    import { setTimeout } from "node:timers";
    setTimeout(() => {}, Symbol("delay"));
    eval("Symbol = () => 1");
  `),
  ).toEqual([]);
  expect(
    operations(`
    import { setTimeout } from "node:timers";
    function run(eval) {
      eval("Symbol = () => 1");
      setTimeout(() => {}, Symbol("delay"));
    }
  `),
  ).toEqual([]);
});

it.each([
  ["Symbol", "configure(globalThis);"],
  ["BigInt", "configure(globalThis);"],
  ["Symbol", "const host = globalThis; configure(host);"],
  ["BigInt", "configure({ host: globalThis });"],
])("retains %s delays and cancellation after %s", (constructor, effect) => {
  const result = operations(`
    import configure from "./configure.js";
    import { setTimeout, clearTimeout } from "node:timers";
    ${effect}
    const handle = setTimeout(() => {}, ${constructor}("1"));
    clearTimeout(handle);
  `);
  expect(result).toMatchObject([
    { kind: "schedule", resolution: "complete" },
    { kind: "cancel", resolution: "complete" },
  ]);
  expect(result[1]?.linkedTimerId).toBe(result[0]?.timerId);
});

it("still rejects literal BigInt delays after the global object escapes", () => {
  expect(
    operations(`
    import configure from "./configure.js";
    import { setTimeout, setInterval } from "node:timers";
    configure(globalThis);
    setTimeout(() => {}, 1n);
    setInterval(() => {}, -1n);
  `),
  ).toEqual([]);
});

it("does not let later or unrelated escapes change constructor identity", () => {
  expect(
    operations(`
    import configure from "./configure.js";
    import { setTimeout, setInterval } from "node:timers";
    configure({});
    setTimeout(() => {}, Symbol("1"));
    setInterval(() => {}, BigInt("1"));
    configure(globalThis);
  `),
  ).toEqual([]);
});

it("selects a constructor before an argument can escape the global object", () => {
  expect(
    operations(`
    import configure from "./configure.js";
    import { setTimeout } from "node:timers";
    setTimeout(() => {}, Symbol(configure(globalThis)));
  `),
  ).toEqual([]);
});

it.each(["Symbol", "BigInt"])(
  "retains %s identity uncertainty inside an escaped callback",
  (constructor) => {
    const result = operations(`
    import configure from "./configure.js";
    import { setTimeout, clearTimeout } from "node:timers";
    configure(globalThis, () => {
      const handle = setTimeout(() => {}, ${constructor}("1"));
      clearTimeout(handle);
    });
  `);
    expect(result).toMatchObject([
      { kind: "schedule", resolution: "complete" },
      { kind: "cancel", resolution: "complete" },
    ]);
    expect(result[1]?.linkedTimerId).toBe(result[0]?.timerId);
  },
);

it.each([
  'for (let i=0;i<2;i++) configure(globalThis, i ? setTimeout(()=>{}, Symbol("1")) : null);',
  'function run(first) { configure(globalThis, first ? null : setTimeout(()=>{}, BigInt("1"))); } run(true); run(false);',
  'let first=true; while (next()) { configure(globalThis, first ? null : setTimeout(()=>{}, Symbol("1"))); first=false; }',
])("retains constructor uncertainty across repeated escapes: %s", (source) => {
  expect(
    operations(
      `import configure from "./configure.js"; import {setTimeout} from "node:timers"; ${source}`,
    ),
  ).toMatchObject([{ kind: "schedule" }]);
});
