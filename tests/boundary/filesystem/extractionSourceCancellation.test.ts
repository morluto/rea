import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { materializeArtifactInventoryInScope } from "../../../src/artifacts/extraction/ArtifactExtraction.js";
import { scanArtifactInventory } from "../../fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([false, true])(
  "preserves a changed extraction source with concurrent abort=%s",
  async (cancel) => {
    const root = await createTestTempDirectory("rea-extract-source-failure-");
    const parent = join(root, "parent");
    const source = join(parent, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "file"), "content");
    const snapshot = await scanArtifactInventory(source);
    await rename(parent, join(root, "previous"));
    await writeFile(parent, "not a directory");
    const scope = new ArtifactResourceScope();
    const controller = new AbortController();
    try {
      const operation = materializeArtifactInventoryInScope(
        {
          inputPath: source,
          inputFormat: "mach-o",
          outputRoot: join(root, "out"),
          environment: {},
          integrityPolicy: "fail",
          resourceScope: scope,
        },
        source,
        snapshot,
        controller.signal,
      );
      if (cancel) queueMicrotask(() => controller.abort("caller stopped"));
      await expect(operation).rejects.toMatchObject({
        reason: "integrity",
        cause: { code: "ENOTDIR" },
      });
    } finally {
      await scope.close();
    }
  },
);

it("preserves cancellation after a successful source lookup", async () => {
  const root = await createTestTempDirectory("rea-extract-source-cancel-");
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "file"), "content");
  const snapshot = await scanArtifactInventory(source);
  const scope = new ArtifactResourceScope();
  const controller = new AbortController();
  const reason = { caller: "stop" };
  try {
    const operation = materializeArtifactInventoryInScope(
      {
        inputPath: source,
        inputFormat: "mach-o",
        outputRoot: join(root, "out"),
        environment: {},
        integrityPolicy: "fail",
        resourceScope: scope,
      },
      source,
      snapshot,
      controller.signal,
    );
    queueMicrotask(() => controller.abort(reason));
    await expect(operation).rejects.toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
  } finally {
    await scope.close();
  }
});
