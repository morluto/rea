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

it("keeps the request when the URL constructor is replaced", () => {
  // `new URL()` is not a URL target once `URL` is not the global, so slot 0 is the callback
  // and the second object is never read. Measured on Node 24.22.1.
  const operations = analyzeJavaScriptSemantics(
    `import http from "node:http";\nconst URL = Function;\nfunction f() { http.request(new URL(), { path: "/a b" }); }`,
  ).requestOperations;
  expect(operations).toHaveLength(1);
});

it("still reads slot 1 for the genuine URL constructor", () => {
  expect(
    requestsFor(`http.request(new URL("http://h/"), { path: "/a b" })`),
  ).toEqual([]);
});

it.each([
  // `Object.assign` runs an earlier getter before it copies `path`, so the getter's write is
  // the value Node validates. Measured on Node 24.22.1.
  [
    `http.request({ get agent() { this.path = "/ok"; return undefined; }, path: "/a b" })`,
  ],
] as const)(
  "keeps the request when a getter rewrites the path first: %s",
  (call) => {
    expect(requestsFor(call)).toHaveLength(1);
  },
);

it("emits no request when the getter enumerates after the path", () => {
  // The invalid value was already copied, so the getter cannot rescue it.
  expect(
    requestsFor(
      `http.request({ path: "/a b", get agent() { this.path = "/ok"; } })`,
    ),
  ).toEqual([]);
});

it.each([
  // An object-literal spread contributes its own data keys, so no getter runs and the invalid
  // path is what Node copies. Measured on Node 24.22.1.
  [`http.request({ ...{ host: "h" }, path: "/a b" })`],
  [`http.request({ ...{ path: "/a b" }, host: "h" })`],
  [`http.request({ ...{}, path: "/a b" })`],
] as const)(
  "emits no request through a statically inert spread: %s",
  (call) => {
    expect(requestsFor(call)).toEqual([]);
  },
);

it.each([
  // A getter inside the spread still runs during the copy.
  [`http.request({ ...{ get x() {} }, path: "/a b" })`],
  [`http.request({ get x() { this.path = "/ok"; }, path: "/a b" })`],
] as const)(
  "keeps the request when a getter may rewrite the path: %s",
  (call) => {
    expect(requestsFor(call)).toHaveLength(1);
  },
);

it("keeps the position a spread gave a redefined key", () => {
  // `agent` keeps the position the spread gave it, so the getter that redefines it still runs
  // before `path` is copied and rewrites the value. Measured on Node 24.22.1.
  expect(
    requestsFor(
      `http.request({ ...{ agent: null, path: "/a b" }, get agent() { this.path = "/ok"; return false; } })`,
    ),
  ).toHaveLength(1);
});

it("keeps the getter when a setter for the same key follows", () => {
  // An object literal merges `get x` and `set x` into one accessor descriptor, so the later
  // `set` does not remove the getter. Measured on Node 24.22.1.
  expect(
    requestsFor(
      `http.request({ get agent() { this.path = "/ok"; }, path: "/a b", set agent(_) {} })`,
    ),
  ).toHaveLength(1);
});

it.each([
  // A data entry replaces the descriptor, so the key is no longer a getter. Measured on Node
  // 24.22.1.
  [
    `http.request({ get agent() { this.path = "/ok"; }, path: "/a b", agent: null })`,
  ],
] as const)(
  "emits no request when a data property clears the getter: %s",
  (call) => {
    expect(requestsFor(call)).toEqual([]);
  },
);

it.each([
  // A setter merges with the getter instead of replacing it.
  [
    `http.request({ get agent() { this.path = "/ok"; }, path: "/a b", set agent(_) {} })`,
  ],
  [
    `http.request({ set agent(_) {}, get agent() { this.path = "/ok"; }, path: "/a b" })`,
  ],
] as const)("keeps the request when a setter joins the getter: %s", (call) => {
  expect(requestsFor(call)).toHaveLength(1);
});
