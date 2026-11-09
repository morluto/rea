import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `http.request` and `https.request` validate `options.path` before they build the request,
 * so a literal carrying an unescaped character throws `ERR_UNESCAPED_CHARACTERS` from the
 * call itself and no request exists.
 *
 * Measured on Node 24.22.1 by putting every ASCII code point inside a literal path: exactly
 * `0x00`-`0x20` are refused and `0x21`-`0x7f` are accepted, so the rule is a closed range
 * rather than a list of known-bad characters. A space is in it — `"/a b"` throws while
 * `"/a%20b"` connects — and non-ASCII is accepted, so `"/aéb"` connects. An empty path is
 * accepted because Node reads `""` as "not given" and falls back to `/`.
 */
const requestsFor = (body: string) =>
  analyzeJavaScriptSemantics(
    `import http from "node:http";\nimport https from "node:https";\nfunction f() { ${body}; }`,
  ).requestOperations;

it.each([
  [`http.request({ host: "h", path: "/a b" })`],
  [`http.request({ host: "h", path: " " })`],
  [`http.request({ host: "h", path: "\\u0000" })`],
  [`http.request({ host: "h", path: "\\t" })`],
  [`http.request({ host: "h", path: "\\n" })`],
  [`https.request({ host: "h", path: "/a b" })`],
  [`http.request("http://h/", { path: "/a b" })`],
] as const)("emits no request for an unescaped path: %s", (call) => {
  expect(requestsFor(call)).toEqual([]);
});

it.each([
  [`http.request({ host: "h", path: "/ok" })`],
  // Node reads an empty path as "not given" and falls back to `/`.
  [`http.request({ host: "h", path: "" })`],
  // An escaped space is what the refused literal should have been.
  [`http.request({ host: "h", path: "/a%20b" })`],
  // Non-ASCII is inside the accepted range.
  [`http.request({ host: "h", path: "/aéb" })`],
  [`http.request({ host: "h" })`],
  // `fetch` reads a different member and validates no path.
  [`fetch("http://h/", { path: "/a b" })`],
  // A binding is not a literal, so this file leaves the answer to the runtime.
  [`const p = "/a b"; http.request({ host: "h", path: p })`],
] as const)("keeps the request for an accepted path: %s", (call) => {
  expect(requestsFor(call)).toHaveLength(1);
});
