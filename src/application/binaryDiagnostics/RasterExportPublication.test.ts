import { access, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { createEvidence } from "../../domain/evidence.js";
import { REA_WORKFLOW_PROVIDER } from "../../domain/investigationProviders.js";
import { SafeOutputTree } from "../../resources/index.js";
import { RasterExportPublication } from "./RasterExportPublication.js";
const observation = (result: { value: number }) =>
  createEvidence(
    { path: "/synthetic-source", format: "file", sha256: "0".repeat(64) },
    REA_WORKFLOW_PROVIDER,
    {
      operation: "export_structured_raster_resources",
      parameters: {},
      result,
      rawResult: null,
      confidence: "inferred",
      limitations: [],
      locations: [],
    },
  );
it("publishes exclusive verified files and preserves existing output", async () => {
  const root = await createTestTempDirectory("rea-publication-");
  const output = join(root, "output");
  const p = new RasterExportPublication();
  try {
    const result = await p.publish(
      output,
      async (w) => {
        const receipt = await w.write("a.raw", Buffer.from([1, 2, 3]));
        expect(receipt.bytesWritten).toBe(3);
        return { value: 1 };
      },
      observation,
    );
    expect(result).toEqual({ value: 1 });
    expect(
      (await readFile(join(output, "a.raw"))).equals(Buffer.from([1, 2, 3])),
    ).toBe(true);
    await expect(
      p.publish(output, async () => ({ value: 2 }), observation),
    ).rejects.toThrow();
    expect(
      (await readFile(join(output, "a.raw"))).equals(Buffer.from([1, 2, 3])),
    ).toBe(true);
  } finally {
    await p.close();
  }
});
it("names the actual byte ceiling and rolls back earlier files", async () => {
  const root = await createTestTempDirectory("rea-publication-cap-");
  const output = join(root, "output");
  const p = new RasterExportPublication(undefined, 4);
  try {
    await expect(
      p.publish(
        output,
        async (w) => {
          await w.write("first", Buffer.alloc(3));
          await w.write("second", Buffer.alloc(2));
          return { value: 1 };
        },
        observation,
      ),
    ).rejects.toMatchObject({
      recovery: {
        retryable: false,
        fixedAllowance: { limit: 4, unit: "bytes" },
      },
    });
    await expect(access(output)).rejects.toThrow();
  } finally {
    await p.close();
  }
});
it("retains failed rollback until close retries it", async () => {
  const root = await createTestTempDirectory("rea-publication-retry-");
  const output = join(root, "output");
  const p = new RasterExportPublication();
  const original = SafeOutputTree.prototype.rollback;
  let blocked = true;
  const spy = vi
    .spyOn(SafeOutputTree.prototype, "rollback")
    .mockImplementation(async function (this: SafeOutputTree) {
      if (blocked) throw Error("blocked cleanup");
      return original.call(this);
    });
  try {
    await expect(
      p.publish(
        output,
        async (w) => {
          await w.write("partial", Buffer.from([1]));
          throw Error("production failure");
        },
        observation,
      ),
    ).rejects.toMatchObject({ cleanupIncomplete: true });
    await access(output);
    await expect(p.close()).rejects.toThrow();
    blocked = false;
    await p.close();
    await expect(access(output)).rejects.toThrow();
  } finally {
    blocked = false;
    await p.close();
    spy.mockRestore();
  }
});
it("preserves committed receipt after late commit cleanup failure", async () => {
  const root = await createTestTempDirectory("rea-publication-commit-");
  const output = join(root, "output");
  const p = new RasterExportPublication();
  const original = SafeOutputTree.prototype.commit;
  const spy = vi
    .spyOn(SafeOutputTree.prototype, "commit")
    .mockImplementation(async function (this: SafeOutputTree, signal) {
      await original.call(this, signal);
      throw Error("late close failure");
    });
  try {
    expect(
      await p.publish(
        output,
        async (w) => {
          await w.write("kept", Buffer.from([8]));
          return { value: 8 };
        },
        observation,
      ),
    ).toEqual({ value: 8 });
    expect(
      (await readFile(join(output, "kept"))).equals(Buffer.from([8])),
    ).toBe(true);
  } finally {
    spy.mockRestore();
    await p.close();
  }
});
it("refuses an existing directory without modifying caller data", async () => {
  const root = await createTestTempDirectory("rea-publication-existing-");
  const output = join(root, "existing");
  await mkdir(output);
  await writeFile(join(output, "keep"), "original");
  const p = new RasterExportPublication();
  try {
    await expect(
      p.publish(output, async () => ({ value: 1 }), observation),
    ).rejects.toThrow();
    expect(await readFile(join(output, "keep"), "utf8")).toBe("original");
  } finally {
    await p.close();
  }
});
