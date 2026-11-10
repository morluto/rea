import { expect, it, vi } from "vitest";
import { createWebPageInspection } from "../../tests/support/browser/webPageInspection.js";
import * as javascriptSemanticTraversal from "./javascript/javascriptSemanticTraversal.js";
import { analyzeWebBundleFixture } from "../../tests/support/browser/analyzeWebBundleFixture.js";
import {
  DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  WEB_BUNDLE_ENDPOINT_LITERAL_CODE,
  WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
} from "./webBundleEndpointLiteralBudget.js";

const analyze = (source: string) =>
  analyzeWebBundleFixture(
    createWebPageInspection([
      {
        source,
        scriptKey: `scr_${"1".repeat(64)}`,
        url: "https://app.example.test/app.js",
        origin: "https://app.example.test",
        cdpHash: "hash",
      },
    ]),
  );

it("retains wrapper, array and base URL literals as candidates, not requests", () => {
  const result = analyze(`async function apiPostWithRetry(path, body) {
  return fetch(BASE + path, { method: "POST", body: JSON.stringify(body) });
}
const BASE = "https://api.example.test";
const AUTH_ROUTES = ["/api/daily/stats", "/api/progress/complete", "/api/multiplayer/hint"];
function report() { return fetch("/api/feedback", { method: "POST" }); }
function complete(id, ms) { return apiPostWithRetry("/api/daily/complete", { puzzleId: id, completionTimeMs: ms }); }
const settings = new Map(); settings.get("dpl");
const http = { post: (u) => fetch(u) }; http.post("/api/verified-post");`);
  expect(result.completeness.parse_failures).toBe(0);
  expect(result.observations.endpoints.map(({ value }) => value)).toEqual([
    "/api/feedback",
  ]);
  const candidates = result.inferences.filter(
    ({ kind }) => kind === "endpoint_candidate",
  );
  expect(candidates.map(({ value }) => value).sort()).toEqual([
    "/api/daily/complete",
    "/api/daily/stats",
    "/api/multiplayer/hint",
    "/api/progress/complete",
    "/api/verified-post",
    "https://api.example.test",
  ]);
  expect(candidates).toContainEqual({
    kind: "endpoint_candidate",
    value: "https://api.example.test",
    confidence: "low",
    basis: [
      expect.objectContaining({
        script_key: `scr_${"1".repeat(64)}`,
        artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        detector: "literal:url-shaped",
        line: 4,
        column: 13,
      }),
    ],
  });
  expect(
    candidates.find(({ value }) => value === "/api/daily/complete"),
  ).toMatchObject({
    confidence: "low",
    basis: [
      expect.objectContaining({ detector: "literal:path-shaped", line: 7 }),
    ],
  });
});

it("deduplicates shape candidates per script and preserves sanitization", () => {
  const result = analyze(`const paths = ["/api/repeated", "/api/repeated"];
wrap("/api/repeated");
client?.call?.(\`/api/template\`);
wrap("https://user:pass@api.example.test/path?token=secret#fragment");
const SOCKET = "WSS://socket.example.test/events";`);
  const candidates = result.inferences.filter(
    ({ kind }) => kind === "endpoint_candidate",
  );
  expect(candidates.map(({ value }) => value)).toEqual([
    "/api/repeated",
    "/api/template",
    "https://api.example.test/path?token=secret#fragment",
    "WSS://socket.example.test/events",
  ]);
  expect(candidates[0]?.basis).toEqual([
    expect.objectContaining({
      line: 1,
      column: 15,
      detector: "literal:path-shaped",
    }),
  ]);
});

it("keeps the earlier nested literal coordinate", () => {
  const source = `const routes = [["/api/nested"], "/api/nested"];`;
  const result = analyze(source);
  const candidates = result.inferences.filter(
    ({ kind }) => kind === "endpoint_candidate",
  );
  const first = source.indexOf('"/api/nested"');
  const second = source.indexOf('"/api/nested"', first + 1);
  expect(candidates).toEqual([
    {
      kind: "endpoint_candidate",
      value: "/api/nested",
      confidence: "low",
      basis: [
        expect.objectContaining({
          detector: "literal:path-shaped",
          line: 1,
          column: first,
        }),
      ],
    },
  ]);
  expect(first).toBeLessThan(second);
  expect(result.completeness.status).toBe("complete");
  expect(result.endpoint_literal_candidates).toBeUndefined();
});

it("omits literal candidates past the effective ceiling and keeps observations", () => {
  const source = `const routes = ["/api/one", "/api/two", "/api/three"];
fetch("/api/kept");`;
  const result = analyzeWebBundleFixture(
    createWebPageInspection([
      {
        source,
        scriptKey: `scr_${"1".repeat(64)}`,
        url: "https://app.example.test/app.js",
        origin: "https://app.example.test",
        cdpHash: "hash",
      },
    ]),
    undefined,
    { maximumCount: 2, source: "setting" },
  );
  const candidates = result.inferences.filter(
    ({ kind }) => kind === "endpoint_candidate",
  );
  expect(candidates.map(({ value }) => value)).toEqual([
    "/api/one",
    "/api/two",
  ]);
  expect(result.observations.endpoints.map(({ value }) => value)).toEqual([
    "/api/kept",
  ]);
  expect(result.endpoint_literal_candidates).toEqual({
    coverage: "partial",
    code: WEB_BUNDLE_ENDPOINT_LITERAL_CODE,
    setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
    admitted_count: 2,
    omitted_count: 1,
    maximum_count: 2,
    source: "setting",
    default_count: DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    floor_count: MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    maximum_setting_count: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    rea_restart_required: false,
  });
  expect(result.completeness.status).toBe("partial");
  expect(result.unknowns).toContainEqual(
    expect.objectContaining({
      dimension: "endpoint_literal_candidates",
      affected_script_keys: [`scr_${"1".repeat(64)}`],
    }),
  );
});

it("records a runtime ceiling on the same structured limit", () => {
  const source = `const routes = ["/api/one", "/api/two"];`;
  const result = analyzeWebBundleFixture(
    createWebPageInspection([
      {
        source,
        scriptKey: `scr_${"2".repeat(64)}`,
        url: "https://app.example.test/app.js",
        origin: "https://app.example.test",
        cdpHash: "hash",
      },
    ]),
    undefined,
    { maximumCount: 1, source: "runtime" },
  );
  expect(result.endpoint_literal_candidates).toMatchObject({
    code: WEB_BUNDLE_ENDPOINT_LITERAL_CODE,
    setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
    admitted_count: 1,
    omitted_count: 1,
    maximum_count: 1,
    source: "runtime",
    rea_restart_required: false,
  });
});

it("does not turn arbitrary literals, computed strings or proven collection lookups into candidates", () => {
  const result = analyze(`const text = "/not-a-network-constant";
const docs = "file:///tmp/docs";
const invalid = "https://";
wrap("plain"); wrap("/"); wrap("//"); wrap("/?query"); wrap("/with space");
wrap("https://"); wrap("data:text/plain,hello");
wrap(id, "/second-argument"); wrap(\`/dynamic/\${id}\`);
const map = new Map(); map.get("/map-key"); new Map().delete("/other-key");
import "/module.js"; require("/required.js"); importScripts("/worker.js");
window.open("https://navigation.example.test");
const routes = ["ordinary", "/array-path", dynamic, \
  \`/dynamic/\${id}\`, "/", "https://", "ftp://example.test/data"];
const object = { "/property-key": "/property-value" };`);
  expect(
    result.inferences
      .filter(({ kind }) => kind === "endpoint_candidate")
      .map(({ value }) => value),
  ).toEqual(["/array-path"]);
  expect(result.observations.endpoints).toEqual([]);
});

it("snapshots ancestors only for URL-shaped variable initializers", () => {
  const ancestry = { inspectionNodes: 0, snapshots: 0 };
  const traverse = javascriptSemanticTraversal.traverseJavaScriptAst;
  const spy = vi
    .spyOn(javascriptSemanticTraversal, "traverseJavaScriptAst")
    .mockImplementation((root, visitor) => {
      const track = visitor.enter
        .toString()
        .includes("inspectEndpointLiterals");
      return traverse(root, {
        ...visitor,
        enter(node, parent, readAncestors) {
          if (track) ancestry.inspectionNodes += 1;
          visitor.enter(node, parent, () => {
            if (track) ancestry.snapshots += 1;
            return readAncestors();
          });
        },
      });
    });
  const source = `function noise(value) {
  const unused = { a: value, b: [1, 2, 3], c: value + 1 };
  return unused.a + unused.b.length;
}
const routes = [["/api/nested"], "/api/nested"];
const BASE = "https://api.example.test";
let other = "https://other.example.test";`;
  let result: ReturnType<typeof analyze>;
  try {
    result = analyze(source);
  } finally {
    spy.mockRestore();
  }
  const candidates = result.inferences.filter(
    ({ kind }) => kind === "endpoint_candidate",
  );
  const nestedAt = source.indexOf('"/api/nested"');
  const laterAt = source.indexOf('"/api/nested"', nestedAt + 1);
  const lineStart = source.lastIndexOf("\n", nestedAt - 1) + 1;
  expect(nestedAt).toBeLessThan(laterAt);
  expect(candidates.map(({ value }) => value)).toEqual([
    "/api/nested",
    "https://api.example.test",
  ]);
  expect(candidates[0]?.basis).toEqual([
    expect.objectContaining({
      detector: "literal:path-shaped",
      line: source.slice(0, nestedAt).split("\n").length,
      column: nestedAt - lineStart,
    }),
  ]);
  expect(candidates[1]?.basis).toEqual([
    expect.objectContaining({ detector: "literal:url-shaped" }),
  ]);
  expect(ancestry.inspectionNodes).toBeGreaterThan(ancestry.snapshots);
  expect(ancestry.snapshots).toBe(2);
});
