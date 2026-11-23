import { expect, it, vi } from "vitest";
import { createWebPageInspection } from "../../tests/support/browser/webPageInspection.js";
import * as javascriptSemanticTraversal from "./javascript/javascriptSemanticTraversal.js";
import { analyzeWebBundleFixture } from "../../tests/support/browser/analyzeWebBundleFixture.js";
import { jsonValueByteLength } from "./jsonValueByteLength.js";
import type { JsonValue } from "./jsonValue.js";
import { analyzeCapturedWebScript } from "./webBundleAnalyzer.js";
import { isIncludedScript } from "./webBundleAnalyzerState.js";
import {
  MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
  MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
} from "./analysisResourceLimits.js";
import {
  WEB_BUNDLE_ENDPOINT_LITERAL_CODE,
  WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
  webBundleEndpointLiteralRecord,
  webBundleEndpointLiteralRecordMessage,
} from "./webBundleEndpointLiteralBudget.js";
import { fitWebBundleEndpointLiteralCandidates } from "./webBundleEndpointLiteralResultBudget.js";
import { isLiteralEndpointCandidate } from "./webBundleEndpointLiterals.js";

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

it("retains array and base URL literals as candidates, not requests", () => {
  const result = analyze(`function apiFetch(path) {
  return fetch(BASE + path, { method: "POST" });
}
const BASE = "https://api.example.test";
const AUTH_ROUTES = ["/api/daily/stats", "/api/progress/complete", "/api/multiplayer/hint"];
function report() { return fetch("/api/feedback", { method: "POST" }); }
const settings = new Map(); settings.get("dpl");`);
  expect(result.completeness.parse_failures).toBe(0);
  expect(result.observations.endpoints.map(({ value }) => value)).toEqual([
    "/api/feedback",
  ]);
  const candidates = result.inferences.filter(
    ({ kind }) => kind === "endpoint_candidate",
  );
  expect(candidates.map(({ value }) => value).sort()).toEqual([
    "/api/daily/stats",
    "/api/multiplayer/hint",
    "/api/progress/complete",
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
    candidates.find(({ value }) => value === "/api/daily/stats"),
  ).toMatchObject({
    confidence: "low",
    basis: [
      expect.objectContaining({ detector: "literal:path-shaped", line: 5 }),
    ],
  });
});

it("deduplicates shape candidates per script and preserves sanitization", () => {
  const result = analyze(`const paths = ["/api/repeated", "/api/repeated"];
const SOCKET = "WSS://socket.example.test/events";
const CREDENTIALS = "https://user:pass@api.example.test/path?token=secret#fragment";
const TEMPLATE = \`/api/template/\${id}\`;`);
  const candidates = result.inferences.filter(
    ({ kind }) => kind === "endpoint_candidate",
  );
  expect(candidates.map(({ value }) => value)).toEqual([
    "/api/repeated",
    "WSS://socket.example.test/events",
    "https://api.example.test/path?token=secret#fragment",
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
  expect(result.endpoint_literal_candidates).toMatchObject({
    coverage: "partial",
    code: WEB_BUNDLE_ENDPOINT_LITERAL_CODE,
    admitted_count: 2,
    omitted_by_count: 1,
    omitted_by_count_exact: false,
    omitted_by_result_budget: 0,
    omitted_count: 1,
    ceiling: "adjustable",
    limit: {
      setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
      effective_value: 2,
      source: "setting",
      unit: "count",
      minimum: MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
      maximum: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
      update_mode: "runtime",
      pending_restart: false,
    },
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
    admitted_count: 1,
    omitted_by_count: 1,
    omitted_by_result_budget: 0,
    omitted_count: 1,
    ceiling: "adjustable",
    limit: {
      setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
      effective_value: 1,
      source: "runtime",
      update_mode: "runtime",
      pending_restart: false,
    },
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
  const captured = createWebPageInspection([
    {
      source,
      scriptKey: `scr_${"b".repeat(64)}`,
      url: "https://app.example.test/app.js",
      origin: "https://app.example.test",
      cdpHash: "hash",
    },
  ]);
  const script = captured.scripts.items.find(isIncludedScript);
  if (script === undefined) throw new Error("Missing included script");
  const admission = { maximumCount: 16, source: "runtime" as const };
  // The worker fits the facet into the result budget it was given; the domain
  // analyzer keeps every candidate the count ceiling admitted.
  const full = analyzeCapturedWebScript(
    script,
    undefined,
    undefined,
    admission,
  );
  if (full.status !== "analyzed") throw new Error("Expected analyzed script");
  expect(full.inferences.some(({ value }) => value === huge)).toBe(true);
  const budget = 8_000;
  const fitted = fitWebBundleEndpointLiteralCandidates(full, budget, admission);
  const values = fitted.inferences
    .filter(({ kind }) => kind === "endpoint_candidate")
    .map(({ value }) => value);
  expect(values).not.toContain(huge);
  expect(values).toContain("/api/small");
  expect(fitted.endpoint_literal_candidates).toMatchObject({
    code: WEB_BUNDLE_ENDPOINT_LITERAL_CODE,
    admitted_count: 1,
    omitted_by_count: 0,
    omitted_by_result_budget: 1,
    omitted_count: 1,
    ceiling: "adjustable",
  });
  expect(
    jsonValueByteLength(fitted as unknown as JsonValue, budget),
  ).toBeLessThanOrEqual(budget);
});

it("marks the candidate ceiling maximal when it is already at the setting maximum", () => {
  const maximal = webBundleEndpointLiteralRecord(
    {
      maximumCount: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
      source: "setting",
    },
    MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    { byCount: 1, byCountExact: true },
  );
  const adjustable = webBundleEndpointLiteralRecord(
    { maximumCount: 2, source: "runtime" },
    2,
    { byCount: 1, byCountExact: true },
  );
  expect(maximal).toMatchObject({
    admitted_count: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    omitted_by_count: 1,
    omitted_by_result_budget: 0,
    omitted_count: 1,
    ceiling: "maximal",
    limit: {
      effective_value: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
      maximum: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
      update_mode: "runtime",
      pending_restart: false,
    },
  });
  expect(adjustable).toMatchObject({
    omitted_by_count: 1,
    omitted_by_result_budget: 0,
    omitted_count: 1,
    ceiling: "adjustable",
    limit: { pending_restart: false },
  });
});

it("does not treat Map keys or call arguments as candidates", () => {
  const proven = analyze(`const settings = new Map();
settings.get("/api/map-get");
settings.delete("/api/map-delete");
open("/help");
open?.("/help-optional");
const routes = ["/api/from-table"];`);
  expect(
    proven.inferences
      .filter(({ kind }) => kind === "endpoint_candidate")
      .map(({ value }) => value),
  ).toEqual(["/api/from-table"]);
});

it("retains const URL initializers but not reassignable or property values", () => {
  // A `const` URL binding is a base-URL constant; a `let`/`var` binding can be
  // rewritten before use, and an object property carries no such intent.
  const result = analyze(`const BASE = "https://api.example.test";
let mutable = "https://mutable.example.test";
var legacy = "https://legacy.example.test";
const config = { endpoint: "https://property.example.test" };`);
  expect(
    result.inferences
      .filter(({ kind }) => kind === "endpoint_candidate")
      .map(({ value }) => value),
  ).toEqual(["https://api.example.test"]);
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
  expect(
    result.unknowns.find(
      ({ dimension }) => dimension === "endpoint_literal_candidates",
    ),
  ).toMatchObject({
    affected_script_keys: [`scr_${"b".repeat(64)}`],
    limit: { setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID },
  });
});

it("keeps a result that already fits instead of reserving a record", () => {
  const captured = createWebPageInspection([
    {
      source: `const routes = ["/a"];`,
      scriptKey: `scr_${"e".repeat(64)}`,
      url: "https://app.example.test/app.js",
      origin: "https://app.example.test",
      cdpHash: "hash",
    },
  ]);
  const script = captured.scripts.items.find(isIncludedScript);
  if (script === undefined) throw new Error("Missing included script");
  const admission = { maximumCount: 8, source: "runtime" as const };
  const full = analyzeCapturedWebScript(
    script,
    undefined,
    undefined,
    admission,
  );
  if (full.status !== "analyzed") throw new Error("Expected analyzed script");
  const literals = full.inferences.filter(isLiteralEndpointCandidate);
  expect(literals.length).toBe(1);
  const whole = jsonValueByteLength(full as unknown as JsonValue);
  // The omission record is wider than the single candidate it would replace, so
  // reserving it first would reject a result that originally fit.
  const fitted = fitWebBundleEndpointLiteralCandidates(full, whole, admission);
  expect(fitted).toBe(full);
  expect(fitted.endpoint_literal_candidates).toBeUndefined();
});

it("fits literals by cumulative bytes and keeps byte drops out of the count", () => {
  // Each candidate is long enough that the literals, not the omission record,
  // decide what fits; a short table already fits whole and is kept as it is.
  const [first, second, third, fourth] = ["one", "two", "three", "four"].map(
    (name) => `/api/${name}/${name.charAt(0).repeat(2_000)}`,
  );
  const source = `const routes = ${JSON.stringify([
    first,
    second,
    third,
    fourth,
  ])};
fetch("/api/kept");
function vendor() { return "some-vendor-marker"; }`;
  const captured = createWebPageInspection([
    {
      source,
      scriptKey: `scr_${"d".repeat(64)}`,
      url: "https://app.example.test/app.js",
      origin: "https://app.example.test",
      cdpHash: "hash",
    },
  ]);
  const script = captured.scripts.items.find(isIncludedScript);
  if (script === undefined) throw new Error("Missing included script");
  const admission = { maximumCount: 8, source: "runtime" as const };
  const full = analyzeCapturedWebScript(
    script,
    undefined,
    undefined,
    admission,
  );
  if (full.status !== "analyzed") throw new Error("Expected analyzed script");
  const literals = full.inferences.filter(isLiteralEndpointCandidate);
  expect(literals.length).toBe(4);
  expect(full.endpoint_literal_candidates).toBeUndefined();
  // One long candidate has to go: the budget sits below the untrimmed result but
  // above it minus that literal plus the omission record.
  const budget = jsonValueByteLength(full as unknown as JsonValue) - 1_700;
  const fitted = fitWebBundleEndpointLiteralCandidates(full, budget, admission);
  const retained = fitted.inferences.filter(isLiteralEndpointCandidate);
  expect(retained.length).toBeLessThan(literals.length);
  expect(retained.length).toBeGreaterThan(1);
  // Source order decides which literals survive.
  expect(retained.map(({ value }) => value)).toEqual(
    literals.slice(0, retained.length).map(({ value }) => value),
  );
  // Non-literal facts are never dropped to make room.
  expect(
    fitted.inferences
      .filter((inference) => !isLiteralEndpointCandidate(inference))
      .map(({ kind, value }) => [kind, value]),
  ).toEqual(
    full.inferences
      .filter((inference) => !isLiteralEndpointCandidate(inference))
      .map(({ kind, value }) => [kind, value]),
  );
  expect(fitted.endpoint_literal_candidates).toMatchObject({
    admitted_count: retained.length,
    omitted_by_count: 0,
    omitted_by_result_budget: literals.length - retained.length,
    omitted_count: literals.length - retained.length,
  });
  expect(
    jsonValueByteLength(fitted as unknown as JsonValue, budget),
  ).toBeLessThanOrEqual(budget);
});

it("charges the comma a literal needs after retained non-literal facts", () => {
  // `assemble([])` keeps the non-literal candidate, so the first literal is
  // never the first array element: it needs a comma. Charging only later
  // literals let one whose own size exactly filled the remaining space survive
  // the incremental pass, go one byte over, and be dropped by the exact pass
  // while a smaller literal behind it was never retried.
  const captured = createWebPageInspection([
    {
      source: `api.get("/api/nonliteral");
const routes = ["/api/${"a".repeat(296)}", "/api/${"b".repeat(2_996)}", "/api/${"c".repeat(96)}"];`,
      scriptKey: `scr_${"8".repeat(64)}`,
      url: "https://app.example.test/app.js",
      origin: "https://app.example.test",
      cdpHash: "hash",
    },
  ]);
  const script = captured.scripts.items.find(isIncludedScript);
  if (script === undefined) throw new Error("Missing included script");
  const admission = { maximumCount: 16, source: "runtime" as const };
  const full = analyzeCapturedWebScript(
    script,
    undefined,
    undefined,
    admission,
  );
  if (full.status !== "analyzed") throw new Error("Expected analyzed script");
  const literals = full.inferences.filter(isLiteralEndpointCandidate);
  expect(literals.length).toBe(3);
  expect(
    full.inferences.filter(
      (inference) => !isLiteralEndpointCandidate(inference),
    ),
  ).toHaveLength(1);
  const [first, , third] = literals;
  if (first === undefined || third === undefined)
    throw new Error("Expected three literals");
  const base = jsonValueByteLength(
    fitWebBundleEndpointLiteralCandidates(
      full,
      1,
      admission,
    ) as unknown as JsonValue,
  );
  // The first literal's own size exactly fills what is left, and the third
  // literal still fits on its own once the comma is charged.
  const budget = base + jsonValueByteLength(first as unknown as JsonValue);
  expect(
    base + jsonValueByteLength(third as unknown as JsonValue) + 1,
  ).toBeLessThanOrEqual(budget);
  const fitted = fitWebBundleEndpointLiteralCandidates(full, budget, admission);
  const retained = fitted.inferences.filter(isLiteralEndpointCandidate);
  expect(retained).toHaveLength(1);
  expect(retained[0]?.value).toBe(third.value);
  expect(
    jsonValueByteLength(fitted as unknown as JsonValue, budget),
  ).toBeLessThanOrEqual(budget);
});

it("does not call an inexact omission count unique", () => {
  const record = webBundleEndpointLiteralRecord(
    { maximumCount: 1, source: "runtime" },
    1,
    { byCount: 2, byCountExact: false },
  );
  expect(record?.omitted_by_count_exact).toBe(false);
  const message = webBundleEndpointLiteralRecordMessage(
    record ??
      (() => {
        throw new Error("Expected a partial literal record");
      })(),
  );
  expect(message).toContain("not a unique count");
  expect(message).not.toContain("omitted literals");
});

it("keeps checked route facts when literal candidates must be trimmed", () => {
  const captured = createWebPageInspection([
    {
      source: `createBrowserRouter([{path:'/reports',children:[{path:'settings'},{path:'history'},{path:'billing'}]}]);
        const paths = ["/${"p".repeat(2_000)}", "/api/long-${"q".repeat(2_000)}"];`,
      scriptKey: `scr_${"1".repeat(64)}`,
      url: "https://app.example.test/app.js",
      origin: "https://app.example.test",
      cdpHash: "hash",
    },
  ]);
  const script = captured.scripts.items.find(isIncludedScript);
  if (script === undefined) throw new Error("Missing included script");
  const full = analyzeCapturedWebScript(script);
  if (full.status !== "analyzed" || full.route_facts == null)
    throw new Error("Expected route facts");
  const literals = full.inferences.filter(isLiteralEndpointCandidate);
  expect(literals.length).toBeGreaterThan(1);
  const whole = jsonValueByteLength(full as unknown as JsonValue);
  const limited = fitWebBundleEndpointLiteralCandidates(full, whole - 1_500, {
    maximumCount: 1_024,
    source: "default",
  });
  // Route facts are the checked facet: the literal trim never reaches them.
  expect(limited.route_facts).toEqual(full.route_facts);
  expect(
    limited.inferences.filter(isLiteralEndpointCandidate).length,
  ).toBeLessThan(literals.length);
  expect(limited.endpoint_literal_candidates?.limit.setting).toBe(
    WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
  );
});

it("does not promote call arguments or dynamic template literals", () => {
  // Call arguments stay with the request scanners above: a literal passed to an
  // unclassified callee is not evidence of an endpoint, and widening this
  // scanner to call arguments would make the two analyzers disagree on
  // non-network calls such as `getConfiguration("/api")`.
  const result = analyze(`const client = {
  GET: (u) => fetch(u),
  POST: (u) => fetch(u),
};
client.GET(\`/api/uppercase-get\`);
client.POST(\`/api/uppercase-post\`);
getConfiguration("/api");
fsOpen("/tmp/data.txt");
wrap("/api/call-argument");
const dynamic = \`/api/\${id}\`;
const routes = ["/api/from-table"];`);
  const candidates = result.inferences.filter(
    ({ kind }) => kind === "endpoint_candidate",
  );
  expect(candidates.map(({ value }) => value)).toEqual(["/api/from-table"]);
});

it("rejects backslash-prefixed candidates that could leak URL credentials", () => {
  // Array elements reach `webBundleEndpointLiteral` through
  // `inspectEndpointLiterals`, so the backslash guard is actually exercised.
  // The valid path is admitted as a control; the slash-backslash credential
  // reference must never become an `endpoint_candidate`.
  const result = analyze(`const paths = [
    "/valid-path",
    "/\\\\user:pass@api.example.test/path",
  ];`);
  const candidates = result.inferences.filter(
    ({ kind }) => kind === "endpoint_candidate",
  );
  expect(candidates.map(({ value }) => value)).toContain("/valid-path");
  expect(candidates.some(({ value }) => value.includes("\\"))).toBe(false);
});
