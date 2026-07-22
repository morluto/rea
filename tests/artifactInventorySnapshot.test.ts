import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import {
  paginateArtifactInventory,
  scanArtifactInventory,
} from "../src/application/ArtifactInventory.js";

const LIMITS = {
  maxEntries: 10,
  maxTotalBytes: 1_024,
  maxEntryBytes: 512,
  maxCompressionRatio: 10,
  maxDepth: 8,
  maxPathBytes: 256,
} as const;

describe("artifact inventory snapshot", () => {
  it("projects every page from the same completed scan", async () => {
    const root = await createTestTempDirectory("rea-inventory-snapshot-");
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    const snapshot = await scanArtifactInventory(root, LIMITS);

    await rm(join(root, "b.txt"));
    const first = paginateArtifactInventory(snapshot, {
      nodeOffset: 0,
      nodeLimit: 1,
      occurrenceOffset: 0,
      occurrenceLimit: 2,
      edgeOffset: 0,
      edgeLimit: 1,
    });
    const second = paginateArtifactInventory(snapshot, {
      nodeOffset: 1,
      nodeLimit: 10,
      occurrenceOffset: 2,
      occurrenceLimit: 2,
      edgeOffset: 1,
      edgeLimit: 10,
    });

    expect(first.manifest).toEqual(second.manifest);
    expect(
      [...first.occurrences.items, ...second.occurrences.items].map(
        ({ logical_path: path }) => path,
      ),
    ).toEqual([".", "a.txt", "b.txt"]);
    expect(first.occurrences.total).toBe(3);
    expect(second.occurrences.total).toBe(3);
  });
});
