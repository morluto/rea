import { expect, it, vi } from "vitest";
import { createWebPageInspection } from "../../tests/support/browser/webPageInspection.js";
import * as javascriptSemanticTraversal from "./javascript/javascriptSemanticTraversal.js";
import { analyzeWebBundleFixture } from "../../tests/support/browser/analyzeWebBundleFixture.js";
import { jsonValueByteLength } from "./jsonValueByteLength.js";
import type { JsonValue } from "./jsonValue.js";
import {
  DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  WEB_BUNDLE_ENDPOINT_LITERAL_CODE,
  WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
  retainLiteralCandidatesWithinResultBudget,
  webBundleEndpointLiteralLimit,
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
    omitted_by_count: 1,
    omitted_by_count_exact: false,
    omitted_by_result_budget: 0,
    omitted_count: 1,
    maximum_count: 2,
    source: "setting",
    default_count: DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    floor_count: MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    maximum_setting_count: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    update_mode: "runtime",
    pending_restart: false,
    ceiling: "adjustable",
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
    omitted_by_count: 1,
    omitted_by_result_budget: 0,
    omitted_count: 1,
    maximum_count: 1,
    source: "runtime",
    update_mode: "runtime",
    pending_restart: false,
    ceiling: "adjustable",
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

it("omits a literal whose serialized record exceeds the remaining result budget", () => {
  const huge = `/${"a".repeat(50_000)}`;
  const source = `const routes = ${JSON.stringify([huge, "/api/small"])};
fetch("/api/kept");`;
  const result = analyzeWebBundleFixture(
    createWebPageInspection([
      {
        source,
        scriptKey: `scr_${"b".repeat(64)}`,
        url: "https://app.example.test/app.js",
        origin: "https://app.example.test",
        cdpHash: "hash",
      },
    ]),
    undefined,
    { maximumCount: 16, source: "runtime" },
    8_000,
  );
  const values = result.inferences
    .filter(({ kind }) => kind === "endpoint_candidate")
    .map(({ value }) => value);
  expect(values).not.toContain(huge);
  expect(values).toContain("/api/small");
  expect(result.observations.endpoints.map(({ value }) => value)).toEqual([
    "/api/kept",
  ]);
  expect(result.endpoint_literal_candidates).toMatchObject({
    code: WEB_BUNDLE_ENDPOINT_LITERAL_CODE,
    admitted_count: 1,
    omitted_by_count: 0,
    omitted_by_result_budget: 1,
    omitted_count: 1,
    maximum_count: 16,
    update_mode: "runtime",
    pending_restart: false,
    ceiling: "adjustable",
  });
  expect(result.completeness.status).toBe("partial");
});

it("marks the candidate ceiling maximal when it is already at the setting maximum", () => {
  const maximal = webBundleEndpointLiteralLimit(
    {
      maximumCount: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
      source: "setting",
    },
    MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    1,
  );
  const adjustable = webBundleEndpointLiteralLimit(
    { maximumCount: 2, source: "runtime" },
    2,
    1,
  );
  expect(maximal).toMatchObject({
    maximum_count: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    maximum_setting_count: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    admitted_count: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    omitted_by_count: 1,
    omitted_by_result_budget: 0,
    omitted_count: 1,
    ceiling: "maximal",
    update_mode: "runtime",
    pending_restart: false,
  });
  expect(adjustable).toMatchObject({
    maximum_count: 2,
    omitted_by_count: 1,
    omitted_by_result_budget: 0,
    omitted_count: 1,
    ceiling: "adjustable",
    pending_restart: false,
  });
});

it("does not treat a proven Map.has key or an unbound open as a candidate", () => {
  const proven = analyze(`const settings = new Map();
settings.has("/api/map");
settings.get("/api/get");
wrap("/api/kept");`);
  expect(
    proven.inferences
      .filter(({ kind }) => kind === "endpoint_candidate")
      .map(({ value }) => value),
  ).toEqual(["/api/kept"]);
  const globalOpen = analyze(`open("/help");
open?.("/help-optional");
wrap("/api/kept");`);
  expect(
    globalOpen.inferences
      .filter(({ kind }) => kind === "endpoint_candidate")
      .map(({ value }) => value),
  ).toEqual(["/api/kept"]);
  const localOpen = analyze(`function open(path) { return path; }
open("/api/local-open");`);
  expect(
    localOpen.inferences
      .filter(({ kind }) => kind === "endpoint_candidate")
      .map(({ value }) => value),
  ).toEqual(["/api/local-open"]);
});

it("admits an earlier callee literal before a later call argument", () => {
  const result = analyzeWebBundleFixture(
    createWebPageInspection([
      {
        source: `(wrap("/api/first"), handler)("/api/later");`,
        scriptKey: `scr_${"c".repeat(64)}`,
        url: "https://app.example.test/app.js",
        origin: "https://app.example.test",
        cdpHash: "hash",
      },
    ]),
    undefined,
    { maximumCount: 1, source: "setting" },
  );
  expect(
    result.inferences
      .filter(({ kind }) => kind === "endpoint_candidate")
      .map(({ value }) => value),
  ).toEqual(["/api/first"]);
});

it("counts admitted literals from scripts that stayed under the ceiling", () => {
  const script = (
    source: string,
    key: string,
  ): Parameters<typeof createWebPageInspection>[0][number] => ({
    source,
    scriptKey: `scr_${key}`,
    url: "https://app.example.test/app.js",
    origin: "https://app.example.test",
    cdpHash: "hash",
  });
  const result = analyzeWebBundleFixture(
    createWebPageInspection([
      script(`const routes = ["/api/one"];`, "a".repeat(64)),
      script(`const routes = ["/api/two", "/api/three"];`, "b".repeat(64)),
    ]),
    undefined,
    { maximumCount: 1, source: "setting" },
  );
  expect(
    result.inferences
      .filter(({ kind }) => kind === "endpoint_candidate")
      .map(({ value }) => value),
  ).toEqual(["/api/one", "/api/two"]);
  expect(result.endpoint_literal_candidates).toMatchObject({
    admitted_count: 2,
    omitted_by_count: 1,
    omitted_by_result_budget: 0,
    omitted_count: 1,
  });
});

it("fits literals by cumulative bytes and keeps byte drops out of the count", () => {
  const stable = { status: "analyzed", script_key: "s" };
  const admission = { maximumCount: 8, source: "runtime" as const };
  const literal = (value: string) => ({
    kind: "endpoint_candidate" as const,
    value,
    confidence: "low" as const,
    basis: [
      {
        detector: "literal:path-shaped",
        script_key: "s",
        artifact_sha256: "aa",
        line: 1,
        column: 0,
      },
    ],
  });
  const other = (value: string) => ({
    kind: "vendor_fingerprint" as const,
    value,
    confidence: "low" as const,
    basis: [
      {
        detector: "vendor",
        script_key: "s",
        artifact_sha256: "aa",
        line: 1,
        column: 0,
      },
    ],
  });
  for (const [budget, records, omittedByCount] of [
    [4_000, [literal("/a"), literal(`/${"b".repeat(3_000)}`)], 0],
    [4_000, [literal("/a"), other("x".repeat(3_500))], 0],
    [4_000, [literal("/a"), literal("/b")], 1],
  ] as const) {
    const fitted = retainLiteralCandidatesWithinResultBudget(
      stable,
      records,
      admission,
      omittedByCount,
      true,
      budget,
    );
    const limit = webBundleEndpointLiteralLimit(
      admission,
      fitted.admittedCount,
      fitted.omittedByCount,
      fitted.omittedByResultBudget,
      fitted.omittedByCountExact,
    );
    const serialized = {
      ...stable,
      inferences: fitted.inferences,
      ...(limit === undefined ? {} : { endpoint_literal_candidates: limit }),
    };
    const literals = records.filter(
      (record) => record.kind === "endpoint_candidate",
    );
    expect(fitted.omittedByCount).toBe(omittedByCount);
    expect(fitted.omittedByResultBudget).toBe(
      literals.length - fitted.admittedCount,
    );
    expect(
      fitted.inferences
        .filter((record) => record.kind !== "endpoint_candidate")
        .map((record) => record.value),
    ).toEqual(
      records
        .filter((record) => record.kind !== "endpoint_candidate")
        .map((record) => record.value),
    );
    const withinBudget =
      jsonValueByteLength(serialized as unknown as JsonValue) <= budget;
    const mandatoryOverflow =
      fitted.admittedCount === 0 &&
      records.some((record) => record.kind !== "endpoint_candidate");
    expect(withinBudget || mandatoryOverflow).toBe(true);
    if (fitted.omittedByResultBudget > 0 && omittedByCount === 0)
      expect(limit?.omitted_by_count).toBe(0);
  }
});
