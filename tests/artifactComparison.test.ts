import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { inventoryArtifact } from "../src/application/ArtifactInventory.js";
import {
  artifactComparisonResultSchema,
  compareArtifacts,
} from "../src/domain/artifactComparison.js";
import { createEvidence } from "../src/domain/evidence.js";
import { jsonValueSchema } from "../src/domain/jsonValue.js";

const LIMITS = {
  maxEntries: 1_000,
  maxTotalBytes: 1024 * 1024,
  maxEntryBytes: 1024 * 1024,
  maxCompressionRatio: 100,
  maxDepth: 20,
  maxPathBytes: 1024,
} as const;
const PROVIDER = {
  id: "rea-artifact-graph",
  name: "REA artifact graph",
  version: "1",
} as const;

const observe = async (
  path: string,
  page: {
    readonly nodeOffset?: number;
    readonly nodeLimit?: number;
    readonly occurrenceOffset?: number;
    readonly edgeOffset?: number;
  } = {},
) => {
  const inventory = await inventoryArtifact(path, LIMITS, {
    nodeOffset: page.nodeOffset ?? 0,
    nodeLimit: page.nodeLimit ?? 500,
    occurrenceOffset: page.occurrenceOffset ?? 0,
    occurrenceLimit: 500,
    edgeOffset: page.edgeOffset ?? 0,
    edgeLimit: 500,
  });
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

describe("artifact comparison", () => {
  it("classifies deterministic path changes and cites both inventories", async () => {
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
    const first = compareArtifacts(left, right, 0, 1);
    const second = compareArtifacts(left, right, 0, 1);
    expect(first).toEqual(second);
    expect(artifactComparisonResultSchema.parse(first)).toMatchObject({
      status: "changed",
      summary: { added: 1, changed: 2, unknown: 0 },
      changes: { limit: 1, total: 3, next_offset: 1 },
    });
    expect(first.changes.items[0]?.evidence_links).toEqual([
      left.evidence_id,
      right.evidence_id,
    ]);
    const all = compareArtifacts(left, right, 0, 500);
    expect(all.changes.items).toEqual(
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
    const incomplete = await observe(root, { nodeLimit: 1 });
    const comparison = compareArtifacts(incomplete, incomplete, 0, 100);
    expect(comparison).toMatchObject({
      status: "truncated",
      summary: { unchanged: 0, unknown: 2 },
    });
    expect(comparison.limitations).toContain(
      "Left artifact inventory is incomplete.",
    );
  });

  it("assembles bounded page sets for graphs larger than one page", async () => {
    const root = await createTestTempDirectory("rea-artifact-pages-");
    await Promise.all(
      Array.from({ length: 501 }, async (_, index) =>
        writeFile(
          join(root, `file-${String(index).padStart(3, "0")}.txt`),
          String(index),
        ),
      ),
    );
    const pages = await Promise.all([
      observe(root),
      observe(root, {
        nodeOffset: 500,
        occurrenceOffset: 500,
        edgeOffset: 500,
      }),
    ]);
    expect(compareArtifacts(pages, pages, 0, 100)).toMatchObject({
      status: "unchanged",
      summary: { unchanged: 502, unknown: 0 },
      changes: { total: 0 },
    });
  }, 15_000);

  it("rejects non-inventory and tampered Evidence", async () => {
    const root = await createTestTempDirectory("rea-artifact-invalid-");
    const evidence = await observe(root);
    expect(() =>
      compareArtifacts(
        { ...evidence, operation: "binary_overview" },
        evidence,
        0,
        10,
      ),
    ).toThrow(/identifier/u);
    const wrongOperation = createEvidence(undefined, PROVIDER, {
      operation: "binary_overview",
      parameters: {},
      result: evidence.normalized_result,
    });
    expect(() => compareArtifacts(wrongOperation, evidence, 0, 10)).toThrow(
      /inventory_artifact/u,
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
    expect(() => compareArtifacts(mismatchedSubject, evidence, 0, 10)).toThrow(
      /root digest/u,
    );
  });
});
