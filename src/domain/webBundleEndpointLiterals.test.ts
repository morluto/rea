import { expect, it } from "vitest";
import { createWebPageInspection } from "../../tests/support/browser/webPageInspection.js";
import { analyzeWebBundleFixture } from "../../tests/support/browser/analyzeWebBundleFixture.js";

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
