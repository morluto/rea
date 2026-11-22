import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";
import { nodeSeaElf } from "../../../src/artifacts/nodeSea/NodeSea.fixture.js";
import { scanCanonicalArtifactInventory } from "../../fixtures/artifactInventory.js";
import { compareArtifacts } from "../../../src/domain/artifactComparison.js";
import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
} from "../../../src/domain/artifactGraph.js";
import {
  artifactGraphDigest,
  artifactManifestId,
} from "../../../src/domain/artifactIdentity.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const observe = (inventory: ArtifactInventoryResult) => {
  const graph = artifactGraphDigest({
    nodes: inventory.nodes,
    occurrences: inventory.occurrences,
    edges: inventory.edges,
    contradictions: inventory.integrity_contradictions,
  });
  return createEvidence(
    {
      path: "sea",
      sha256: inventory.manifest.root_sha256,
      format: inventory.manifest.root_format,
    },
    { id: "rea-artifact", name: "REA artifact graph", version: "1" },
    {
      operation: "inventory_artifact",
      parameters: {},
      result: {
        ...inventory,
        manifest: {
          ...inventory.manifest,
          graph_sha256: graph,
          manifest_id: artifactManifestId(
            inventory.manifest.root_artifact_id,
            graph,
          ),
        },
      },
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
};

const ASSET_PATH = "data/café.txt";
const readBaseline = async () => {
  const folder = await createTestTempDirectory("rea-sea-comparison-");
  const path = join(folder, "app");
  await writeFile(
    path,
    nodeSeaElf({ assets: [{ name: ASSET_PATH, body: "asset" }] }),
  );
  const inventory = artifactInventoryResultSchema.parse(
    await scanCanonicalArtifactInventory(path),
  );
  return { inventory, left: observe(inventory) };
};

let baseline: Awaited<ReturnType<typeof readBaseline>> | undefined;

const copyWithAsset = async () => {
  const { inventory, left } = (baseline ??= await readBaseline());
  const right = structuredClone(inventory);
  const occurrence = right.occurrences.find(
    (item) => item.logical_path === ASSET_PATH,
  );
  const metadata = occurrence?.format_metadata;
  if (occurrence === undefined || metadata?.kind !== "node-sea-entry")
    throw new Error("Missing SEA asset fixture");
  return { left, right, occurrence, metadata };
};

it("compares runtime roles when the observed bytes stay equal", async () => {
  const { left, right, metadata } = await copyWithAsset();
  metadata.role = "code-cache";
  const result = compareArtifacts(left, observe(right));
  expect(result.changes).toEqual([
    expect.objectContaining({
      logical_path: ASSET_PATH,
      classification: "changed",
      dimensions: ["metadata"],
    }),
  ]);
});

it.each([
  [
    "unavailable",
    { classification: "changed", dimensions: ["metadata", "availability"] },
  ],
  [
    "mismatched",
    { classification: "contradiction", dimensions: ["integrity"] },
  ],
] as const)(
  "preserves %s content semantics when runtime metadata differs",
  async (status, expected) => {
    const { left, right, occurrence, metadata } = await copyWithAsset();
    metadata.source_path = "changed-key";
    occurrence.source_path = "changed-key";
    occurrence.hash_status = status;
    expect(compareArtifacts(left, observe(right)).changes).toEqual([
      expect.objectContaining({ logical_path: ASSET_PATH, ...expected }),
    ]);
  },
);

it("retains proven executable differences alongside missing legacy metadata", async () => {
  const { left, right, occurrence } = await copyWithAsset();
  delete occurrence.format_metadata;
  occurrence.executable = true;
  expect(compareArtifacts(left, observe(right)).changes).toEqual([
    expect.objectContaining({
      logical_path: ASSET_PATH,
      classification: "changed",
      dimensions: ["executable", "availability"],
    }),
  ]);
});

it("retains known runtime key changes when a partial inventory omits the content node", async () => {
  const { left, right, occurrence, metadata } = await copyWithAsset();
  metadata.source_path = "changed-key";
  occurrence.source_path = "changed-key";
  right.nodes = right.nodes.filter(
    (node) => node.artifact_id !== occurrence.artifact_id,
  );
  const result = compareArtifacts(left, observe(right));
  expect(result.status).toBe("truncated");
  expect(result.changes).toEqual([
    expect.objectContaining({
      logical_path: ASSET_PATH,
      classification: "changed",
      dimensions: ["metadata", "availability"],
    }),
  ]);
});
