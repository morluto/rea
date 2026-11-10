import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * `http.request` and `https.request` validate `options.path` before they build the
 * request, so a literal carrying a refused character throws `ERR_UNESCAPED_CHARACTERS` from
 * the call itself and no request exists.
 *
 * Measured on Node 24.22.1, the accepted range is exactly `U+0021`-`U+00FF`: every ASCII
 * code point was enumerated inside a literal path and `0x00`-`0x20` are refused, and probing
 * the upper bound refuses `U+0100` onward while `U+007f`, `U+00a0`, `U+00e9` and `U+00ff`
 * are accepted. So the rule is a closed **Latin-1** range, not ASCII and not a list of
 * known-bad characters. A space is refused — `"/a b"` throws while `"/a%20b"` connects — and
 * so is anything above Latin-1, which is why `"/aĀb"` throws. An empty path is accepted
 * because Node reads `""` as "not given" and falls back to `/`.
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

it.each([["/aĀb"], ["/a中b"], ["/a😀b"], ["/a\u2028b"]] as const)(
  "emits no request above Latin-1: %s",
  (path) => {
    // The accepted range ends at U+00FF; measured on Node 24.22.1, U+0100 and above throw
    // ERR_UNESCAPED_CHARACTERS.
    expect(
      requestsFor(`http.request({ host: "h", path: ${JSON.stringify(path)} })`),
    ).toEqual([]);
  },
);

it.each([["/a\u00ffb"], ["/a\u00a0b"], ["/a\u007fb"]] as const)(
  "keeps the request inside Latin-1: %s",
  (path) => {
    expect(
      requestsFor(`http.request({ host: "h", path: ${JSON.stringify(path)} })`),
    ).toHaveLength(1);
  },
);

it.each([
  // A spread after the options slot cannot move it, so the call still throws. Measured on
  // Node 24.22.1.
  [`const cbs = [() => {}]; http.request({ host: "h", path: "/a b" }, ...cbs)`],
  [
    `const cbs = [() => {}]; http.request("http://h/", { path: "/a b" }, ...cbs)`,
  ],
] as const)(
  "emits no request when a spread follows the options: %s",
  (call) => {
    expect(requestsFor(call)).toEqual([]);
  },
);

it("keeps the request when a spread precedes the options slot", () => {
  // Here the spread can supply the options itself, so the position is unresolved.
  const operations = analyzeJavaScriptSemantics(
    `import http from "node:http";\nfunction f() { const a = [{ host: "h" }]; http.request(...a, { path: "/a b" }); }`,
  ).requestOperations;
  expect(operations).toHaveLength(1);
});

it("keeps the request when a non-object first argument is the callback", () => {
  // `ClientRequest` reads the function as the callback and replaces options with defaults,
  // so the second object is never read. Measured on Node 24.22.1.
  const operations = analyzeJavaScriptSemantics(
    `import http from "node:http";\nfunction f() { http.request(() => {}, { path: "/a b" }); }`,
  ).requestOperations;
  expect(operations).toHaveLength(1);
});

it.each([
  [`http.request("/x", { path: "/a b" })`],
  [`http.request(new URL("http://h/"), { path: "/a b" })`],
] as const)("still reads slot 1 for a proven url target: %s", (call) => {
  expect(requestsFor(call)).toEqual([]);
});
