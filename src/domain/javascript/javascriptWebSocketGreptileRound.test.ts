import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const endpoints = (source: string): string[] => {
  const analysis = analyzeJavaScriptStaticSource(source);
  expect(analysis.parse_status).not.toBe("failed");
  return analysis.endpoints.map(({ value }) => value);
};

it.each([
  {
    name: "later destructured getter before WebSocket initialization",
    source:
      'const { unused, run } = { get run() { new Socket("wss://example.test/second"); } }; const Socket = globalThis.WebSocket;',
    expected: [],
  },
  {
    name: "failed early callback alias does not hide the valid later callback",
    source:
      'const invoke = run => run(); const connect = () => new Socket("wss://example.test/argument"); function earlier() { try { invoke(alias); } catch {} } earlier(); const alias = connect; const Socket = globalThis.WebSocket; invoke(connect);',
    expected: ["wss://example.test/argument"],
  },
  {
    name: "native String iteration reaches the later destructuring wait",
    source:
      '(async()=>{const values=(function*(){yield "a";yield undefined;try{}finally{new Socket("wss://example.test/iterator")}})();const [[x],y=await 0]=values})();const Socket=globalThis.WebSocket;',
    expected: ["wss://example.test/iterator"],
  },
  {
    name: "throwing String iterator blocks the unreachable later default",
    source:
      'String.prototype[Symbol.iterator]=function*(){throw Error("stop")};(async()=>{const values=(function*(){yield "a";yield undefined;try{}finally{new Socket("wss://example.test/iterator")}})();const [[x],y=await 0]=values})();const Socket=globalThis.WebSocket;',
    expected: [],
  },
])("%s", ({ source, expected }) => {
  expect(endpoints(source)).toEqual(expected);
});

it("indexes callback candidates by the parameter actually called", () => {
  const count = 100;
  const calls = Array.from(
    { length: count },
    (_, index) =>
      `invoke(() => new Socket("wss://example.test/callback-${index}"));`,
  ).join("\n");
  const found = endpoints(
    `const Socket=globalThis.WebSocket;const invoke=run=>run();${calls}`,
  );
  expect(found).toHaveLength(count);
  expect(found).toContain("wss://example.test/callback-0");
  expect(found).toContain(`wss://example.test/callback-${count - 1}`);
});

it.each([
  [
    "keeps callback suppliers paired with their invocation",
    `
      const invoke = run => run();
      invoke(() => {});
      const Socket = globalThis.WebSocket;
      invoke(() => new Socket("wss://example.test/pair"));
    `,
    "wss://example.test/pair",
  ],
  [
    "does not enter apply receivers when argument-list creation fails",
    `
      const connect = () => new Socket("wss://example.test/apply");
      try { connect.apply(null, 1); } catch {}
      const Socket = globalThis.WebSocket;
    `,
    "wss://example.test/apply",
  ],
  [
    "accepts an inert method as import attributes",
    `
      export {};
      const { WebSocket: Socket } = await import("ws", { with() {} });
      new Socket("wss://example.test/options");
    `,
    "wss://example.test/options",
  ],
  [
    "falls back from a setter-only async disposer to a sync disposer",
    `
      (async () => {
        for (const value of (function* () {
          yield 0;
          new Socket("wss://example.test/disposer");
        })()) {
          await using resource = {
            set [Symbol.asyncDispose](value) {},
            [Symbol.dispose]() {},
          };
        }
      })();
      const Socket = globalThis.WebSocket;
    `,
    "wss://example.test/disposer",
  ],
] as const)("%s", (_name, source, endpoint) => {
  expect(endpoints(source)).toEqual([endpoint]);
});

it("orders helper selection before argument writes", () => {
  expect(
    endpoints(`
      const connect = () => new Socket("wss://example.test/helper-read");
      connect.call(null, connect.call = () => {});
      const Socket = globalThis.WebSocket;
    `),
  ).toEqual([]);
});

it.each([
  [
    "waits for a computed destructuring key before entering its getter",
    `
      (async () => {
        const { [void await 0]: value } = {
          get undefined() {
            return new Socket("wss://example.test/getter-key-wait");
          }
        };
      })();
      const Socket = globalThis.WebSocket;
    `,
    "wss://example.test/getter-key-wait",
  ],
  [
    "does not make an async executor result belong to its Promise",
    `
      let release;
      const ready = new Promise(resolve => { release = resolve; });
      const pending = new Promise(async resolve => {
        resolve();
        await ready;
        new Socket("wss://example.test/async-executor");
      });
      await pending;
      const Socket = globalThis.WebSocket;
      release();
    `,
    "wss://example.test/async-executor",
  ],
  [
    "does not enter a base field after changing the derived class prototype",
    `
      class Base {
        field = new Socket("wss://example.test/changed-base");
      }
      class Other {}
      class Derived extends Base {}
      Object.setPrototypeOf(Derived, Other);
      new Derived();
      const Socket = globalThis.WebSocket;
    `,
    "wss://example.test/changed-base",
  ],
] as const)("%s", (_name, source, endpoint) => {
  expect(endpoints(source)).toEqual([endpoint]);
});

it.each([
  [
    "enters base fields when an implicit subclass is constructed",
    `
      class Base { field = new Socket("wss://example.test/base-field"); }
      class Derived extends Base {}
      new Derived();
      const Socket = globalThis.WebSocket;
    `,
  ],
  [
    "enters a native Promise executor synchronously",
    `
      new Promise(() => new Socket("wss://example.test/promise-executor"));
      const Socket = globalThis.WebSocket;
    `,
  ],
  [
    "enters a fresh getter selected by object destructuring",
    `
      const { run } = {
        get run() { return new Socket("wss://example.test/destructured-getter"); }
      };
      const Socket = globalThis.WebSocket;
    `,
  ],
] as const)("%s", (_name, source) => {
  expect(endpoints(source)).toEqual([]);
});

it.each([
  [
    "does not credit a nested binding key wait before getter entry",
    '(async()=>{const{run:{[await 0]:x}}={get run(){new Socket("wss://example.test/nested-getter");return {}}}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "does not credit a destructuring default wait before getter entry",
    '(async()=>{const{run:x=await 0}={get run(){new Socket("wss://example.test/default-getter")}}})();const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "retains a getter after its own key wait even with a nested binding",
    '(async()=>{const{[void await 0]:{x}}={get undefined(){new Socket("wss://example.test/key-before-getter");return {}}}})();const Socket=globalThis.WebSocket;',
    ["wss://example.test/key-before-getter"],
  ],
  [
    "retains outer waits when resolve is only used after the socket read",
    'const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/late-resolve");resolve()});await pending;const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "retains outer waits when reject is only used after the socket read",
    'const pending=new Promise(async(resolve,reject)=>{await 0;new Socket("wss://example.test/late-reject");reject()});await pending;const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "retains outer waits when the executor cannot settle its promise",
    'const pending=new Promise(async()=>{await 0;new Socket("wss://example.test/no-settlement")});await pending;const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "keeps an escaped early resolver conservative",
    'let release;const pending=new Promise(async resolve=>{release=resolve;await 0;new Socket("wss://example.test/escaped-resolve")});release();await pending;const Socket=globalThis.WebSocket;',
    ["wss://example.test/escaped-resolve"],
  ],
  [
    "does not confuse a shadowed resolver with the executor parameter",
    'const pending=new Promise(async resolve=>{(()=>{const resolve=()=>{};resolve()})();await 0;new Socket("wss://example.test/shadowed-resolve");resolve()});await pending;const Socket=globalThis.WebSocket;',
    [],
  ],
  [
    "keeps settlement through an ordinary executor arguments object unknown",
    'const pending=new Promise(async function(){arguments[0]();await 0;new Socket("wss://example.test/arguments-resolve")});await pending;const Socket=globalThis.WebSocket;',
    ["wss://example.test/arguments-resolve"],
  ],
  [
    "includes resolver exposure in a later parameter default",
    'const pending=new Promise(async(resolve,reject,unused=resolve())=>{await 0;new Socket("wss://example.test/parameter-resolve")});await pending;const Socket=globalThis.WebSocket;',
    ["wss://example.test/parameter-resolve"],
  ],
  [
    "keeps an earlier iteration settlement conservative",
    'const pending=new Promise(async resolve=>{for(let i=0;i<2;i++){await 0;new Socket("wss://example.test/repeated-resolve");resolve()}});await pending;const Socket=globalThis.WebSocket;',
    ["wss://example.test/repeated-resolve"],
  ],
] as const)("%s", (_name, source, expected) => {
  expect(endpoints(source)).toEqual(expected);
});

it.each([
  ["object key", "({resolve:0});"],
  ["member name", "({}).resolve;"],
  ["object method", "({resolve(){}});"],
  ["class method", "class K{resolve(){}}"],
  ["label", "resolve:for(;;){break resolve;}"],
  ["destructuring binding", "{const {resolve}= {resolve:0};}"],
  ["eval property", "({eval:0});"],
  ["arguments property", "({arguments:0});"],
] as const)(
  "does not treat a %s as a settlement reference",
  (_name, prefix) => {
    expect(
      endpoints(
        `export {};const pending=new Promise(async function(resolve){${prefix}await 0;new Socket("wss://example.test/property-name");resolve()});await pending;const Socket=globalThis.WebSocket;`,
      ),
    ).toEqual([]);
  },
);

it.each([
  ["shorthand value", "({resolve});"],
  ["computed key", "({[resolve]:0});"],
  ["member receiver", "resolve.name;"],
  ["call argument", "consume(resolve);"],
] as const)("keeps a real %s reference conservative", (_name, prefix) => {
  expect(
    endpoints(
      `export {};const pending=new Promise(async resolve=>{${prefix}await 0;new Socket("wss://example.test/real-reference");resolve()});await pending;const Socket=globalThis.WebSocket;`,
    ),
  ).toEqual(["wss://example.test/real-reference"]);
});
