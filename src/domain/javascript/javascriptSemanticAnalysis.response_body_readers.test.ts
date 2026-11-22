import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * Only `fetch` resolves to a `Response`, and only once its promise settles.
 * `http.request`/`http.get` return a `ClientRequest` and `new WebSocket` a
 * socket; neither exposes `json`/`text`/`arrayBuffer`, and an un-awaited
 * `fetch` returns a `Promise`. In every one of those the call throws at the call
 * site instead of reading a body, so it is not a response consumer.
 */
const consumersFor = (source: string) =>
  analyzeJavaScriptSemantics(source)
    .requestOperations.filter(({ kind }) => kind === "response-consumer")
    .map(({ method, endpoint, resolution }) => ({
      method,
      endpoint,
      resolution,
    }));

it.each([
  [
    "an un-awaited fetch",
    `async function f(){ const res = fetch("https://api.test/x"); return res.json(); }`,
  ],
  [
    "an http.get request",
    `import http from "node:http";
     function f(){ const req = http.get("https://api.test/x"); return req.json(); }`,
  ],
  [
    "an http.request request",
    `import http from "node:http";
     function f(){ const req = http.request("https://api.test/x"); return req.text(); }`,
  ],
  [
    "a WebSocket handshake",
    `function f(){ const ws = new WebSocket("wss://api.test/x"); return ws.json(); }`,
  ],
])("emits no response consumer for %s", (_name, source) => {
  expect(consumersFor(source)).toEqual([]);
});

it.each(["text", "arrayBuffer"] as const)(
  "keeps a replaced %s response reader uncertain",
  (method) => {
    const result = analyzeJavaScriptSemantics(`async function f(replacement) {
      const res = await fetch("https://api.test/x");
      res.${method} = replacement;
      return res.${method}();
    }`).requestOperations.filter(({ kind }) => kind === "response-consumer");
    expect(result).toMatchObject([
      { method, endpoint: null, resolution: "partial" },
    ]);
    expect(result[0]?.linkedRequestIds).toHaveLength(1);
  },
);

it.each([
  ["json", "json"],
  ["text", "text"],
  ["arrayBuffer", "arrayBuffer"],
] as const)("keeps the settled fetch body reader for %s", (_name, method) => {
  expect(
    consumersFor(
      `async function f(){ const res = await fetch("https://api.test/x"); return res.${method}(); }`,
    ),
  ).toEqual([
    {
      method,
      endpoint: "https://api.test/x",
      resolution: "complete",
    },
  ]);
});

it("keeps a settled fetch reader through a wrapper expression", () => {
  expect(
    consumersFor(
      `async function f(){ const res = await fetch("https://api.test/x"); return (res).json(); }`,
    ),
  ).toHaveLength(1);
});

it.each([
  ["computed method replacement", 'res["json"] = () => ({ fake: true });'],
  ["unknown computed replacement", "res[key] = replacement;"],
  ["alias replacement", "const alias = res; alias.json = replacement;"],
  ["object assignment", "Object.assign(res, { json: replacement });"],
  [
    "property definition",
    'Object.defineProperty(res, "json", { value: replacement });',
  ],
  ["method deletion", "delete res.json;"],
  ["receiver escape", "decorate(res);"],
  ["receiver prototype replacement", "res.__proto__.json = replacement;"],
  [
    "global response prototype replacement",
    "Response.prototype.json = replacement;",
  ],
  [
    "globalThis response prototype replacement",
    "globalThis.Response.prototype.json = replacement;",
  ],
  [
    "defined response prototype replacement",
    'Object.defineProperty(Response.prototype, "json", { value: replacement });',
  ],
  ["indirect global eval", '(0, eval)("Response.prototype.json = () => 1");'],
] as const)("keeps a response consumer uncertain after %s", (_name, effect) => {
  const result =
    analyzeJavaScriptSemantics(`async function f(flag, key, replacement) {
    const res = await fetch("https://api.test/x");
    ${effect}
    return res.json();
  }`).requestOperations.filter(({ kind }) => kind === "response-consumer");
  expect(result).toMatchObject([
    { method: "json", endpoint: null, resolution: "partial" },
  ]);
  expect(result[0]?.linkedRequestIds).toHaveLength(1);
});

it.each([
  ["an unrelated property", "res.text = replacement;", "return res.json();"],
  ["a callable property", "res.json.label = 1;", "return res.json();"],
  [
    "a later write",
    "",
    "const value = res.json(); res.json = replacement; return value;",
  ],
  [
    "an unrelated prototype method",
    "Response.prototype.text = replacement;",
    "return res.json();",
  ],
] as const)(
  "keeps a response consumer complete with %s",
  (_name, before, after) => {
    expect(
      consumersFor(`async function f(replacement) {
    const res = await fetch("https://api.test/x");
    ${before}
    ${after}
  }`),
    ).toEqual([
      {
        method: "json",
        endpoint: "https://api.test/x",
        resolution: "complete",
      },
    ]);
  },
);

it.each([
  {
    label: "bare constructor binding after capture",
    source:
      'const res = await fetch("https://api.test/x"); Response = class Replacement {}; res.json();',
    endpoint: "https://api.test/x",
    resolution: "complete",
  },
  {
    label: "computed constructor binding after capture",
    source:
      'const res = await fetch("https://api.test/x"); globalThis["Response"] = class Replacement {}; res.json();',
    endpoint: "https://api.test/x",
    resolution: "complete",
  },
  {
    label: "null constructor binding after capture",
    source:
      'const res = await fetch("https://api.test/x"); globalThis.Response = null; res.json();',
    endpoint: "https://api.test/x",
    resolution: "complete",
  },
  {
    label: "function constructor binding after capture",
    source:
      'const res = await fetch("https://api.test/x"); globalThis.Response = function Replacement() {}; res.json();',
    endpoint: "https://api.test/x",
    resolution: "complete",
  },
  {
    label: "arrow constructor binding after capture",
    source:
      'const res = await fetch("https://api.test/x"); globalThis.Response = () => {}; res.json();',
    endpoint: "https://api.test/x",
    resolution: "complete",
  },
  {
    label: "empty object constructor binding after capture",
    source:
      'const res = await fetch("https://api.test/x"); globalThis.Response = {}; res.json();',
    endpoint: "https://api.test/x",
    resolution: "complete",
  },
  {
    label: "class static initialization may expose the original",
    source:
      'const res = await fetch("https://api.test/x"); globalThis.Response = class Replacement { static { mutate(globalThis.Response); } }; res.json();',
    endpoint: null,
    resolution: "partial",
  },
  {
    label: "class superclass evaluation may expose the original",
    source:
      'const res = await fetch("https://api.test/x"); globalThis.Response = class Replacement extends mutate(globalThis.Response) {}; res.json();',
    endpoint: null,
    resolution: "partial",
  },
  {
    label: "constructor binding before capture",
    source:
      'globalThis.Response = class Replacement {}; const res = await fetch("https://api.test/x"); res.json();',
    endpoint: null,
    resolution: "partial",
  },
  {
    label: "captured old prototype is modified",
    source:
      'const old = globalThis.Response; const res = await fetch("https://api.test/x"); globalThis.Response = class Replacement {}; old.prototype.json = () => 1; res.json();',
    endpoint: null,
    resolution: "partial",
  },
  {
    label: "original prototype escapes before rebinding",
    source:
      'const res = await fetch("https://api.test/x"); mutate(globalThis.Response.prototype); globalThis.Response = class Replacement {}; res.json();',
    endpoint: null,
    resolution: "partial",
  },
  {
    label: "original constructor escapes",
    source:
      'const res = await fetch("https://api.test/x"); mutate(globalThis.Response); globalThis.Response = class Replacement {}; res.json();',
    endpoint: null,
    resolution: "partial",
  },
  {
    label: "global setter installed after capture",
    source:
      'const old = globalThis.Response; const res = await fetch("https://api.test/x"); Object.defineProperty(globalThis, "Response", { set(value) { old.prototype.json = () => 1; } }); globalThis.Response = class Replacement {}; res.json();',
    endpoint: null,
    resolution: "partial",
  },
  {
    label: "constructor write through an alias",
    source:
      'const globalAlias = globalThis; const res = await fetch("https://api.test/x"); globalAlias.Response = class Replacement {}; res.json();',
    endpoint: null,
    resolution: "partial",
  },
  {
    label: "global setter installed before capture",
    source:
      'const old = globalThis.Response; Object.defineProperty(globalThis, "Response", { set(value) { old.prototype.json = () => 1; } }); const res = await fetch("https://api.test/x"); globalThis.Response = class Replacement {}; res.json();',
    endpoint: null,
    resolution: "partial",
  },
  {
    label: "replacement sequence mutates the captured prototype",
    source:
      'const old = globalThis.Response; const res = await fetch("https://api.test/x"); globalThis.Response = (old.prototype.json = () => 1, class Replacement {}); res.json();',
    endpoint: null,
    resolution: "partial",
  },
  {
    label: "replacement evaluation may mutate the original",
    source:
      'const res = await fetch("https://api.test/x"); globalThis.Response = mutate(globalThis.Response); res.json();',
    endpoint: null,
    resolution: "partial",
  },
] as const)(
  "tracks captured Response identity for $label",
  ({ source, endpoint, resolution }) => {
    expect(consumersFor(source)).toEqual([
      { method: "json", endpoint, resolution },
    ]);
  },
);

it("keeps a response consumer before a later global eval", () => {
  expect(
    consumersFor(`const res = await fetch("https://api.test/x");
    res.json();
    (0, eval)("Response.prototype.json = () => 1");`),
  ).toEqual([
    { method: "json", endpoint: "https://api.test/x", resolution: "complete" },
  ]);
});

it("does not attribute an old receiver's method write to a later fetch", () => {
  expect(
    consumersFor(`async function f(res) {
    res.json = () => 0;
    res = await fetch("https://api.test/new");
    return res.json();
  }`),
  ).toEqual([
    {
      method: "json",
      endpoint: "https://api.test/new",
      resolution: "complete",
    },
  ]);
});

it("does not attribute a captured old receiver's later write to a new fetch", () => {
  expect(
    consumersFor(`async function f(res) {
    const old = res;
    res = await fetch("https://api.test/new");
    old.json = () => 0;
    return res.json();
  }`),
  ).toEqual([
    {
      method: "json",
      endpoint: "https://api.test/new",
      resolution: "complete",
    },
  ]);
});

it.each([
  [
    "new receiver write",
    'res = await fetch("https://api.test/new"); res.json = () => 0;',
  ],
  [
    "old receiver prototype write",
    'res.__proto__.json = () => 0; res = await fetch("https://api.test/new");',
  ],
] as const)("retains uncertainty after %s", (_name, effect) => {
  expect(
    consumersFor(`async function f(res, flag) {
    ${effect}
    return res.json();
  }`),
  ).toEqual([{ method: "json", endpoint: null, resolution: "partial" }]);
});

it("does not retain an endpoint when the fetch assignment is conditional", () => {
  const [consumer] = consumersFor(`async function f(res, flag) {
    if (flag) res = await fetch("https://api.test/new");
    return res.json();
  }`);
  expect(consumer?.endpoint).toBeNull();
});

it("retains uncertainty across repeated response readers in a function", () => {
  const consumers = consumersFor(`async function f() {
    const res = await fetch("https://api.test/new");
    await res.text();
    await res.json();
  }`);
  // A later reader can reach mutable stream hooks and a shared prototype in
  // another activation; the call is not proof of a side-effect-free method.
  expect(consumers[0]).toEqual({
    method: "text",
    endpoint: null,
    resolution: "partial",
  });
});

it("keeps the fetch candidate when the binding also holds another request", () => {
  // The mixed binding keeps its fetch link, so the consumer stays a candidate
  // rather than losing the endpoint entirely.
  const consumers = consumersFor(`
    import http from "node:http";
    async function f(){
      let res = await fetch("https://api.test/x");
      res = await http.get("http://api.test/y");
      return res.json();
    }
  `);
  expect(consumers).toEqual([
    { method: "json", endpoint: null, resolution: "partial" },
  ]);
});
