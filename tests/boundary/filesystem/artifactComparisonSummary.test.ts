import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { inventoryArtifact } from "../../../src/application/ArtifactInventory.js";
import { compareArtifacts } from "../../../src/domain/artifactComparison.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const observe = async (path: string) => {
  const inventory = await inventoryArtifact(path);
  return createEvidence(
    {
      path,
      sha256: inventory.manifest.root_sha256,
      format: inventory.manifest.root_format,
    },
    { id: "rea-artifact-graph", name: "REA artifact graph", version: "1" },
    {
      operation: "inventory_artifact",
      parameters: {},
      result: jsonValueSchema.parse(inventory),
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
};

describe("artifact comparison summary", () => {
  it.each([
    { removed: 1, added: 1 },
    { removed: 0, added: 1 },
    { removed: 0, added: 0 },
  ])(
    "counts unchanged paths with $removed removals and $added additions",
    async ({ removed, added }) => {
      const root = await createTestTempDirectory("rea-artifact-summary-");
      const leftPath = join(root, "left");
      const rightPath = join(root, "right");
      await Promise.all([mkdir(leftPath), mkdir(rightPath)]);
      await Promise.all(
        [leftPath, rightPath].flatMap((path) =>
          ["same.txt", "duplicate.txt"].map((name) =>
            writeFile(join(path, name), "unchanged content"),
          ),
        ),
      );
      await Promise.all([
        ...Array.from({ length: removed }, (_, index) =>
          writeFile(join(leftPath, `removed-${index}.txt`), "old content"),
        ),
        ...Array.from({ length: added }, (_, index) =>
          writeFile(join(rightPath, `added-${index}.txt`), "new content"),
        ),
      ]);
      const [left, right] = await Promise.all([
        observe(leftPath),
        observe(rightPath),
      ]);
      const comparison = compareArtifacts(left, right);
      const changed = removed + added > 0 ? 1 : 0;

      expect(comparison.summary).toEqual({
        unchanged: 3 - changed,
        added,
        removed,
        changed,
        unknown: 0,
        contradiction: 0,
      });
      expect(comparison.changes).toHaveLength(removed + added + changed);
    },
  );
});
