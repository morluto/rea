import { describe, expect, it } from "vitest";

import {
  artifactEvidence,
  completeCoverage,
  fixtureNode,
} from "./javascriptApplicationGraph.fixture.js";
import {
  createJavaScriptApplicationGraph,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import type { ApplicationNode } from "./javascriptApplicationGraphSchemas.js";
import { compareJavaScriptApplicationVersions } from "./javascriptApplicationVersionComparison.js";

const ARTIFACT_SHA = "a".repeat(64);

const moduleNode = (
  name: string,
  source: string,
  structure?: string,
  algorithm = "fixture",
) =>
  fixtureNode(
    "javascript-module",
    {
      strategy: "canonical-path",
      stability: "artifact-version",
      artifact_sha256: ARTIFACT_SHA,
      path: `${name}.js`,
    },
    name,
    {
      source_sha256: source.repeat(64),
      ...(structure === undefined
        ? {}
        : {
            structural_fingerprint_sha256: structure.repeat(64),
            structural_fingerprint_algorithm: algorithm,
          }),
    },
    artifactEvidence(ARTIFACT_SHA, `${name}.js`),
  );

const graph = (nodes: ApplicationNode[]): JavaScriptApplicationGraph =>
  createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: nodes.map(({ node_id }) => node_id),
    nodes,
    edges: [],
    coverage: completeCoverage,
    limitations: [],
  });

const compare = (
  left: JavaScriptApplicationGraph,
  right: JavaScriptApplicationGraph,
) =>
  compareJavaScriptApplicationVersions({
    left: {
      evidenceId: `ev_${"1".repeat(64)}`,
      rootArtifactSha256: ARTIFACT_SHA,
      graph: left,
    },
    right: {
      evidenceId: `ev_${"2".repeat(64)}`,
      rootArtifactSha256: ARTIFACT_SHA,
      graph: right,
    },
    leftNativeEvidence: [],
    rightNativeEvidence: [],
  });

it("matches equal digests only within the same archived fingerprint algorithm", () => {
  const left = [
    moduleNode("left-v1", "1", "a", "babel-ast-v1"),
    moduleNode("left-v2", "2", "a", "babel-ast-v2"),
    moduleNode("left-v3", "3", "a", "babel-ast-v3"),
    moduleNode("left-incompatible", "4", "b", "babel-ast-v1"),
  ] as const;
  const right = [
    moduleNode("right-v3", "5", "a", "babel-ast-v3"),
    moduleNode("right-v2", "6", "a", "babel-ast-v2"),
    moduleNode("right-v1", "7", "a", "babel-ast-v1"),
    moduleNode("right-incompatible", "8", "b", "babel-ast-v3"),
  ] as const;
  const result = compare(graph([...left]), graph([...right]));
  expect(result.items).toHaveLength(5);
  for (const [before, after] of [
    [left[0], right[2]],
    [left[1], right[1]],
    [left[2], right[0]],
  ] as const) {
    expect(
      result.items.find(({ left_node_id }) => left_node_id === before.node_id),
    ).toMatchObject({
      right_node_id: after.node_id,
      status: "changed",
      match: { status: "matched", basis: "structural-fingerprint" },
    });
  }
  expect(
    result.items.find(({ left_node_id }) => left_node_id === left[3].node_id),
  ).toMatchObject({
    right_node_id: null,
    status: "removed",
    match: { status: "unmatched" },
  });
  expect(
    result.items.find(
      ({ right_node_id }) => right_node_id === right[3].node_id,
    ),
  ).toMatchObject({
    left_node_id: null,
    status: "added",
    match: { status: "unmatched" },
  });
});

describe("application version matching", () => {
  it("does not revisit a source group that becomes unique after identity matching", () => {
    const shared = moduleNode("shared", "1");
    const leftOnly = moduleNode("left", "1");
    const rightOnly = moduleNode("right", "1");
    const result = compare(
      graph([shared, leftOnly]),
      graph([shared, rightOnly]),
    );

    expect(result.matching).toMatchObject({
      exact_node_identity: 1,
      exact_module_source_digest: 0,
      ambiguous: 2,
      unmatched: 0,
    });
    expect(
      result.items.find(({ left_node_id }) => left_node_id === shared.node_id),
    ).toMatchObject({
      right_node_id: shared.node_id,
      match: { status: "matched", basis: "exact-node-identity" },
    });
    expect(
      result.items.find(
        ({ left_node_id }) => left_node_id === leftOnly.node_id,
      ),
    ).toMatchObject({
      status: "unknown",
      right_node_id: null,
      match: {
        status: "ambiguous",
        candidate_right_node_ids: [rightOnly.node_id],
      },
    });
    expect(
      result.items.find(
        ({ right_node_id }) => right_node_id === rightOnly.node_id,
      ),
    ).toMatchObject({
      status: "unknown",
      left_node_id: null,
      match: {
        status: "ambiguous",
        candidate_left_node_ids: [leftOnly.node_id],
      },
    });
  });

  it("unions all unresolved source and structural candidates without forcing pairs", () => {
    const a = moduleNode("a", "1", "a");
    const b = moduleNode("b", "1", "a");
    const c = moduleNode("c", "2", "a");
    const x = moduleNode("x", "1", "a");
    const y = moduleNode("y", "1", "b");
    const z = moduleNode("z", "3", "a");
    const left = graph([a, b, c]);
    const right = graph([x, y, z]);
    const result = compare(left, right);

    expect(result.summary).toEqual({
      unchanged: 0,
      added: 0,
      removed: 0,
      changed: 0,
      unknown: 6,
    });
    expect(result.matching).toMatchObject({ ambiguous: 6, unmatched: 0 });
    for (const [node, candidates] of [
      [a, [x, y, z]],
      [b, [x, y, z]],
      [c, [x, z]],
    ] as const) {
      expect(
        result.items.find(({ left_node_id }) => left_node_id === node.node_id)
          ?.match,
      ).toEqual({
        status: "ambiguous",
        basis: "none",
        confidence: "unknown",
        candidate_left_node_ids: [],
        candidate_right_node_ids: candidates
          .map(({ node_id }) => node_id)
          .sort(),
      });
    }
    for (const [node, candidates] of [
      [x, [a, b, c]],
      [y, [a, b]],
      [z, [a, b, c]],
    ] as const) {
      expect(
        result.items.find(({ right_node_id }) => right_node_id === node.node_id)
          ?.match,
      ).toEqual({
        status: "ambiguous",
        basis: "none",
        confidence: "unknown",
        candidate_left_node_ids: candidates
          .map(({ node_id }) => node_id)
          .sort(),
        candidate_right_node_ids: [],
      });
    }

    // Permute the already validated graph so matching sees the changed order.
    // Compare the full result, including item, comparison and change-graph IDs.
    expect(
      compare(
        { ...left, nodes: [...left.nodes].reverse() },
        { ...right, nodes: [...right.nodes].reverse() },
      ),
    ).toEqual(result);
  });
});
