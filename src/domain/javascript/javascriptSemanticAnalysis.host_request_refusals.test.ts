import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `fetch` and `new WebSocket` validate their arguments while the Request or the
 * socket object is constructed, before anything is sent. Node's undici follows
 * the Fetch and WebSockets standards that browsers implement.
 *
 * Measured on Node 24.22.1:
 *
 *   fetch("http://user@host/x") / "http://:pw@host/x"      -> TypeError
 *   fetch(url, { method: "G ET" | "" | "CONNECT" | "Track" }) -> TypeError
 *   fetch(url, { body: "x" }) / { method: "get", body: "" } -> TypeError
 *   fetch(url, { method: "head", body: 0 })                 -> TypeError
 *   fetch(url, { headers: { "a b": "1" } }) / "" / "x-é"     -> TypeError
 *   fetch(url, { method: "PATCH" | "M-SEARCH" })            -> sent
 *   fetch(url, { method: "GET", body: null | undefined })   -> sent
 *   fetch("http://:@host/x")                                -> sent
 *   new WebSocket("ws://host/x#a") / "ws://host/x#" / "/s#a" -> SyntaxError
 *   new WebSocket("ftp://host/x") / "file:///x" / "mailto:x" -> SyntaxError
 *   new WebSocket(url, "a b" | "" | "a/b" | ["a", "a"])     -> SyntaxError
 *   new WebSocket("http://host/x") / "WSS://host/x"         -> socket
 *   new WebSocket(url, null | 5 | ["a", null] | [])         -> socket
 */
const requestsFor = (call: string) =>
  analyzeJavaScriptSemantics(`function g(url, init, list) { ${call}; }`)
    .requestOperations.filter(({ kind }) => kind === "request")
    .map(({ method }) => method);

it.each([
  ["a URL with a user name", 'fetch("https://user@api.example.test/x")'],
  ["a URL with a password", 'fetch("https://:pw@api.example.test/x")'],
  ["a method that is not a token", 'fetch(url, { method: "G ET" })'],
  ["an empty method", 'fetch(url, { method: "" })'],
  ["the CONNECT method", 'fetch(url, { method: "CONNECT" })'],
  ["a lowercase TRACE method", 'fetch(url, { method: "trace" })'],
  ["a mixed-case TRACK method", 'fetch(url, { method: "Track" })'],
  [
    "a body with the default GET method",
    'fetch("https://api.example.test/x", { body: "x" })',
  ],
  ["an empty body with GET", 'fetch(url, { method: "get", body: "" })'],
  ["a body with HEAD", 'fetch(url, { method: "head", body: 0 })'],
  ["an object body with GET", 'fetch(url, { method: "GET", body: {} })'],
  ["a header name with a space", 'fetch(url, { headers: { "a b": "1" } })'],
  ["an empty header name", 'fetch(url, { headers: { "": "1" } })'],
  ["a non-ASCII header name", 'fetch(url, { headers: { "x-é": "1" } })'],
  [
    "a WebSocket URL with a fragment",
    'new WebSocket("wss://chat.example.test/ws#a")',
  ],
  [
    "a WebSocket URL with an empty fragment",
    'new WebSocket("wss://chat.example.test/ws#")',
  ],
  ["a relative WebSocket URL with a fragment", 'new WebSocket("/ws#a")'],
  ["an ftp WebSocket URL", 'new WebSocket("ftp://chat.example.test/ws")'],
  ["a file WebSocket URL", 'new WebSocket("file:///ws")'],
  ["a subprotocol with a space", 'new WebSocket(url, "a b")'],
  ["an empty subprotocol", 'new WebSocket(url, "")'],
  ["a subprotocol with a slash", 'new WebSocket(url, "chat/v1")'],
  ["a repeated subprotocol", 'new WebSocket(url, ["chat", "chat"])'],
  [
    "an invalid subprotocol beside an unknown one",
    'new WebSocket(url, [list, "a b"])',
  ],
] as const)("emits no request for %s", (_name, call) => {
  expect(requestsFor(call)).toEqual([]);
});

it.each([
  ["a plain fetch", 'fetch("https://api.example.test/x")', "fetch"],
  ["an extension method", 'fetch(url, { method: "M-SEARCH" })', "fetch"],
  ["a lowercase PATCH method", 'fetch(url, { method: "patch" })', "fetch"],
  ["a POST body", 'fetch(url, { method: "POST", body: "x" })', "fetch"],
  [
    "a null body with GET",
    'fetch(url, { method: "GET", body: null })',
    "fetch",
  ],
  [
    "an undefined body with GET",
    'fetch(url, { method: "GET", body: undefined })',
    "fetch",
  ],
  ["a body beside a Request input", 'fetch(init, { body: "x" })', "fetch"],
  ["a computed method", "fetch(url, { method: init })", "fetch"],
  ["a token header name", 'fetch(url, { headers: { "x-ok": "1" } })', "fetch"],
  ["empty credentials", 'fetch("http://:@api.example.test/x")', "fetch"],
  ["a relative fetch URL", 'fetch("/api/items")', "fetch"],
  ["a ws URL", 'new WebSocket("wss://chat.example.test/ws")', "WebSocket"],
  [
    "an http WebSocket URL",
    'new WebSocket("https://chat.example.test/ws")',
    "WebSocket",
  ],
  [
    "an uppercase scheme",
    'new WebSocket("WSS://chat.example.test/ws")',
    "WebSocket",
  ],
  ["a relative WebSocket URL", 'new WebSocket("/ws")', "WebSocket"],
  ["a token subprotocol", 'new WebSocket(url, "chat.v1")', "WebSocket"],
  ["a null subprotocol", "new WebSocket(url, null)", "WebSocket"],
  ["distinct subprotocols", 'new WebSocket(url, ["a", "b"])', "WebSocket"],
  ["an unknown subprotocol list", "new WebSocket(url, list)", "WebSocket"],
] as const)("keeps the request for %s", (_name, call, method) => {
  expect(requestsFor(call)).toEqual([method]);
});
