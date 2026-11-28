import { expect, it } from "vitest";

import type {
  ArtifactInventoryCoverage,
  ArtifactNode,
} from "./artifactGraph.js";
import type { InventorySet } from "./artifactInventoryEvidence.js";
import {
  buildMemberIndex,
  DEFAULT_MEMBER_INDEX_JSON_BYTES,
  MAX_EXAMINED_NODES,
  type MemberIndexMember,
} from "./artifactFamilyClusteringIndex.js";

const artifactNode = (
  id: string,
  format: ArtifactNode["format"],
): ArtifactNode => ({
  artifact_id: id,
  format,
  sha256: "a".repeat(64),
  size: 1,
  media_type: null,
  architecture: null,
  content_state: "materialized",
  limitations: [],
});

const inventorySet = (options: {
  readonly nodes: readonly ArtifactNode[];
  readonly rootArtifactId?: string;
  readonly rootFormat?: InventorySet["manifest"]["root_format"];
  readonly scope?: ArtifactInventoryCoverage["scope"];
}): InventorySet => {
  const root = options.nodes[0];
  if (root === undefined) throw new Error("Inventory requires a root node");
  const rootArtifactId = options.rootArtifactId ?? root.artifact_id;
  return {
    manifest: {
      manifest_id: `manifest_${rootArtifactId}`,
      root_artifact_id: rootArtifactId,
      root_sha256: root.sha256,
      root_format: options.rootFormat ?? "file",
      graph_sha256: "g".repeat(64),
      node_count: options.nodes.length,
      occurrence_count: 1,
      edge_count: 0,
    },
    nodes: options.nodes,
    occurrences: [],
    edges: [],
    integrityContradictions: [],
    limitations: [],
    complete: true,
    coverage: { scope: options.scope ?? "root", status: "complete" },
  };
};

const member = (label: string, inventory: InventorySet): MemberIndexMember => ({
  label,
  evidenceId: `ev_${label}`,
  inventory,
});

it("counts omitted nodes when the node cap withholds the index", () => {
  const directory = artifactNode("art_directory", "directory");
  const nodes = Array.from({ length: MAX_EXAMINED_NODES + 1 }, () => directory);
  const complete = [member("first", inventorySet({ nodes }))];
  const index = buildMemberIndex({
    complete,
    // One settled scope, so the complete set is also what is counted.
    counted: complete,
    minimum: 2,
    scope: "root",
    budgetBytes: DEFAULT_MEMBER_INDEX_JSON_BYTES,
  });

  expect(index.withheld).toBe(true);
  expect(index.withheldBy).toBe("node-count");
  expect(index.nodesExamined).toBe(MAX_EXAMINED_NODES + 1);
  // The omission is measured even though the index itself never ran: a capped
  // input must not publish an exact-looking zero for nodes it never examined.
  expect(index.nodesWithoutByteIdentity).toBe(MAX_EXAMINED_NODES + 1);
  expect(index.shared).toEqual([]);
  expect(index.unique).toEqual([]);
});

it("counts omitted nodes when no coverage scope settled", () => {
  const counted = [
    member(
      "first",
      inventorySet({ nodes: [artifactNode("art_directory", "directory")] }),
    ),
  ];
  const index = buildMemberIndex({
    // No scope settled, so the caller has no row domain at all and still
    // counts what the complete members it read omitted.
    complete: [],
    counted,
    minimum: 1,
    scope: null,
    budgetBytes: DEFAULT_MEMBER_INDEX_JSON_BYTES,
  });

  expect(index.withheld).toBe(false);
  expect(index.shared).toEqual([]);
  expect(index.nodesWithoutByteIdentity).toBe(1);
});

it("keeps a manifest-declared directory root out of the index while counting it", () => {
  const root = artifactNode("art_root", "file");
  const complete = ["first", "second"].map((label) =>
    member(
      label,
      inventorySet({
        nodes: [root],
        rootArtifactId: root.artifact_id,
        rootFormat: "directory",
      }),
    ),
  );
  const index = buildMemberIndex({
    complete,
    counted: complete,
    minimum: 2,
    scope: "root",
    budgetBytes: DEFAULT_MEMBER_INDEX_JSON_BYTES,
  });

  // The manifest says the root is a directory, so its digest is graph-derived
  // however the root node is classified: no row may claim it, and both
  // members' observations of it stay visible as counted omissions.
  expect(index.shared).toEqual([]);
  expect(index.partiallyShared).toEqual([]);
  expect(index.unique).toEqual([]);
  expect(index.nodesWithoutByteIdentity).toBe(2);
});
