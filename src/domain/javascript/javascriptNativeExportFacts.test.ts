import { expect, it } from "vitest";
import {
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "./javascriptApplicationGraph.js";
import {
  artifactEvidence,
  completeCoverage,
} from "./javascriptApplicationGraph.fixture.js";
import { analyzeCommonJsStaticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";
import { traceApplicationFeature } from "./javascriptFeatureTrace.js";
import type { ApplicationFeatureSeed } from "./javascriptFeatureTraceSchemas.js";
import {
  nativeExportCorrespondenceKey,
  nativeExportObservationFacts,
} from "./javascriptNativeExportFacts.js";
import type { JsonValue } from "../jsonValue.js";

const node = (
  observations: readonly {
    label: string;
    properties: Record<string, JsonValue>;
  }[],
) =>
  createJavaScriptApplicationNode({
    kind: "native-export",
    identity: {
      strategy: "artifact-local-key",
      stability: "artifact-version",
      artifact_sha256: "a".repeat(64),
      namespace: "native-export-fixture",
      key: "addon.node",
    },
    observations: observations.map((observation) => ({
      ...observation,
      evidence: artifactEvidence("a".repeat(64), "main.js"),
    })),
  });

it("preserves structured members while distinguishing omitted and empty requests", () => {
  const membersOnly = node([
    {
      label: "open",
      properties: { specifier: "./addon.node", members: ["open"] },
    },
  ]);
  const empty = node([
    {
      label: "open",
      properties: { specifier: "./addon.node", requested_members: [] },
    },
  ]);
  expect(
    nativeExportObservationFacts(membersOnly.observations[0]!),
  ).toMatchObject({
    requestedPresent: false,
    members: ["open"],
  });
  expect(nativeExportObservationFacts(empty.observations[0]!)).toMatchObject({
    requestedPresent: true,
    requested: [],
  });
  expect(nativeExportCorrespondenceKey(membersOnly)).not.toEqual(
    nativeExportCorrespondenceKey(empty),
  );
});

it("considers later conflicting observations and retains malformed values without inventing identity", () => {
  const first = {
    label: "summary",
    properties: { specifier: "./addon.node", requested_members: ["open"] },
  };
  const second = {
    label: "summary",
    properties: { specifier: "./addon.node", requested_members: ["close"] },
  };
  expect(nativeExportCorrespondenceKey(node([first]))).not.toBeNull();
  expect(nativeExportCorrespondenceKey(node([first, second]))).toBeNull();
  for (const requested of [["open", 42], null, "invalid", {}]) {
    const malformed = node([
      {
        label: "display summary",
        properties: {
          specifier: "./addon.node",
          requested_members: requested,
        },
      },
    ]);
    const before = JSON.stringify(malformed);
    expect(
      nativeExportObservationFacts(malformed.observations[0]!),
    ).toMatchObject({
      valid: false,
      requested: Array.isArray(requested) ? ["open"] : [],
    });
    expect(nativeExportCorrespondenceKey(malformed)).toBeNull();
    expect(JSON.stringify(malformed)).toBe(before);
  }
});

it("leaves missing structured identity unknown regardless of display labels", () => {
  for (const requested_members of [["open"], ["close"], []])
    expect(
      nativeExportCorrespondenceKey(
        node([{ label: "same summary", properties: { requested_members } }]),
      ),
    ).toBeNull();
  expect(
    nativeExportCorrespondenceKey(node([{ label: "open", properties: {} }])),
  ).toBeNull();
  const first = node([
    {
      label: "summary one",
      properties: { specifier: "./addon.node", requested_members: ["open"] },
    },
  ]);
  const second = node([
    {
      label: "summary two",
      properties: { specifier: "./addon.node", requested_members: ["open"] },
    },
  ]);
  expect(nativeExportCorrespondenceKey(first)).toEqual(
    nativeExportCorrespondenceKey(second),
  );
});

const traceRequestedExport = (
  requested: ReturnType<typeof node>,
  seed: ApplicationFeatureSeed,
) => {
  const addon = createJavaScriptApplicationNode({
    kind: "native-addon",
    identity: {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: "b".repeat(64),
    },
    observations: [
      {
        label: "addon.node",
        properties: {},
        evidence: artifactEvidence("b".repeat(64), "addon.node"),
      },
    ],
  });
  return traceApplicationFeature({
    sourceEvidenceId: `ev_${"c".repeat(64)}`,
    graph: createJavaScriptApplicationGraph({
      schema: "JavaScriptApplicationGraph",
      nodes: [addon, requested],
      root_node_ids: [addon.node_id],
      edges: [
        createJavaScriptApplicationEdge({
          source_node_id: addon.node_id,
          target_node_id: requested.node_id,
          relation: "exposes",
          properties: {},
          evidence: artifactEvidence("b".repeat(64), "addon.node"),
        }),
      ],
      coverage: completeCoverage,
      limitations: [],
    }),
    nativeEvidence: [],
    seed,
    direction: "both",
  });
};

it("retains an empty JavaScript-requested native member in a feature handoff", () => {
  const analyzed = analyzeCommonJsStaticFixture(
    'const empty = require("./addon.node")[""]; empty();',
  );
  const binding = analyzed.electron.native_addon_bindings[0];
  if (binding === undefined) throw new Error("Expected native addon binding");
  expect(binding.members).toEqual([""]);
  const requested = node([
    {
      label: "requested member summary",
      properties: {
        specifier: binding.specifier,
        requested_members: [...binding.members],
      },
    },
  ]);
  const trace = traceRequestedExport(requested, {
    kind: "native-export",
    value: "",
    match: "exact",
    case_sensitive: true,
  });
  expect(trace.seed_matches).toMatchObject([{ node_id: requested.node_id }]);
  expect(trace.native_handoffs).toMatchObject([
    {
      artifact_sha256: "b".repeat(64),
      requested_exports: [""],
      status: "requires-provider-analysis",
    },
  ]);
});

const handoffCases: {
  properties: Record<string, JsonValue>;
  expected: string[];
}[] = [
  { properties: {}, expected: [] },
  { properties: { requested_members: null }, expected: [] },
  { properties: { requested_members: "invalid" }, expected: [] },
  { properties: { requested_members: {} }, expected: [] },
  { properties: { requested_members: ["open", 42] }, expected: ["open"] },
];

it.each(handoffCases)(
  "uses only structured native names in a handoff: $properties",
  ({ properties, expected }) => {
    const requested = node([
      {
        label: "display summary, never an export name",
        properties: { specifier: "./addon.node", ...properties },
      },
    ]);
    const before = JSON.stringify(requested);
    const trace = traceRequestedExport(requested, {
      kind: "node-id",
      value: requested.node_id,
      match: "exact",
      case_sensitive: true,
    });
    expect(trace.native_handoffs).toMatchObject([
      { requested_exports: expected, status: "requires-provider-analysis" },
    ]);
    expect(JSON.stringify(requested)).toBe(before);
  },
);
