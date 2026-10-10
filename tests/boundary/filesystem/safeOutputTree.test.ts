import { createHash } from "node:crypto";
import {
  access,
  chmod,
  readFile,
  readdir,
  readlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";

describe("safe artifact output tree", () => {
  it.skipIf(process.platform !== "linux")(
    "closes the parent descriptor when the output disappears before commit",
    async () => {
      const parent = await createTestTempDirectory("rea-safe-output-");
      const output = join(parent, "published");
      const tree = await SafeOutputTree.create(output);
      await rm(output, { recursive: true });
      await expect(tree.commit()).rejects.toThrow();
      const targets = await Promise.all(
        (await readdir("/proc/self/fd")).map((fd) =>
          readlink(`/proc/self/fd/${fd}`).catch(() => undefined),
        ),
      );
      expect(targets.filter((target) => target === parent)).toEqual([]);
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    },
  );
  it("removes only its owned tree after digest failure and proves absence", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-");
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output);
    await expect(
      tree.write("nested/file.txt", Readable.from(Buffer.from("unexpected")), {
        sha256: "0".repeat(64),
        bytes: Buffer.byteLength("unexpected"),
      }),
    ).rejects.toThrow(/disagrees/u);
    expect(await tree.rollback()).toMatchObject({
      status: "complete",
      residualPaths: [],
    });
    await expect(access(output)).rejects.toThrow();
    expect(await readdir(parent)).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports the owned residual root when rollback lacks directory permissions",
    async () => {
      const parent = await createTestTempDirectory("rea-safe-output-rollback-");
      const output = join(parent, "published");
      const tree = await SafeOutputTree.create(output);
      const bytes = Buffer.from("retained until rollback can retry");
      await tree.write("nested/file.txt", Readable.from(bytes), {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
      });
      try {
        await chmod(output, 0o500);
        const failure = await tree.rollback().catch((cause: unknown) => cause);
        expect(failure).toBeInstanceOf(ArtifactReaderFailure);
        expect(failure).toMatchObject({
          cleanup: { resources: [output] },
        });
      } finally {
        await chmod(output, 0o700).catch(() => undefined);
        await tree.rollback();
      }
    },
  );

  it("publishes files while building and preserves them after sealing", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-");
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output);
    const bytes = Buffer.from("visible before seal");
    const digest = createHash("sha256").update(bytes).digest("hex");

    await tree.write("file.txt", Readable.from(bytes), {
      sha256: digest,
      bytes: bytes.byteLength,
    });
    expect(await readFile(join(output, "file.txt"), "utf8")).toBe(
      "visible before seal",
    );

    await tree.commit();
    expect(await tree.rollback()).toEqual({ status: "not-required" });
    expect(await readFile(join(output, "file.txt"), "utf8")).toBe(
      "visible before seal",
    );
  });

  it("returns detached cleanup reports", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-");
    const tree = await SafeOutputTree.create(join(parent, "published"));
    const cleanup = await tree.rollback();
    if (cleanup.status !== "complete") throw new Error("expected cleanup");
    (cleanup.residualPaths as unknown as string[]).push("/forged/path");

    expect(tree.cleanup).toEqual({ status: "complete", residualPaths: [] });
    expect(await tree.rollback()).toEqual({
      status: "complete",
      residualPaths: [],
    });
  });

  it("publishes without POSIX-only directory chmod or fsync on Windows", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-");
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output, "win32");
    const bytes = Buffer.from("windows output");
    const digest = createHash("sha256").update(bytes).digest("hex");

    await tree.write("nested/file.txt", Readable.from(bytes), {
      sha256: digest,
      bytes: bytes.byteLength,
    });
    await tree.commit();
    expect(await readFile(join(output, "nested", "file.txt"), "utf8")).toBe(
      "windows output",
    );
  });

  it.each([
    "hello.txt:hidden",
    "nested/hello.txt::$DATA",
    "folder:stream/file.txt",
  ])("refuses Windows stream syntax before creating %s", async (path) => {
    const parent = await createTestTempDirectory("rea-safe-output-stream-");
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output, "win32");
    const bytes = Buffer.from("regular file content");
    const source = Readable.from(bytes);
    try {
      await expect(
        tree.write(path, source, {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
        }),
      ).rejects.toMatchObject({
        reason: "path",
        message: `Windows destination cannot materialize artifact path as a regular file: ${path}; ':' denotes alternate data stream syntax. Inventory retains the logical name.`,
      });
      expect(source.destroyed).toBe(true);
      // A rejected stream name must not leave even its empty base file or parents.
      expect(await readdir(output)).toEqual([]);
    } finally {
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    }
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(parent)).toEqual([]);
  });
});
