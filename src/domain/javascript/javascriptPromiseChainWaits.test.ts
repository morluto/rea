import { expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const sources = [
  'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending.finally(()=>{});',
  'const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/chain");resolve()});await pending.finally(()=>{});',
  'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();const tail=pending.finally(()=>{});await tail;',
  'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending.catch(()=>{}).finally(()=>{}).then(()=>{});',
  'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending["finally"](()=>{});',
  'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending.finally();',
  'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending.then(()=>{});',
  'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();await pending.catch(()=>{});',
  'const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/chain");resolve()});await pending.then(()=>{});',
  'const pending=new Promise(async resolve=>{await 0;new Socket("wss://example.test/chain");resolve()});await pending.catch(()=>{});',
  'const pending=(async()=>{await 0;new Socket("wss://example.test/chain")})();const tail=pending.then(()=>{});await tail.catch(()=>{});',
];

it.each([
  'const {WebSocket:Socket}=await import("ws").then(()=>({WebSocket:class{}}));',
  'const loaded=import("ws");const replacement=loaded.then(()=>({WebSocket:class{}}));const {WebSocket:Socket}=await replacement;',
  'const {WebSocket:Socket}=await import("ws").catch(()=>({WebSocket:class{}}));',
  'const {WebSocket:Socket}=await (async()=>await import("ws").then(()=>({WebSocket:class{}})))();',
])("does not treat a chain dependency as its fulfilled value: %s", (source) => {
  const result = analyzeJavaScriptStaticSource(
    `export {};${source}new Socket("wss://example.test/replaced-import");`,
  );
  expect(result.parse_status).not.toBe("failed");
  expect(result.endpoints).toEqual([]);
});

it("retains an unchanged fulfilled import value", () => {
  const result = analyzeJavaScriptStaticSource(
    'export {};const {WebSocket:Socket}=await import("ws");new Socket("wss://example.test/direct-import");',
  );
  expect(result.endpoints.map(({ value }) => value)).toEqual([
    "wss://example.test/direct-import",
  ]);
});

it.each(sources)("preserves chained native promise blocking: %s", (source) => {
  const result = analyzeJavaScriptStaticSource(
    `export {};${source}const Socket=globalThis.WebSocket;`,
  );
  expect(result.parse_status).not.toBe("failed");
  expect(result.endpoints).toEqual([]);
});

it.each(sources)("retains initialized chained producer: %s", (source) => {
  const result = analyzeJavaScriptStaticSource(
    `export {};const Socket=globalThis.WebSocket;${source}`,
  );
  expect(result.endpoints.map(({ value }) => value)).toEqual([
    "wss://example.test/chain",
  ]);
});

it("handles a 4,000-link native promise chain without losing its wait", () => {
  const chain = `pending${".then(()=>{})".repeat(4_000)}`;
  const result = analyzeJavaScriptStaticSource(
    `const {WebSocket:Socket}=await import("ws");const pending=(async()=>{await 0;new Socket("wss://example.test/deep-chain")})();await ${chain};`,
  );
  expect(result.parse_status).not.toBe("failed");
  expect(result.parse_error_count).toBe(0);
  expect(result.endpoints.map(({ value }) => value)).toEqual([
    "wss://example.test/deep-chain",
  ]);
}, 30_000);

it.each([
  ["pending.finally=()=>undefined;", "pending.finally()"],
  ["const alias=pending;alias.finally=()=>undefined;", "pending.finally()"],
  ["Promise.prototype.finally=()=>undefined;", "pending.finally()"],
  ["pending.then=()=>undefined;", "pending.finally()"],
  ["const alias=pending;alias.then=()=>undefined;", "pending.finally()"],
  ["Promise.prototype.then=()=>undefined;", "pending.finally()"],
  [
    "Object.setPrototypeOf(pending,{finally:()=>undefined});",
    "pending.finally()",
  ],
  [
    "class Fast extends Promise{constructor(executor){super(resolve=>{resolve();executor(()=>{},()=>{})})}}pending.constructor={[Symbol.species]:Fast};",
    "pending.finally()",
  ],
  ["pending.then=()=>undefined;", "pending.then()"],
  ["const alias=pending;alias.then=()=>undefined;", "pending.then()"],
  ["pending.catch=()=>undefined;", "pending.catch()"],
  ["Promise.prototype.then=()=>undefined;", "pending.then()"],
  ["Promise.prototype.catch=()=>undefined;", "pending.catch()"],
  ["Object.setPrototypeOf(pending,{then:()=>undefined});", "pending.then()"],
  [
    "function mutate(value){value.then=()=>undefined}mutate(pending);",
    "pending.then()",
  ],
  [
    "const tail=pending.then();tail.constructor=null;tail.then=resolve=>resolve();",
    "tail",
  ],
  [
    "class Fast extends Promise{constructor(executor){super(resolve=>{resolve();executor(()=>{},()=>{})})}}pending.constructor={[Symbol.species]:Fast};",
    "pending.then()",
  ],
  [
    "class Fast extends Promise{constructor(executor){super(resolve=>{resolve();executor(()=>{},()=>{})})}}Object.defineProperty(Promise,Symbol.species,{value:Fast});",
    "pending.then()",
  ],
  [
    "class Fast extends Promise{constructor(executor){super(resolve=>{resolve();executor(()=>{},()=>{})})}}Object.defineProperty(pending.constructor,Symbol.species,{value:Fast});",
    "pending.then()",
  ],
  ["Promise[Symbol.species].prototype.then=()=>undefined;", "pending.then()"],
] as const)("keeps changed chain identity unknown: %s", (change, wait) => {
  const source = `export {};let release;const ready=new Promise(resolve=>{release=resolve});const pending=(async()=>{await ready;new Socket("wss://example.test/changed-chain")})();${change}await ${wait};const Socket=globalThis.WebSocket;release();`;
  const result = analyzeJavaScriptStaticSource(source);
  expect(result.parse_status).not.toBe("failed");
  expect(result.endpoints.map(({ value }) => value)).toEqual([
    "wss://example.test/changed-chain",
  ]);
});
