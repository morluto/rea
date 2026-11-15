import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePreviewPng } from "./raw-raster-png-test-helper.mjs";
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
  if (!result.ok) throw result.error;
  const { png, manifest } = result.value;
  assert.deepEqual(decodePreviewPng(png), {
    width: 1,
    height: 1,
    rgba: [1, 2, 3, 255],
  });
  const brokenChecksum = Buffer.from(png);
  brokenChecksum[29] ^= 1;
  assert.throws(() => decodePreviewPng(brokenChecksum), /checksum/);
  assert.throws(() => decodePreviewPng(png.subarray(0, png.length - 12)));
  assert.throws(
    () => decodePreviewPng(Buffer.concat([png, Buffer.from([0])])),
    /truncated PNG chunk/,
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
    const decoded = decodePreviewPng(before);
    assert.equal(decoded.width, 2);
    assert.equal(decoded.height, 2);
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

test("combined PNG memory admission counts more than RGBA and accepts raised budgets", async () => {
  const { admitPreview } = await import("./raw-raster-preview.mjs");
  const input = {
    offset: 0,
    length: 1024 * 1024,
    width: 1024,
    height: 1024,
    stride: 1024,
    format: "gray8",
    rowOrder: "top-down",
  };
  assert.equal(
    admitPreview(input.length, input, { maxMemoryMiB: 8 }).ok,
    false,
  );
  assert.equal(
    admitPreview(input.length, input, { maxMemoryMiB: 64 }).ok,
    true,
  );
  assert.equal(
    admitPreview(input.length, input, { maxMemoryMiB: 0 }).ok,
    false,
  );
  assert.equal(
    admitPreview(input.length, input, { maxMemoryMiB: 513 }).ok,
    false,
  );
});
test("writer rejects invalid JSON before creating output", async () => {
  const { writePreviewResult } = await import("./raw-raster-preview.mjs");
  const { stat } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "rea-raster-cleanup-"));
  const out = join(root, "result");
  try {
    await assert.rejects(
      writePreviewResult(
        { png: Buffer.from("png"), manifest: { bad: 1n } },
        out,
      ),
    );
    await assert.rejects(stat(out), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("writer marks failed writes incomplete and reports their directory", async () => {
  const { writePreviewResult } = await import("./raw-raster-preview.mjs");
  const root = await mkdtemp(join(tmpdir(), "rea-raster-retained-"));
  const out = join(root, "result");
  try {
    await assert.rejects(
      writePreviewResult({ png: 42, manifest: {} }, out),
      /Incomplete output retained/,
    );
    assert.match(
      await readFile(join(out, ".incomplete"), "utf8"),
      /incomplete/,
    );
    await assert.rejects(
      writePreviewResult({ png: Buffer.from("png"), manifest: {} }, out),
      { code: "EEXIST" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an I/O failure leaves the incomplete marker and reports its path", async () => {
  const { writePreviewResult } = await import("./raw-raster-preview.mjs");
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const root = await mkdtemp(join(tmpdir(), "rea-raster-io-"));
  const out = join(root, "result");
  const original = fs.writeFile;
  fs.writeFile = async function (path, ...args) {
    if (path === join(out, "manifest.json"))
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      writePreviewResult({ png: Buffer.from("png"), manifest: {} }, out),
      /Incomplete output retained.*disk full/,
    );
    assert.equal(await readFile(join(out, "preview.png"), "utf8"), "png");
    assert.match(
      await readFile(join(out, ".incomplete"), "utf8"),
      /incomplete/,
    );
  } finally {
    fs.writeFile = original;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
