import { describe, expect, it } from "vitest";

import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  type ApplicationGraphEvidence,
  type ApplicationNode,
} from "./javascriptApplicationGraph.js";
import {
  APPLICATION_GRAPH_DIGESTS,
  artifactEvidence,
} from "./javascriptApplicationGraph.fixture.js";

const contentNode = (
  evidence: ApplicationGraphEvidence,
  properties: Record<string, unknown> = {},
): ApplicationNode =>
  createJavaScriptApplicationNode({
    kind: "javascript-module",
    identity: {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: APPLICATION_GRAPH_DIGESTS.asar,
    },
    observations: [{ label: "module", properties, evidence }],
  });

describe("JavaScript Application Graph", () => {
  it("rejects false truncation claims and unbounded properties", () => {
    const truncated = artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/module.js",
    );
    truncated.coverage = {
      status: "partial",
      truncated: true,
      omitted_count: 0,
      limits: [],
    };
    expect(() => contentNode(truncated)).toThrow(/omitted_count[\s\S]*limits/u);

    const nonComplete = artifactEvidence(
      APPLICATION_GRAPH_DIGESTS.asar,
      "dist/module.js",
    );
    nonComplete.coverage = {
      status: "partial",
      truncated: false,
      omitted_count: null,
      limits: [],
    };
    expect(() => contentNode(nonComplete)).toThrow(
      /Non-complete coverage requires an explicit limitation/u,
    );

    const validNode = contentNode(
      artifactEvidence(APPLICATION_GRAPH_DIGESTS.asar, "dist/module.js"),
    );
    expect(() =>
      createJavaScriptApplicationGraph({
        schema: "JavaScriptApplicationGraph",
        schema_version: 1,
        root_node_ids: [validNode.node_id],
        nodes: [validNode],
        edges: [],
        coverage: {
          status: "partial",
          truncated: false,
          omitted_count: null,
          limits: [],
        },
        limitations: [],
      }),
    ).toThrow(/Non-complete graph coverage requires an explicit limitation/u);

    const properties = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`key-${String(index)}`, index]),
    );
    expect(() =>
      contentNode(
        artifactEvidence(APPLICATION_GRAPH_DIGESTS.asar, "dist/module.js"),
        properties,
      ),
    ).toThrow(/exceed 64 keys/u);
  });
});
