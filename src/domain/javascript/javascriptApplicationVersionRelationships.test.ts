import { expect, it } from "vitest";

import {
  createJavaScriptApplicationEdge,
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  type JavaScriptApplicationGraph,
} from "./javascriptApplicationGraph.js";
import {
  artifactEvidence,
  completeCoverage,
} from "./javascriptApplicationGraph.fixture.js";
import { compareJavaScriptApplicationVersions } from "./javascriptApplicationVersionComparison.js";

const LEFT_SHA = "a".repeat(64);
const RIGHT_SHA = "b".repeat(64);
const NAMES = ["a", "b", "c", "d"] as const;
type ModuleName = (typeof NAMES)[number];
type Relation = "imports" | "contains";
type EdgeSpec = readonly [ModuleName, ModuleName, Relation];

const sourceDigest = (name: string): string =>
  name.charCodeAt(0).toString(16).padStart(64, "0");

const buildGraph = (
  artifactSha: string,
  edges: readonly EdgeSpec[],
): JavaScriptApplicationGraph => {
  const nodes = NAMES.map((name) =>
    createJavaScriptApplicationNode({
      kind: "javascript-module",
      identity: {
        strategy: "canonical-path",
        stability: "artifact-version",
        artifact_sha256: artifactSha,
        path: `${name}.js`,
      },
      observations: [
        {
          label: `${name}.js`,
          properties: { source_sha256: sourceDigest(name) },
          evidence: artifactEvidence(artifactSha, `${name}.js`),
        },
      ],
    }),
  );
  const idOf = (name: ModuleName): string => {
    const node = nodes.find(({ identity }) =>
      identity.strategy === "canonical-path"
        ? identity.path === `${name}.js`
        : false,
    );
    if (node === undefined) throw new Error(`Missing fixture node ${name}`);
    return node.node_id;
  };
  return createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [idOf("a")],
    nodes,
    edges: edges.map(([source, target, relation]) =>
      createJavaScriptApplicationEdge({
        source_node_id: idOf(source),
        target_node_id: idOf(target),
        relation,
        properties: {},
        evidence: artifactEvidence(artifactSha, `${source}.js`),
      }),
    ),
    coverage: completeCoverage,
    limitations: [],
  });
};

const compare = (
  left: JavaScriptApplicationGraph,
  right: JavaScriptApplicationGraph,
) => {
  return compareJavaScriptApplicationVersions({
    left: {
      evidenceId: `ev_${"1".repeat(64)}`,
      rootArtifactSha256: LEFT_SHA,
      graph: left,
    },
    right: {
      evidenceId: `ev_${"2".repeat(64)}`,
      rootArtifactSha256: RIGHT_SHA,
      graph: right,
    },
    leftNativeEvidence: [],
    rightNativeEvidence: [],
  });
};

const BASE_EDGES: readonly EdgeSpec[] = [
  ["a", "b", "imports"],
  ["b", "c", "imports"],
  ["a", "c", "contains"],
  ["c", "b", "imports"],
];

it("keeps paired relationships unchanged regardless of observation order", () => {
  const left = buildGraph(LEFT_SHA, BASE_EDGES);
  const right = buildGraph(RIGHT_SHA, BASE_EDGES);
  const result = compare(left, right);
  expect(result.items).toHaveLength(NAMES.length);
  expect(result.items).toMatchObject(
    Array.from(NAMES, () => ({
      status: "unchanged",
      dimensions: [],
      limitations: [],
      match: { basis: "exact-module-source-digest" },
    })),
  );
  expect(
    compare(left, {
      ...right,
      nodes: [...right.nodes].reverse(),
      edges: [...right.edges].reverse(),
    }),
  ).toEqual(result);
});

it.each<{
  name: string;
  before: readonly EdgeSpec[];
  after: readonly EdgeSpec[];
  changed: readonly ModuleName[];
}>([
  {
    name: "relation kind",
    before: BASE_EDGES,
    after: [
      ["a", "b", "imports"],
      ["b", "c", "contains"],
      ["a", "c", "contains"],
      ["c", "b", "imports"],
    ],
    changed: ["b", "c"],
  },
  {
    name: "new inbound edge",
    before: [["a", "b", "imports"]],
    after: [
      ["a", "b", "imports"],
      ["c", "b", "imports"],
    ],
    changed: ["b", "c"],
  },
  {
    name: "new matched target",
    before: [["a", "b", "imports"]],
    after: [["a", "c", "imports"]],
    changed: ["a", "b", "c"],
  },
  {
    name: "reversed edge",
    before: [["a", "b", "imports"]],
    after: [["b", "a", "imports"]],
    changed: ["a", "b"],
  },
])(
  "reports exact endpoint changes for a $name",
  ({ before, after, changed }) => {
    const left = buildGraph(LEFT_SHA, before);
    const right = buildGraph(RIGHT_SHA, after);
    const result = compare(left, right);
    expect(result.items).toHaveLength(NAMES.length);
    for (const name of NAMES) {
      const path = `${name}.js`;
      const oldNode = left.nodes.find(
        ({ observations }) => observations[0]?.label === path,
      );
      const newNode = right.nodes.find(
        ({ observations }) => observations[0]?.label === path,
      );
      const affected = changed.includes(name);
      expect(
        result.items.find(
          ({ left_node_id }) => left_node_id === oldNode?.node_id,
        ),
        path,
      ).toMatchObject({
        right_node_id: newNode?.node_id,
        status: affected ? "changed" : "unchanged",
        dimensions: affected ? ["relationships"] : [],
        match: { basis: "exact-module-source-digest" },
      });
    }
  },
);
