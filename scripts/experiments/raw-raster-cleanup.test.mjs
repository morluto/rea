import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactFileSource } from "../../src/resources/index.ts";
import { previewRawRasterFile, runFilePreviewCli } from "./raw-raster-file.mjs";

const layout = {
  offset: 0,
  length: 1,
  width: 1,
  height: 1,
  stride: 1,
  format: "gray8",
  rowOrder: "top-down",
};
for (const scenario of [
  "successful raster",
  "invalid raster",
  "invalid layout JSON",
]) {
  test(`retains cleanup authority and primary failure for ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-raster-close-"));
    const path = join(root, "source.bin");
    const json = join(root, "layout.json");
    await writeFile(path, Buffer.from([42]));
    await writeFile(json, "{invalid JSON");
    const original = ArtifactFileSource.prototype.close;
    const retained = new Set();
    const closeFailure = new Error("injected descriptor close failure");
    ArtifactFileSource.prototype.close = async function () {
      retained.add(this);
      throw closeFailure;
    };
    let failure;
    try {
      try {
        if (scenario === "invalid layout JSON")
          await runFilePreviewCli([path, json, join(root, "output")]);
        else
          await previewRawRasterFile(
            path,
            scenario === "invalid raster" ? { ...layout, width: 0 } : layout,
          );
      } catch (error) {
        failure = scenario === "invalid layout JSON" ? error.cause : error;
      }
      assert.ok(failure, "cleanup failure must not be reported as success");
      assert.equal(
        failure.cleanupLeases?.length,
        1,
        "caller must retain failed source cleanup authority",
      );
      if (scenario === "invalid raster")
        assert.match(failure.message, /dimensions.*positive sizes/i);
      if (scenario === "invalid layout JSON")
        assert.match(failure.message, /JSON|property/i);
      assert.match(failure.cleanup.reason, /injected descriptor close failure/);
      await assert.rejects(
        failure.cleanupLeases[0].release(),
        /injected descriptor close failure/,
      );
      assert.equal(failure.cleanupLeases[0].released, false);
      ArtifactFileSource.prototype.close = original;
      await failure.cleanupLeases[0].release();
      assert.equal(failure.cleanupLeases[0].released, true);
      await failure.cleanupLeases[0].release();
    } finally {
      ArtifactFileSource.prototype.close = original;
      for (const source of retained) await source.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
