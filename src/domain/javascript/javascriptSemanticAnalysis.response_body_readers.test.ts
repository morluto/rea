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
