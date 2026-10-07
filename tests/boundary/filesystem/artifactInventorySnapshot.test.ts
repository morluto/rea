import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { scanArtifactInventory } from "../../../src/artifacts/inventory/ArtifactInventory.js";

describe("artifact inventory snapshot", () => {
  it("retains the complete scan after the source directory changes", async () => {
    const root = await createTestTempDirectory("rea-inventory-snapshot-");
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    const snapshot = await scanArtifactInventory(root);

    await rm(join(root, "b.txt"));
    expect(snapshot.occurrences.map(({ logical_path: path }) => path)).toEqual([
      ".",
      "a.txt",
      "b.txt",
    ]);
    expect(snapshot.manifest.occurrence_count).toBe(3);
  });
});
