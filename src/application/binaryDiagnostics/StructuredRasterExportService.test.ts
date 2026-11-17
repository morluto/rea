import * as rendering from "./RasterResourceRendering.js";
import { access, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { structuredRasterFixture } from "../../../tests/fixtures/structuredRaster.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import { StructuredRasterExportService } from "./StructuredRasterExportService.js";
import { structuredRasterExportResultSchema } from "../../domain/native/structuredRasterExport.js";
import {
  ArtifactResourceScope,
  SafeOutputTree,
} from "../../resources/index.js";
const fixture = async () => {
  const root = await createTestTempDirectory("rea-export-recovery-");
  const path = join(root, "source"),
    output_directory = join(root, "output"),
    bytes = structuredRasterFixture();
  await writeFile(path, bytes);
  return {
    root,
    path,
    output_directory,
    bytes,
    expected_sha256: sha256Hex(bytes),
  };
};
const args = (f: Awaited<ReturnType<typeof fixture>>) => ({
  path: f.path,
  expected_sha256: f.expected_sha256,
  output_directory: f.output_directory,
});
it("exports exact RAW and independently decoded full PNG, hashes, mapping and omission provenance", async () => {
  const f = await fixture(),
    s = new StructuredRasterExportService();
  try {
    const result = await s.export(args(f));
    if (!result.ok) throw result.error;
    const receipt = structuredRasterExportResultSchema.parse(
      result.value.normalized_result,
    );
    expect(receipt.exported).toBe(12);
    expect(result.value.parameters).toEqual(args(f));
    expect(receipt.resolved_controls).toMatchObject({
      ambiguity: "skip",
      formats: ["raw", "png"],
      length: f.bytes.length,
    });
    const manifestBytes = await readFile(
      join(f.output_directory, "manifest.json"),
    );
    expect(sha256Hex(manifestBytes)).toBe(receipt.manifest.sha256);
    const manifest = JSON.parse(manifestBytes.toString());
    expect(manifest.resources).toHaveLength(12);
    expect(manifest.segmentsReference).toEqual(receipt.segments);
    const first = manifest.resources[0];
    const raw = await readFile(
      join(f.output_directory, first.files.raw.relativePath),
    );
    expect(
      raw.equals(
        f.bytes.subarray(
          first.payload.offset,
          first.payload.offset + first.payload.length,
        ),
      ),
    ).toBe(true);
    const png = await readFile(
      join(f.output_directory, first.files.png.relativePath),
    );
    expect(sha256Hex(png)).toBe(first.files.png.sha256);
    expect(png.readUInt32BE(16)).toBe(9);
    expect(png.readUInt32BE(20)).toBe(8);
    const idat: Buffer[] = [];
    for (let at = 8; at < png.length;) {
      const n = png.readUInt32BE(at);
      if (png.toString("ascii", at + 4, at + 8) === "IDAT")
        idat.push(png.subarray(at + 8, at + 8 + n));
      at += n + 12;
    }
    const pixels = inflateSync(Buffer.concat(idat));
    for (let y = 0; y < 8; y++) {
      expect(pixels[y * 37]).toBe(0);
      for (let x = 0; x < 9; x++) {
        const bit = (raw[y * 2 + Math.floor(x / 8)]! >> (7 - (x % 8))) & 1;
        expect([
          ...pixels.subarray(y * 37 + 1 + x * 4, y * 37 + 5 + x * 4),
        ]).toEqual([bit * 255, bit * 255, bit * 255, 255]);
      }
    }
    for (const [key] of Object.entries(receipt.resolved_controls)) {
      if (["registry_selection", "selections"].includes(key)) continue;
      const controls = { ...receipt.resolved_controls };
      delete (controls as Record<string, unknown>)[key];
      expect(
        structuredRasterExportResultSchema.safeParse({
          ...receipt,
          resolved_controls: controls,
        }).success,
        key,
      ).toBe(false);
    }
  } finally {
    await s.close();
  }
});
it("verifies expected SHA before output creation", async () => {
  const f = await fixture(),
    s = new StructuredRasterExportService();
  try {
    expect(
      (await s.export({ ...args(f), expected_sha256: "0".repeat(64) })).ok,
    ).toBe(false);
    await expect(access(f.output_directory)).rejects.toThrow();
  } finally {
    await s.close();
  }
});
it.each([false, true])(
  "preserves existing or linked destination (%s)",
  async (linked) => {
    const f = await fixture(),
      s = new StructuredRasterExportService(),
      target = join(f.root, "keep");
    await mkdir(target);
    await writeFile(join(target, "data"), "unchanged");
    if (linked)
      await symlink(
        target,
        f.output_directory,
        process.platform === "win32" ? "junction" : "dir",
      );
    try {
      expect(
        (
          await s.export({
            ...args(f),
            output_directory: linked ? f.output_directory : target,
          })
        ).ok,
      ).toBe(false);
      expect(await readFile(join(target, "data"), "utf8")).toBe("unchanged");
    } finally {
      await s.close();
    }
  },
);
it("shared scope retries retained publication rollback and closes without recursion", async () => {
  const f = await fixture(),
    shared = new ArtifactResourceScope(),
    s = new StructuredRasterExportService(undefined, shared);
  const rollback = SafeOutputTree.prototype.rollback;
  let blocked = true;
  const writer = vi
    .spyOn(SafeOutputTree.prototype, "write")
    .mockRejectedValue(Error("write failed"));
  const closer = vi
    .spyOn(SafeOutputTree.prototype, "rollback")
    .mockImplementation(async function (this: SafeOutputTree) {
      if (blocked) throw Error("cleanup blocked");
      return rollback.call(this);
    });
  try {
    const result = await s.export(args(f));
    expect(result.ok).toBe(false);
    if (result.ok) throw Error("expected refusal");
    expect(result.error.cleanupIncomplete).toBe(true);
    await expect(shared.close()).rejects.toThrow();
    blocked = false;
    await shared.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    await expect(access(f.output_directory)).rejects.toThrow();
  } finally {
    blocked = false;
    writer.mockRestore();
    await shared.close();
    closer.mockRestore();
  }
});
it("keeps published receipt despite cancellation after commit", async () => {
  const f = await fixture(),
    s = new StructuredRasterExportService(),
    controller = new AbortController(),
    commit = SafeOutputTree.prototype.commit;
  const spy = vi
    .spyOn(SafeOutputTree.prototype, "commit")
    .mockImplementation(async function (this: SafeOutputTree, signal) {
      await commit.call(this, signal);
      controller.abort(Error("late cancellation"));
    });
  try {
    const result = await s.export(args(f), { signal: controller.signal });
    expect(result.ok).toBe(true);
    await access(join(f.output_directory, "manifest.json"));
  } finally {
    spy.mockRestore();
    await s.close();
  }
});
it("honors pre-aborted admission before reporting malformed input", async () => {
  const s = new StructuredRasterExportService(),
    controller = new AbortController();
  controller.abort(Error("stop before admission"));
  try {
    const result = await s.export({}, { signal: controller.signal });
    expect(result.ok).toBe(false);
    if (result.ok) throw Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
  } finally {
    await s.close();
  }
});

it("refuses renderer allocation ceilings before output creation", async () => {
  const f = await fixture(),
    s = new StructuredRasterExportService();
  const preflight = vi
    .spyOn(rendering, "preflightRasterResource")
    .mockReturnValue({
      status: "limit-exceeded",
      reason: "Decoded raster output pixels",
      limit: {
        name: "Decoded raster output pixels",
        maximum: 4194304,
        unit: "pixels",
      },
    });
  const create = vi.spyOn(SafeOutputTree, "create");
  try {
    const result = await s.export(args(f));
    expect(result.ok).toBe(false);
    expect(preflight).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await expect(access(f.output_directory)).rejects.toThrow();
  } finally {
    preflight.mockRestore();
    create.mockRestore();
    await s.close();
  }
});

it("retains the admitted source identity when export decoding fails before publication", async () => {
  const f = await fixture();
  const s = new StructuredRasterExportService();
  try {
    const result = await s.export({ ...args(f), profile: "fgs-records" });
    if (result.ok) throw Error("Expected malformed FGS failure");
    expect(result.error.partialObservation).toEqual({
      kind: "file-snapshot-hash",
      path: f.path,
      bytes: f.bytes.length,
      sha256: f.expected_sha256,
    });
    await expect(access(f.output_directory)).rejects.toThrow();
  } finally {
    await s.close();
  }
});
