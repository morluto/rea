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
  ["direct method replacement", "res.json = () => ({ fake: true });"],
  ["conditional replacement", "if (flag) res.json = () => ({ fake: true });"],
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

it("keeps a response consumer before a later global eval", () => {
  expect(
    consumersFor(`const res = await fetch("https://api.test/x");
    res.json();
    (0, eval)("Response.prototype.json = () => 1");`),
  ).toEqual([
    { method: "json", endpoint: "https://api.test/x", resolution: "complete" },
  ]);
});

it("keeps the fetch candidate when the binding also holds another request", () => {
  // The mixed binding keeps its fetch link, so the consumer stays a candidate
  // rather than losing the endpoint entirely.
  const consumers = consumersFor(`
    import http from "node:http";
    async function f(){
      let res = await fetch("https://api.test/x");
      res = await http.get("https://api.test/y");
      return res.json();
    }
  `);
  expect(consumers).toEqual([
    { method: "json", endpoint: null, resolution: "partial" },
  ]);
});
