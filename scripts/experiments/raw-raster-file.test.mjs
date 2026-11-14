import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  open,
  readdir,
  readlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { previewRawRasterFile, writeFilePreview } from "./raw-raster-file.mjs";
const layout = {
  offset: 1,
  length: 4,
  width: 1,
  height: 1,
  stride: 3,
  format: "rgb888",
  rowOrder: "top-down",
};
async function withSource(fn) {
  const root = await mkdtemp(join(tmpdir(), "rea-raster-file-"));
  const path = join(root, "source.bin");
  const bytes = Buffer.from([99, 1, 2, 3, 42, 88]);
  await writeFile(path, bytes);
  try {
    await fn({ root, path, bytes });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("reads a selected extent, preserves actual file offset and source bytes", async () =>
  withSource(async ({ root, path, bytes }) => {
    const output = join(root, "preview");
    await writeFilePreview(path, layout, output);
    const manifest = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    );
    assert.deepEqual(manifest.sourceRange, {
      offset: 1,
      length: 4,
      sha256: createHash("sha256").update(bytes.subarray(1, 5)).digest("hex"),
    });
    assert.equal(manifest.sourceSnapshot.size, 6);
    assert.equal(manifest.sourcePath, path);
    assert.deepEqual(await readFile(path), bytes);
    await assert.rejects(writeFilePreview(path, layout, output), {
      code: "EEXIST",
    });
    assert.deepEqual(await readFile(path), bytes);
  }));
test("a large file with a small explicit range is admitted without loading it all", async () =>
  withSource(async ({ path }) => {
    const file = await open(path, "r+");
    try {
      await file.truncate(128 * 1024 * 1024);
    } finally {
      await file.close();
    }
    const result = await previewRawRasterFile(path, layout);
    assert.equal(result.manifest.sourceSnapshot.size, 128 * 1024 * 1024);
    assert.equal(result.manifest.sourceRange.offset, 1);
  }));
test("rejects invalid, truncated and oversized layouts before creating output", async () =>
  withSource(async ({ root, path }) => {
    for (const [i, patch] of [
      { width: 0 },
      { length: 7 },
      { width: 1000000 },
      { length: 1048577 },
    ].entries()) {
      const output = join(root, `bad-${i}`);
      await assert.rejects(
        writeFilePreview(path, { ...layout, ...patch }, output),
      );
      await assert.rejects(stat(output), { code: "ENOENT" });
    }
    await assert.rejects(previewRawRasterFile(root, layout));
  }));
test(
  "closes source descriptors after successful and rejected requests",
  { skip: process.platform !== "linux" },
  async () =>
    withSource(async ({ path }) => {
      async function descriptors() {
        const names = await readdir("/proc/self/fd");
        return (
          await Promise.all(
            names.map(
              async (name) =>
                (await readlink(`/proc/self/fd/${name}`).catch(() => "")) ===
                path,
            ),
          )
        ).filter(Boolean).length;
      }
      assert.equal(await descriptors(), 0);
      await previewRawRasterFile(path, layout);
      assert.equal(await descriptors(), 0);
      await assert.rejects(previewRawRasterFile(path, { ...layout, width: 0 }));
      assert.equal(await descriptors(), 0);
    }),
);

test("rejects source changes and truncation during reading before output", async () =>
  withSource(async ({ root, path, bytes }) => {
    const { ArtifactFileSource } =
      await import("../../src/artifacts/ArtifactFileSource.ts");
    const original = ArtifactFileSource.prototype.readSelectedPath;
    for (const mutation of ["truncate", "change"]) {
      await writeFile(path, bytes);
      let reads = 0;
      ArtifactFileSource.prototype.readSelectedPath = async function (...args) {
        reads++;
        if (mutation === "change" && reads === 2)
          await writeFile(path, Buffer.from([99, 9, 8, 7, 42, 88]));
        const admitted = await original.apply(this, args);
        if (mutation === "truncate" && reads === 1)
          await writeFile(path, Buffer.from([99]));
        return admitted;
      };
      try {
        const output = join(root, mutation);
        await assert.rejects(writeFilePreview(path, layout, output));
        await assert.rejects(stat(output), { code: "ENOENT" });
      } finally {
        ArtifactFileSource.prototype.readSelectedPath = original;
      }
    }
  }));

test("real-file command accepts explicit layout JSON and exports PNG", async () =>
  withSource(async ({ root, path }) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const json = join(root, "layout.json");
    const output = join(root, "cli");
    await writeFile(json, JSON.stringify(layout));
    await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      "scripts/experiments/raw-raster-file.mjs",
      path,
      json,
      output,
    ]);
    assert.equal(
      JSON.parse(await readFile(join(output, "manifest.json"), "utf8"))
        .sourceRange.offset,
      1,
    );
    assert.deepEqual(
      [...(await readFile(join(output, "preview.png"))).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
  }));

test(
  "rejects a selected leaf symlink",
  { skip: process.platform === "win32" },
  async () =>
    withSource(async ({ root, path }) => {
      const { symlink } = await import("node:fs/promises");
      const link = join(root, "link.bin");
      await symlink(path, link);
      await assert.rejects(previewRawRasterFile(link, layout));
    }),
);

test("CLI help and usage errors are concise without stack traces", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const command = [
    "--import",
    "tsx",
    "scripts/experiments/raw-raster-file.mjs",
  ];
  const help = await execute(process.execPath, [...command, "--help"]);
  assert.match(help.stdout, /--max-memory-mib/);
  assert.match(help.stdout, /not a process RSS limit/);
  for (const args of [[], ["--max-memory-mib", "nope"], ["--unknown"]]) {
    await assert.rejects(
      execute(process.execPath, [...command, ...args]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Raster preview:/);
        assert.doesNotMatch(error.stderr, /\n\s+at /);
        return true;
      },
    );
  }
});
test("file budget is configurable before reading and default accepts over old 1MiB cap", async () =>
  withSource(async ({ root, path }) => {
    const file = await open(path, "r+");
    try {
      await file.truncate(1024 * 1024);
    } finally {
      await file.close();
    }
    const input = {
      offset: 0,
      length: 1024 * 1024,
      width: 1024,
      height: 1024,
      stride: 1024,
      format: "gray8",
      rowOrder: "top-down",
    };
    await assert.rejects(
      previewRawRasterFile(path, input, { maxMemoryMiB: 8 }),
      /Estimated PNG working buffers/,
    );
    const preview = await previewRawRasterFile(path, input);
    assert.equal(preview.manifest.memory.maxMemoryMiB, 64);
    assert.ok(preview.manifest.memory.estimatedWorkingBytes > 8 * 1024 * 1024);
    const out = join(root, "too-small");
    await assert.rejects(
      writeFilePreview(path, input, out, { maxMemoryMiB: 8 }),
    );
    await assert.rejects(stat(out), { code: "ENOENT" });
  }));
