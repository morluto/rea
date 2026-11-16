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
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { previewRawRasterFile, writeFilePreview } from "./raw-raster-file.mjs";
import { decodePreviewPng } from "./raw-raster-png-test-helper.mjs";
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
    assert.equal(Object.hasOwn(manifest, "sourcePath"), false);
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

test("rejects source changes after reading before output", async () =>
  withSource(async ({ root, path }) => {
    const { ArtifactFileSource } = await import("../../src/resources/index.ts");
    const original = ArtifactFileSource.prototype.readSelectedPath;
    let rangeRead = false;
    ArtifactFileSource.prototype.readSelectedPath = async function (...args) {
      const admitted = await original.apply(this, args);
      const read = admitted.handle.read.bind(admitted.handle);
      admitted.handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        rangeRead = true;
        await writeFile(path, Buffer.from([99, 9, 8, 7, 42, 88]));
        return result;
      };
      return admitted;
    };
    try {
      const output = join(root, "changed");
      await assert.rejects(writeFilePreview(path, layout, output));
      assert.equal(rangeRead, true);
      await assert.rejects(stat(output), { code: "ENOENT" });
    } finally {
      ArtifactFileSource.prototype.readSelectedPath = original;
    }
  }));

test("rejects physical EOF at the selected-range read before output", async () =>
  withSource(async ({ root, path }) => {
    const { ArtifactFileSource } = await import("../../src/resources/index.ts");
    const original = ArtifactFileSource.prototype.readSelectedPath;
    let rangeRead = false;
    ArtifactFileSource.prototype.readSelectedPath = async function (...args) {
      const admitted = await original.apply(this, args);
      const read = admitted.handle.read.bind(admitted.handle);
      admitted.handle.read = async (...readArgs) => {
        rangeRead = true;
        assert.equal(readArgs[3], layout.offset);
        await writeFile(path, Buffer.from([99]));
        return read(...readArgs);
      };
      return admitted;
    };
    try {
      const output = join(root, "truncated");
      await assert.rejects(
        writeFilePreview(path, layout, output),
        /Selected raster range was truncated during reading/,
      );
      assert.equal(rangeRead, true);
      await assert.rejects(stat(output), { code: "ENOENT" });
    } finally {
      ArtifactFileSource.prototype.readSelectedPath = original;
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
      decodePreviewPng(await readFile(join(output, "preview.png"))),
      { width: 1, height: 1, rgba: [1, 2, 3, 255] },
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

test("records original relative spelling and canonical absolute selected path", async () =>
  withSource(async ({ root, path }) => {
    const alias = join(root, "alias");
    await symlink(
      root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const selected = relative(process.cwd(), join(alias, "source.bin"));
    const result = await previewRawRasterFile(selected, layout, {
      includeSourcePaths: true,
    });
    assert.equal(result.manifest.sourcePath, selected);
    assert.equal(result.manifest.sourceResolvedPath, await realpath(path));
  }));
test("preserves native file path component semantics", async () =>
  withSource(async ({ path, bytes }) => {
    const selected = `${path}/../source.bin`;
    // POSIX rejects traversing a regular file; Windows resolves dot segments
    // before opening it. Compare with native I/O, not a POSIX-only assumption.
    const native = await readFile(selected).then(
      (value) => ({ bytes: value }),
      (error) => ({ error }),
    );
    if (native.error) {
      assert.equal(native.error.code, "ENOTDIR");
      await assert.rejects(previewRawRasterFile(selected, layout));
    } else {
      assert.deepEqual(native.bytes, bytes);
      const result = await previewRawRasterFile(selected, layout, {
        includeSourcePaths: true,
      });
      const direct = await previewRawRasterFile(path, layout);
      assert.deepEqual(result.png, direct.png);
      assert.deepEqual(
        result.manifest.sourceRange,
        direct.manifest.sourceRange,
      );
      assert.equal(result.manifest.sourcePath, selected);
      assert.equal(result.manifest.sourceResolvedPath, await realpath(path));
    }
  }));

test("indexed4 file CLI preserves explicit palette, nibble order, alpha and range hash", async () =>
  withSource(async ({ root, path }) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const palette = Array.from({ length: 16 }, (_, i) => [
      i,
      255 - i,
      i * 10,
      i * 17,
    ]);
    const source = Buffer.from([99, 0x12, 0x3f, 42, 0x45, 0x6f]);
    await writeFile(path, source);
    const input = {
      offset: 1,
      length: 5,
      width: 3,
      height: 2,
      stride: 3,
      format: "indexed4",
      rowOrder: "bottom-up",
      bitOrder: "msb-first",
      palette,
    };
    const json = join(root, "indexed.json");
    const output = join(root, "indexed");
    await writeFile(json, JSON.stringify(input));
    await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      "scripts/experiments/raw-raster-file.mjs",
      path,
      json,
      output,
    ]);
    const manifest = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    );
    assert.deepEqual(manifest.decoding.palette, palette);
    assert.equal(manifest.decoding.bitOrder, "msb-first");
    assert.equal(manifest.sourceRange.offset, 1);
    assert.equal(
      manifest.sourceRange.sha256,
      createHash("sha256").update(source.subarray(1)).digest("hex"),
    );
    const png = await readFile(join(output, "preview.png"));
    assert.deepEqual(decodePreviewPng(png), {
      width: 3,
      height: 2,
      rgba: [4, 5, 6, 1, 2, 3].flatMap((i) => palette[i]),
    });
    assert.deepEqual(await readFile(path), source);
  }));

test("default manifest contains no personal path or filesystem identifiers", async () =>
  withSource(async ({ root, path }) => {
    const { rename } = await import("node:fs/promises");
    const personal = join(root, "Private-Person-Home-Image.bin");
    await rename(path, personal);
    for (const selected of [personal, relative(process.cwd(), personal)]) {
      const result = await previewRawRasterFile(selected, layout);
      const serialized = JSON.stringify(result.manifest);
      assert.ok(!serialized.includes("Private-Person-Home-Image"));
      assert.ok(!serialized.includes(root));
      assert.ok(!serialized.includes(selected));
      assert.deepEqual(Object.keys(result.manifest.sourceSnapshot).sort(), [
        "size",
        "stability",
      ]);
      assert.equal(Object.hasOwn(result.manifest, "sourcePath"), false);
      assert.equal(Object.hasOwn(result.manifest, "sourceResolvedPath"), false);
    }
    await assert.rejects(
      previewRawRasterFile(personal, layout, { includeSourcePaths: "true" }),
      /includeSourcePaths.*boolean/,
    );
  }));

test("CLI source paths require explicit opt-in and warn without echoing the private path", async () =>
  withSource(async ({ root, path }) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execute = promisify(execFile);
    const json = join(root, "layout.json");
    await writeFile(json, JSON.stringify(layout));
    const command = [
      "--import",
      "tsx",
      "scripts/experiments/raw-raster-file.mjs",
    ];
    for (const include of [false, true]) {
      const output = join(root, include ? "opt-in" : "private");
      const args = [
        ...command,
        ...(include ? ["--include-source-paths"] : []),
        path,
        json,
        output,
      ];
      const result = await execute(process.execPath, args);
      const manifest = JSON.parse(
        await readFile(join(output, "manifest.json"), "utf8"),
      );
      assert.equal(Object.hasOwn(manifest, "sourcePath"), include);
      assert.ok(!result.stdout.includes(path));
      assert.ok(!result.stderr.includes(path));
      if (include) assert.match(result.stderr, /Warning:.*paths.*sharing/);
      else assert.equal(result.stderr, "");
    }
    for (const flags of [
      ["--include-source-paths", "--include-source-paths"],
      ["--include-source-paths=false"],
      ["--include-source-paths", "false"],
    ]) {
      await assert.rejects(
        execute(process.execPath, [
          ...command,
          ...flags,
          path,
          json,
          join(root, "bad"),
        ]),
        (error) => error.code === 1,
      );
    }
  }));
