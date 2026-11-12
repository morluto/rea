import { expect, it } from "vitest";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "./javascriptApplicationGraph.js";
import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "../../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { javascriptApplicationAnalysisResultSchema } from "./javascriptApplicationAnalysis.js";
import { analysisViewCaptureFixture } from "../../../tests/fixtures/analysisView.js";
import { WebNetworkApiSurfaceAccumulator } from "../analysisView/WebNetworkApiSurfaceAccumulator.js";
import { compareStaticObservedEndpoints } from "./staticObservedEndpoints.js";
import { staticObservedEndpointComparisonSchema } from "./staticObservedEndpointSchemas.js";

const original = javascriptApplicationAnalysisResultSchema.parse(
  JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.normalized_result,
).graph;
const evidence = original.nodes[0]!.observations[0]!.evidence;
if (!evidence.artifact.available)
  throw new Error("Static fixture must identify its source bytes");
const artifactSha256 = evidence.artifact.sha256;
const graphFor = (
  targets: readonly {
    value: string;
    mechanism?: string;
    interpretation?: string;
    resolution?: string;
  }[],
  sourceState: "observed" | "unknown" = "observed",
) =>
  createJavaScriptApplicationGraph({
    schema: original.schema,
    root_node_ids: original.root_node_ids,
    coverage: original.coverage,
    limitations: original.limitations,
    nodes: [
      ...original.nodes,
      ...targets.map((target, index) =>
        createJavaScriptApplicationNode({
          kind: "endpoint",
          identity: {
            strategy: "artifact-local-key",
            stability: "artifact-version",
            artifact_sha256: artifactSha256,
            namespace: "network-endpoint",
            key: String(index),
          },
          observations: [
            {
              label: null,
              properties: {
                endpoint_kind: "network",
                mechanism: "call:fetch",
                ...target,
              },
              evidence:
                sourceState === "observed"
                  ? evidence
                  : {
                      ...evidence,
                      state: sourceState,
                      confidence: "unknown",
                      limitations: [
                        "Fixture explicitly leaves network interpretation unknown.",
                      ],
                    },
            },
          ],
        }),
      ),
    ],
    edges: [],
  });
const run = (
  targets: Parameters<typeof graphFor>[0],
  requests: readonly { path: string; method?: string; origin?: string }[],
  options: {
    complete?: boolean;
    origin?: string | null;
    budget?: number;
    sourceState?: "observed" | "unknown";
  } = {},
) => {
  const accumulator = new WebNetworkApiSurfaceAccumulator(
    options.budget,
    false,
    { operation: "compare_static_and_observed_endpoints" },
  );
  for (const [ordinal, request] of requests.entries()) {
    const added = accumulator.add({
      ...analysisViewCaptureFixture().records[0]!,
      ordinal,
      limitations: [],
      reported: {
        request: {
          method: request.method ?? "GET",
          url: `${request.origin ?? "https://api.test"}${request.path}`,
        },
        response: { status: 200, content: { mimeType: "application/json" } },
      },
    });
    if (!added.ok) return added;
  }
  return compareStaticObservedEndpoints({
    applicationEvidenceId: `ev_${"a".repeat(64)}`,
    captureEvidenceId: `ev_${"b".repeat(64)}`,
    graph: graphFor(targets, options.sourceState),
    accumulator,
    captureComplete: options.complete ?? true,
    ...(options.origin === null
      ? {}
      : { origin: options.origin ?? "https://api.test" }),
  });
};

it("reports all four outcomes, exact/template basis and unknown method without copying URL details", () => {
  const result = run(
    [
      { value: "/matched?source-query=ordinary#fragment" },
      { value: "/users/789" },
      { value: "/missing" },
      { value: "KEY", interpretation: "candidate" },
    ],
    [
      { path: "/matched?capture-query=ordinary" },
      { path: "/users/123" },
      { path: "/observed-only" },
    ],
  );
  if (!result.ok) throw result.error;
  expect(result.value.summary).toMatchObject({
    matched: 2,
    not_observed_in_capture: 1,
    unknown: 1,
    observed_without_static_match: 1,
  });
  expect(result.value.matches.map(({ basis }) => basis).sort()).toEqual([
    "exact",
    "template-compatible",
  ]);
  expect(
    result.value.static_endpoints.find(({ path }) => path === "/matched"),
  ).toMatchObject({
    method: null,
    method_basis: "unknown",
    origin_basis: "caller-origin",
  });
  expect(JSON.stringify(result.value)).not.toMatch(
    /source-query|capture-query|fragment|ordinary/,
  );
  expect(
    staticObservedEndpointComparisonSchema.shape.static_endpoints.safeParse(
      result.value.static_endpoints,
    ).success,
  ).toBe(true);
});

it("does not promote an explicitly unknown static observation to a match", () => {
  const result = run([{ value: "/matched" }], [{ path: "/matched" }], {
    sourceState: "unknown",
  });
  if (!result.ok) throw result.error;
  expect(result.value.static_endpoints[0]).toMatchObject({
    status: "unknown",
    reason: "unconfirmed-static-observation",
  });
  expect(result.value.matches).toEqual([]);
});

it("does not manufacture an exact whole path from independent templated segment values", () => {
  const result = run(
    [{ value: "/a/1/b/2" }],
    [{ path: "/a/1/b/3" }, { path: "/a/4/b/2" }],
  );
  if (!result.ok) throw result.error;
  expect(result.value.matches[0]?.basis).toBe("template-compatible");
  expect(result.value.observed_groups[0]?.record_ordinals).toEqual([0, 1]);
});

it("names a concrete exact witness within a group containing different literal paths", () => {
  const result = run(
    [{ value: "/users/123" }],
    [{ path: "/users/456" }, { path: "/users/123" }],
  );
  if (!result.ok) throw result.error;
  expect(result.value.matches[0]).toMatchObject({
    basis: "exact",
    supporting_record_ordinal: 1,
  });
  expect(result.value.observed_groups[0]?.record_ordinals).toEqual([0, 1]);
});

it.each([{ complete: false }, { origin: null }])(
  "keeps missing endpoints unknown with incomplete capture or undeclared origin: %j",
  (options) => {
    const result = run([{ value: "/missing" }], [{ path: "/other" }], options);
    if (!result.ok) throw result.error;
    expect(result.value.static_endpoints[0]?.status).toBe("unknown");
  },
);

it("requires an exercised origin, even for an exact absolute URL", () => {
  const result = run(
    [{ value: "https://unseen.test/missing" }],
    [{ path: "/other" }],
  );
  if (!result.ok) throw result.error;
  expect(result.value.static_endpoints[0]).toMatchObject({
    status: "unknown",
    reason: "origin-not-exercised",
  });
});

it("keeps normalization, operation names and partial expressions unknown", () => {
  const result = run(
    [
      { value: "/a/%2e%2e/admin" },
      { value: "GetViewer" },
      { value: "trpc.user.byId" },
      { value: "fetch(prefix + path)", resolution: "partial" },
    ],
    [{ path: "/admin" }],
  );
  if (!result.ok) throw result.error;
  expect(result.value.summary.unknown).toBe(4);
  expect(result.value.matches).toEqual([]);
});

it.each([false, true])(
  "keeps ambiguity on both sides and preserves confirmed method matches (known peer: %s)",
  (knownPeer) => {
    const result = run(
      [
        { value: "/ambiguous" },
        ...(knownPeer
          ? [{ value: "/ambiguous", mechanism: "new:EventSource" }]
          : []),
        { value: "/events", mechanism: "new:EventSource" },
      ],
      [
        { path: "/ambiguous", method: "GET" },
        { path: "/ambiguous", method: "POST" },
        { path: "/events", method: "POST" },
      ],
    );
    if (!result.ok) throw result.error;
    expect(
      result.value.static_endpoints.find(
        ({ path, method }) => path === "/ambiguous" && method === null,
      ),
    ).toMatchObject({
      status: "unknown",
      reason: "ambiguous-method",
      method: null,
    });
    expect(
      result.value.static_endpoints.find(({ path }) => path === "/events"),
    ).toMatchObject({ status: "not-observed-in-capture", method: "GET" });
    expect(result.value.summary.observed_unknown).toBe(knownPeer ? 1 : 2);
    expect(
      result.value.observed_groups.find(
        ({ path_template, method }) =>
          path_template === "/ambiguous" && method === "POST",
      ),
    ).toMatchObject({ status: "unknown", reason: "ambiguous-static-method" });
    expect(
      result.value.observed_groups.find(
        ({ path_template, method }) =>
          path_template === "/ambiguous" && method === "GET",
      ),
    ).toMatchObject({
      status: knownPeer ? "matched" : "unknown",
      reason: knownPeer ? null : "ambiguous-static-method",
    });
  },
);

it("does not upgrade absence when even one recorded request is excluded", () => {
  const result = run(
    [{ value: "/missing" }],
    [{ path: "/known" }, { path: "/omitted", method: "" }],
  );
  if (!result.ok) throw result.error;
  expect(result.value.static_endpoints[0]).toMatchObject({
    status: "unknown",
    reason: "capture-incomplete",
  });
});

it("charges comparison state against the inherited representation allowance", () => {
  const result = run([{ value: "/large".repeat(500) }], [{ path: "/known" }], {
    budget: 4096,
  });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
});
