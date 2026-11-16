import { createHash } from "node:crypto";
import { open, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { SelectedRasterSnapshotReader } from "./SelectedRasterSnapshotReader.js";

it("returns a bounded snapshot with whole-file hash after releasing source ownership", async () => {
  const root = await createTestTempDirectory("rea-raster-snapshot-");
  const path = join(root, "source");
  const bytes = Buffer.from([1, 2, 3, 4, 5]);
  await writeFile(path, bytes);
  let closed = false;
  const reader = new SelectedRasterSnapshotReader({
    stat,
    open: async (...args: Parameters<typeof open>) => {
      const file = await open(...args);
      const close = file.close.bind(file);
      Object.defineProperty(file, "close", {
        value: async () => {
          await close();
          closed = true;
        },
      });
      return file;
    },
  });
  try {
    const result = await reader.read(
      { path, offset: 1, length: 3 },
      "inspect_structured_raster_candidates",
      (snapshot) => snapshot,
    );
    if (!result.ok) throw result.error;
    expect(closed).toBe(true);
    expect([...result.value.bytes]).toEqual([2, 3, 4]);
    expect(result.value.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(result.value.window).toEqual({ offset: 1, length: 3 });
  } finally {
    await reader.close();
  }
});
