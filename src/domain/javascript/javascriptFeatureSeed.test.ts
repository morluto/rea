import { describe, expect, it } from "vitest";

import { buildSyntheticJavaScriptApplicationGraph } from "./javascriptApplicationGraph.fixture.js";
import { freezeJsonSnapshot } from "../immutableJson.js";
import type { JsonValue } from "../jsonValue.js";
import { semanticFixtureGraph } from "../../../tests/support/javascriptSemanticGraphFixture.js";
import {
  findApplicationFeatureSeeds,
  findApplicationFeatureSeedsInGraph,
} from "./javascriptFeatureSeed.js";
import { traceApplicationFeature } from "./javascriptFeatureTrace.js";

describe("application feature seed property matching", () => {
  it("finds a string after 512 other property values", () => {
    const node = graphNodeWithProperties({
      values: Array.from({ length: 513 }, (_, index) => `value-${index}`),
    });

    expect(
      findApplicationFeatureSeeds([node], {
        kind: "string",
        value: "value-512",
        match: "exact",
        case_sensitive: true,
      }),
    ).toEqual([
      {
        node_id: node.node_id,
        kind: node.kind,
        basis: "property",
        field: "observations[0].properties.values[512]",
      },
    ]);
  });

  it("finds a string seven properties deep", () => {
    const node = graphNodeWithProperties({
      one: {
        two: { three: { four: { five: { six: { seven: "deep-value" } } } } },
      },
    });

    expect(
      findApplicationFeatureSeeds([node], {
        kind: "string",
        value: "deep-value",
        match: "exact",
        case_sensitive: true,
      }),
    ).toEqual([
      {
        node_id: node.node_id,
        kind: node.kind,
        basis: "property",
        field: "observations[0].properties.one.two.three.four.five.six.seven",
      },
    ]);
  });
});

const graphNodeWithProperties = (
  properties: Readonly<Record<string, JsonValue>>,
) => {
  const template = buildSyntheticJavaScriptApplicationGraph().nodes[0];
  if (template === undefined) throw new Error("Expected fixture graph node");
  return {
    ...template,
    observations: template.observations.map((observation) => ({
      ...observation,
      properties,
    })),
  };
};

describe("feature seed normalization, field gating, and immutable WeakMap index", () => {
  it("matches ASCII fast-path and Unicode NFKC values while gating irrelevant fields", () => {
    const channelNode = {
      ...graphNodeWithProperties({
        unrelated: "ipc:AuthToken",
        channel: "ipc:AuthToken",
      }),
      kind: "ipc-channel" as const,
    };
    const apiNode = {
      ...graphNodeWithProperties({
        unrelated: "getToken",
        methods: ["getToken"],
      }),
      kind: "context-bridge-api" as const,
    };
    const unicodeNode = graphNodeWithProperties({
      title: "ﬁle-HÉLLO",
      nested: { unused: true },
    });
    const template = buildSyntheticJavaScriptApplicationGraph().nodes[0];
    if (template === undefined) throw new Error("Expected fixture graph node");
    expect(
      findApplicationFeatureSeeds([template, channelNode], {
        kind: "channel",
        value: "IPC:authtoken",
        match: "exact",
        case_sensitive: false,
      }),
    ).toEqual([
      {
        node_id: channelNode.node_id,
        kind: "ipc-channel",
        basis: "property",
        field: "observations[0].properties.channel",
      },
    ]);
    expect(
      findApplicationFeatureSeeds([apiNode], {
        kind: "api",
        value: "gettoken",
        match: "exact",
        case_sensitive: false,
      }),
    ).toEqual([
      {
        node_id: apiNode.node_id,
        kind: "context-bridge-api",
        basis: "property",
        field: "observations[0].properties.methods[0]",
      },
    ]);
    expect(
      findApplicationFeatureSeeds([unicodeNode], {
        kind: "string",
        value: "FILE-héllo",
        match: "contains",
        case_sensitive: false,
      }),
    ).toEqual([
      {
        node_id: unicodeNode.node_id,
        kind: unicodeNode.kind,
        basis: "property",
        field: "observations[0].properties.title",
      },
    ]);
  });

  it("matches mutable parity with immutable JAG and semantic-label WeakMap indexes", () => {
    const mutableGraph = buildSyntheticJavaScriptApplicationGraph();
    const immutableGraph = freezeJsonSnapshot(structuredClone(mutableGraph));
    const mutableSemantic = semanticFixtureGraph();
    const immutableSemantic = freezeJsonSnapshot(
      structuredClone(mutableSemantic),
    );
    const seed = {
      kind: "string" as const,
      value: "app.example.invalid",
      match: "contains" as const,
      case_sensitive: false,
    };
    expect(findApplicationFeatureSeedsInGraph(immutableGraph, seed)).toEqual(
      findApplicationFeatureSeedsInGraph(mutableGraph, seed),
    );
    const evId = `ev_${"a".repeat(64)}`;
    const traceHitA = traceApplicationFeature({
      sourceEvidenceId: evId,
      graph: immutableGraph,
      semanticGraph: immutableSemantic,
      nativeEvidence: [],
      seed,
      direction: "both",
    });
    const traceHitB = traceApplicationFeature({
      sourceEvidenceId: evId,
      graph: immutableGraph,
      semanticGraph: immutableSemantic,
      nativeEvidence: [],
      seed,
      direction: "both",
    });
    expect(traceHitB).toEqual(traceHitA);

    const missSeed = {
      kind: "string" as const,
      value:
        immutableSemantic.nodes.find((n) => n.label !== null)?.label ??
        "missing",
      match: "contains" as const,
      case_sensitive: false,
    };
    const missMutable = traceApplicationFeature({
      sourceEvidenceId: evId,
      graph: mutableGraph,
      semanticGraph: mutableSemantic,
      semanticPage: { offset: 0, limit: 2 },
      nativeEvidence: [],
      seed: missSeed,
      direction: "outgoing",
    });
    const missImmutableWarm = traceApplicationFeature({
      sourceEvidenceId: evId,
      graph: immutableGraph,
      semanticGraph: immutableSemantic,
      semanticPage: { offset: 0, limit: 2 },
      nativeEvidence: [],
      seed: missSeed,
      direction: "outgoing",
    });
    expect(missImmutableWarm).toEqual(missMutable);
  });
});
