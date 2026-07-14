import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { scanAuthorizedArtifactInventory } from "../src/application/AuthorizedArtifactInventory.js";

const LIMITS = {
  maxEntries: 100,
  maxTotalBytes: 1024 * 1024,
  maxEntryBytes: 1024 * 1024,
  maxCompressionRatio: 100,
  maxDepth: 10,
  maxPathBytes: 1024,
} as const;

describe("authorized artifact inventory", () => {
  it("uses a valid input root when another configured root is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-artifact-roots-"));
    try {
      const path = join(root, "artifact.js");
      await writeFile(path, "export const value = 1;\n");
      const inventory = await scanAuthorizedArtifactInventory(
        path,
        [join(root, "missing"), root],
        LIMITS,
      );
      expect(inventory.manifest.root_format).toBe("javascript-bundle");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
