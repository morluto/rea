import { createHash } from "node:crypto";
import { access, readFile, readdir, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";

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
      tree.write(
        "nested/file.txt",
        Readable.from(Buffer.from("unexpected")),
        "0".repeat(64),
      ),
    ).rejects.toThrow(/disagrees/u);
    expect(await tree.rollback()).toMatchObject({
      status: "complete",
      residualPaths: [],
    });
    await expect(access(output)).rejects.toThrow();
    expect(await readdir(parent)).toEqual([]);
  });

  it("publishes files while building and preserves them after sealing", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-");
    const output = join(parent, "published");
    const tree = await SafeOutputTree.create(output);
    const bytes = Buffer.from("visible before seal");
    const digest = createHash("sha256").update(bytes).digest("hex");

    await tree.write("file.txt", Readable.from(bytes), digest);
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

    await tree.write("nested/file.txt", Readable.from(bytes), digest);
    await tree.commit();
    expect(await readFile(join(output, "nested", "file.txt"), "utf8")).toBe(
      "windows output",
    );
  });
});
