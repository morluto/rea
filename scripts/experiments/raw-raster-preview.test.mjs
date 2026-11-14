import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { test } from "node:test";
import {
  previewRawRasterExperiment,
  writeSyntheticPreview,
} from "./raw-raster-preview.mjs";

const layout = {
  offset: 1,
  length: 4,
  width: 1,
  height: 1,
  stride: 3,
  format: "rgb888",
  rowOrder: "top-down",
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("PNG stores RGBA8 pixels and manifest hashes the full selected range", () => {
  const source = Uint8Array.from([99, 1, 2, 3, 42, 88]);
  const result = previewRawRasterExperiment(source, layout);
  assert.equal(result.ok, true);
  const { png, manifest } = result.value;
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1);
  assert.equal(png.readUInt32BE(20), 1);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
  const idatLength = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString(), "IDAT");
  assert.deepEqual(
    [...inflateSync(png.subarray(41, 41 + idatLength))],
    [0, 1, 2, 3, 255],
  );
  assert.equal(manifest.sourceRange.sha256, sha256(source.subarray(1, 5)));
  assert.equal(manifest.output.sha256, sha256(png));
  assert.equal(manifest.decoding.consumedSpan, 3);
  assert.match(manifest.identityStatus, /Not a REA artifact/);
  assert.deepEqual(source, Uint8Array.from([99, 1, 2, 3, 42, 88]));
});
test("invalid layouts return the core failure instead of exporting", () => {
  assert.equal(previewRawRasterExperiment(new Uint8Array(1), layout).ok, false);
});
test("demo writes synthetic PNG and manifest without clobbering an existing directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-raster-preview-"));
  const out = join(root, "result");
  try {
    await writeSyntheticPreview(out);
    const before = await readFile(join(out, "preview.png"));
    assert.equal(
      JSON.parse(await readFile(join(out, "manifest.json"), "utf8")).decoding
        .width,
      2,
    );
    await assert.rejects(writeSyntheticPreview(out), { code: "EEXIST" });
    assert.deepEqual(await readFile(join(out, "preview.png")), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
