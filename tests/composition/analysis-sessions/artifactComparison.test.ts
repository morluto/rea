import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fragmentInventoryEvidence } from "../../fixtures/artifactEvidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { inventoryArtifact } from "../../../src/application/ArtifactInventory.js";
import { artifactInventoryResultSchema } from "../../../src/domain/artifactGraph.js";
import {
  artifactComparisonResultSchema,
  compareArtifacts,
} from "../../../src/domain/artifactComparison.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";

const PROVIDER = {
  id: "rea-artifact-graph",
  name: "REA artifact graph",
  version: "1",
} as const;

const observe = async (path: string) => {
  const inventory = await inventoryArtifact(path);
  return createEvidence(
    {
      path,
      sha256: inventory.manifest.root_sha256,
      format: inventory.manifest.root_format,
    },
    PROVIDER,
    {
      operation: "inventory_artifact",
      parameters: {},
      result: jsonValueSchema.parse(inventory),
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
};

const changedArtifactComparison = async () => {
  const parent = await createTestTempDirectory("rea-artifact-compare-");
  const leftPath = join(parent, "left.app");
  const rightPath = join(parent, "right.app");
  await Promise.all([mkdir(leftPath), mkdir(rightPath)]);
  await Promise.all([
    writeFile(join(leftPath, "main.js"), "old();"),
    writeFile(join(leftPath, "same.txt"), "same"),
    writeFile(join(rightPath, "main.js"), "newer();"),
    writeFile(join(rightPath, "same.txt"), "same"),
    writeFile(join(rightPath, "added.txt"), "added"),
  ]);
  const left = await observe(leftPath);
  const right = await observe(rightPath);
  return {
    left,
    right,
    result: compareArtifacts(left, right),
  };
};

describe("artifact comparison", () => {
  it("classifies deterministic path changes and cites both inventories", async () => {
    const firstObservation = await changedArtifactComparison();
    const secondObservation = await changedArtifactComparison();
    const first = firstObservation.result;
    const second = secondObservation.result;
    expect(first).toEqual(second);
    expect(artifactComparisonResultSchema.parse(first)).toMatchObject({
      status: "changed",
      summary: { added: 1, changed: 2, unknown: 0 },
      changes: expect.arrayContaining([
        expect.objectContaining({ logical_path: "added.txt" }),
      ]),
    });
    expect(first.changes[0]?.evidence_links).toEqual([
      firstObservation.left.evidence_id,
      firstObservation.right.evidence_id,
    ]);
    expect(first.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_path: "added.txt",
          classification: "added",
        }),
        expect.objectContaining({
          logical_path: "main.js",
          classification: "changed",
          dimensions: expect.arrayContaining(["content", "size"]),
        }),
      ]),
    );
  });

  it("reports incomplete inventory as truncated, never unchanged", async () => {
    const root = await createTestTempDirectory("rea-artifact-truncated-");
    await writeFile(join(root, "one.txt"), "one");
    const complete = await observe(root);
    const completeInventory = artifactInventoryResultSchema.parse(
      complete.normalized_result,
    );
    const incomplete = createEvidence(
      {
        path: root,
        sha256: complete.subject?.digest.sha256 ?? "0".repeat(64),
        format: "directory",
      },
      PROVIDER,
      {
        operation: "inventory_artifact",
        parameters: {},
        result: jsonValueSchema.parse({
          ...completeInventory,
          nodes: [],
        }),
        confidence: "observed",
        authority: "shipped-artifact",
        limitations: ["Inventory node observations are unavailable."],
      },
    );
    const comparison = compareArtifacts(incomplete, incomplete);
    expect(comparison).toMatchObject({
      status: "truncated",
      summary: { unchanged: 0, unknown: 2 },
    });
    expect(comparison.limitations).toContain(
      "Left artifact inventory is incomplete.",
    );
  });
});

describe("artifact comparison completeness", () => {
  it("compares every graph member for inventories larger than 500 entries", async () => {
    const root = await createTestTempDirectory("rea-artifact-pages-");
    const entryCount = 501;
    await Promise.all(
      Array.from({ length: entryCount }, async (_, index) =>
        writeFile(
          join(root, `file-${String(index).padStart(3, "0")}.txt`),
          String(index),
        ),
      ),
    );
    const complete = await observe(root);
    const graph = artifactInventoryResultSchema.parse(
      complete.normalized_result,
    );
    // The real risk above 500 entries is silent truncation, so assert the
    // manifest counts reconcile with the arrays actually returned and that
    // every written file is present. Deriving from `entryCount` keeps this
    // valid at any size instead of freezing a page boundary.
    expect(graph.manifest.node_count).toBe(graph.nodes.length);
    expect(graph.manifest.occurrence_count).toBe(graph.occurrences.length);
    expect(graph.manifest.edge_count).toBe(graph.edges.length);
    const written = new Set(
      Array.from(
        { length: entryCount },
        (_, index) => `file-${String(index).padStart(3, "0")}.txt`,
      ),
    );
    // Occurrences carry the inventory paths, so completeness is checked there.
    const paths = new Set(
      graph.occurrences.map((occurrence) => occurrence.logical_path),
    );
    expect([...written].filter((path) => !paths.has(path))).toEqual([]);
    expect(
      graph.occurrences.filter(
        (occurrence) => occurrence.entry_kind === "file",
      ),
    ).toHaveLength(entryCount);
    expect(compareArtifacts(complete, complete)).toMatchObject({
      status: "unchanged",
      summary: { unchanged: 502, unknown: 0 },
      changes: [],
    });
  }, 15_000);

  it("assembles real inventory fragments and retains every citation", async () => {
    const parent = await createTestTempDirectory("rea-artifact-fragments-");
    const leftPath = join(parent, "left.app");
    const rightPath = join(parent, "right.app");
    await Promise.all([mkdir(leftPath), mkdir(rightPath)]);
    // Cross the former 100-citation limit with distinct, real graph members.
    const fragmentCount = 101;
    await Promise.all(
      Array.from({ length: fragmentCount }, async (_, index) => {
        await Promise.all([
          writeFile(join(leftPath, `file-${index}.js`), `left(${index});`),
          writeFile(join(rightPath, `file-${index}.js`), `right(${index});`),
        ]);
      }),
    );
    const left = await observe(leftPath);
    const right = await observe(rightPath);
    const leftFragments = fragmentInventoryEvidence(left, fragmentCount);
    const rightFragments = fragmentInventoryEvidence(right, fragmentCount);
    const citations = [...leftFragments, ...rightFragments]
      .map(({ evidence_id }) => evidence_id)
      .sort();
    expect(new Set(citations).size).toBe(fragmentCount * 2);
    const comparison = compareArtifacts(leftFragments, rightFragments);
    const complete = compareArtifacts(left, right);
    expect(
      comparison.changes
        .filter(({ logical_path }) => logical_path !== ".")
        .map(({ logical_path, classification }) => ({
          logical_path,
          classification,
        }))
        .sort((left, right) =>
          left.logical_path.localeCompare(right.logical_path),
        ),
    ).toEqual(
      Array.from({ length: fragmentCount }, (_, index) => ({
        logical_path: `file-${index}.js`,
        classification: "changed",
      })).sort((left, right) =>
        left.logical_path.localeCompare(right.logical_path),
      ),
    );
    expect({
      ...comparison,
      changes: comparison.changes.map((change) => ({
        ...change,
        evidence_links: [...change.evidence_links].sort(),
      })),
    }).toEqual({
      ...complete,
      changes: complete.changes.map((change) => ({
        ...change,
        evidence_links: citations,
      })),
    });
  }, 15_000);

  it("rejects non-inventory and tampered Evidence", async () => {
    const root = await createTestTempDirectory("rea-artifact-invalid-");
    const evidence = await observe(root);
    expect(() =>
      compareArtifacts({ ...evidence, operation: "binary_overview" }, evidence),
    ).toThrow(/identifier/u);
    const wrongOperation = createEvidence(undefined, PROVIDER, {
      operation: "binary_overview",
      parameters: {},
      result: evidence.normalized_result,
    });
    expect(() => compareArtifacts(wrongOperation, evidence)).toThrow(
      /inspect_artifact/u,
    );
    const mismatchedSubject = createEvidence(
      { path: root, sha256: "f".repeat(64), format: "directory" },
      PROVIDER,
      {
        operation: "inventory_artifact",
        parameters: {},
        result: evidence.normalized_result,
      },
    );
    expect(() => compareArtifacts(mismatchedSubject, evidence)).toThrow(
      /root digest/u,
    );
  });
});
