import { execFile } from "node:child_process";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { inventoryArtifact } from "../../../src/artifacts/inventory/ArtifactInventory.js";
import { classifyAndHashRoot } from "../../../src/artifacts/inventory/classify.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { readWithoutFifoWriter } from "../../fixtures/fifoInput.js";

it.skipIf(process.platform === "win32")(
  "rejects a FIFO artifact root without waiting for a writer",
  async () => {
    const root = await createTestTempDirectory("rea-artifact-root-fifo-");
    const fifoPath = join(root, "input.asar");
    await promisify(execFile)("mkfifo", [fifoPath]);

    const outcome = await readWithoutFifoWriter(fifoPath, () =>
      inventoryArtifact(fifoPath).then(
        () => undefined,
        (cause: unknown) => cause,
      ),
    );
    expect(outcome.state).toBe("completed");
    if (outcome.state !== "completed")
      throw new Error("Artifact inventory waited for a FIFO writer");
    expect(outcome.result).toMatchObject({
      reason: "format",
      message: `Artifact root is not a regular file: ${fifoPath}`,
    });
  },
);

it("rejects a root path replaced between its initial stat and open", async () => {
  const root = await createTestTempDirectory("rea-artifact-root-replaced-");
  const path = join(root, "input.bin");
  const replacement = join(root, "replacement.bin");
  await writeFile(path, "first bytes\n");
  const expectedMetadata = await lstat(path);
  await writeFile(replacement, "different bytes\n");
  await rm(path);
  await rename(replacement, path);

  await expect(
    classifyAndHashRoot(path, false, expectedMetadata),
  ).rejects.toMatchObject({
    reason: "integrity",
    message: `Root artifact changed before inventory: ${path}`,
  });
});
