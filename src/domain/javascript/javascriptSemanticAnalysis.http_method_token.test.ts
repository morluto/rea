import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `http`/`https` validate `options.method` with `checkIsHttpToken` before the request exists, so a
 * literal outside the RFC 9110 token class throws `ERR_INVALID_HTTP_TOKEN` and no request is
 * created.
 *
 * Measured on Node 24.22.1:
 *
 * | call | outcome |
 * | --- | --- |
 * | `{method: "BAD METHOD"}` | THREW `ERR_INVALID_HTTP_TOKEN` |
 * | `{method: "GET"}`, `{method: ""}`, `{method: "POST"}` | request constructed |
 * | `http.request("http://h/", {method: "BAD METHOD"})` | THREW |
 * | `http.request(() => {}, {method: "BAD METHOD"})` | request constructed — slot 1 unread |
 * | `https.request(null, {method: "BAD METHOD"})` | request constructed — default options kept |
 * | `{get x() { this.method = "GET"; }, method: "BAD METHOD"}` | request constructed |
 */
const requestsFor = (body: string) =>
  analyzeJavaScriptSemantics(
    `import http from "node:http";\nimport https from "node:https";\nfunction f() { ${body}; }`,
  ).requestOperations;

it.each([
  [`http.request({ method: "BAD METHOD" })`],
  [`http.request({ method: "BAD METHOD" }, {})`],
  [`http.request("http://h/", { method: "BAD METHOD" })`],
  [`http.request(new URL("http://h/"), { method: "BAD METHOD" })`],
  [`https.request({ method: "BAD METHOD" })`],
] as const)(
  "emits no request for a method literal Node refuses: %s",
  (call) => {
    expect(requestsFor(call)).toEqual([]);
  },
);

it.each([
  [`http.request({ method: "GET" })`],
  [`http.request({ method: "POST" })`],
  // An empty string is a valid token and Node falls back to a GET.
  [`http.request({ method: "" })`],
  // `_` and `-` are RFC 9110 `tchar`s; a hand-written class is most likely to drop these.
  [`http.request({ method: "M_SEARCH" })`],
  [`http.request({ method: "_" })`],
  [`http.request({ method: "M-SEARCH" })`],
  [`http.request("http://h/", { method: "GET" })`],
  // A replaced `URL` does not prove the `(url, options)` overload.
  [`const URL = Function; http.request(new URL(), { method: "BAD METHOD" })`],
] as const)("keeps the request for an accepted method: %s", (call) => {
  expect(requestsFor(call)).toHaveLength(1);
});

it.each([
  // A callable in slot 0 is the callback, so slot 1 is never read.
  [`http.request(() => {}, { method: "BAD METHOD" })`],
  // `https` keeps its default options for a falsy input.
  [`https.request(null, { method: "BAD METHOD" })`],
  // `Object.assign` may not copy the syntactic value, so the answer stays undecided.
  [`http.request({ get x() { this.method = "GET"; }, method: "BAD METHOD" })`],
  [`http.request({ method: "BAD METHOD", get x() { this.method = "GET"; } })`],
  // A spread may replace the member.
  [`http.request({ ...{ host: "h" }, method: "BAD METHOD" })`],
] as const)(
  "keeps the request when the copied value is undecided: %s",
  (call) => {
    expect(requestsFor(call)).toHaveLength(1);
  },
);
