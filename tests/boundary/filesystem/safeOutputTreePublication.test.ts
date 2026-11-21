import { createHash } from "node:crypto";
import { access, chmod, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, onTestFinished, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const observation = vi.hoisted(() => ({
  synced: [] as string[],
  refuseSync: undefined as string | undefined,
  forbiddenDirectories: new Set<string>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    open: async (...args: Parameters<typeof filesystem.open>) => {
      const path = String(args[0]);
      if (observation.forbiddenDirectories.has(path))
        throw new Error(
          "Directory descriptor operations are unavailable on Windows",
        );
      const handle = await filesystem.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (path === observation.refuseSync)
          throw new Error("controlled nested directory sync failure");
        await sync();
        observation.synced.push(path);
      };
      return handle;
    },
  };
});
import { SafeOutputTree } from "../../../src/resources/SafeOutputTree.js";

it.skipIf(process.platform === "win32")(
  "syncs nested directory entries before their parents and refuses publication when one cannot sync",
  async () => {
    const root = await createTestTempDirectory("rea-tree-directory-sync-");
    const bytes = Buffer.from("published bytes");
    for (const fail of [false, true]) {
      const output = join(root, fail ? "failed" : "success");
      const tree = await SafeOutputTree.create(output);
      try {
        await tree.write("a/b/payload.txt", Readable.from([bytes]), {
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        observation.synced.length = 0;
        observation.refuseSync = fail ? join(output, "a") : undefined;
        if (fail) {
          await expect(tree.commit()).rejects.toMatchObject({
            message: "Could not durably sync extraction output",
            cause: { message: "controlled nested directory sync failure" },
          });
          expect(tree.published).toBe(false);
          expect(observation.synced).toEqual([join(output, "a", "b")]);
          observation.refuseSync = undefined;
          expect(await tree.rollback()).toEqual({
            status: "complete",
            residualPaths: [],
          });
          await expect(access(output)).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else {
          const payload = join(output, "a", "b", "payload.txt");
          expect((await readFile(payload)).equals(bytes)).toBe(true);
          await tree.commit();
          expect(tree.published).toBe(true);
          expect(observation.synced).toEqual([
            join(output, "a", "b"),
            join(output, "a"),
            output,
            dirname(output),
          ]);
          expect(await tree.rollback()).toEqual({ status: "not-required" });
          expect((await readFile(payload)).equals(bytes)).toBe(true);
        }
      } finally {
        observation.refuseSync = undefined;
        await tree.closeHandles();
      }
    }
  },
);

it("keeps Windows output visible and sealed without opening directories", async () => {
  const parent = await createTestTempDirectory("rea-windows-output-");
  const output = join(parent, "published");
  const nested = join(output, "nested");
  const payload = join(nested, "payload.txt");
  for (const directory of [parent, output, nested])
    observation.forbiddenDirectories.add(directory);
  onTestFinished(() => observation.forbiddenDirectories.clear());

  const tree = await SafeOutputTree.create(output, "win32");
  onTestFinished(() => tree.closeHandles());
  const bytes = Buffer.from("Windows output");
  await tree.write("nested/payload.txt", Readable.from([bytes]), {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect((await readFile(payload)).equals(bytes)).toBe(true);
  await tree.commit();
  expect(await tree.rollback()).toEqual({ status: "not-required" });
  expect((await readFile(payload)).equals(bytes)).toBe(true);
});

it
  .skipIf(process.platform === "win32" || process.getuid?.() === 0)
  .each([false, true])(
  "resumes rollback after root removal denial without readmitting a closed file (failed write: %s)",
  async (failedWrite) => {
    const root = await createTestTempDirectory("rea-tree-removal-retry-");
    const output = join(root, "output");
    const tree = await SafeOutputTree.create(output);
    const bytes = Buffer.from("x");
    try {
      const write = tree.write("partial.txt", Readable.from([bytes]), {
        bytes: failedWrite ? 2 : 1,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      if (failedWrite)
        await expect(write).rejects.toMatchObject({ reason: "integrity" });
      else await write;
      await chmod(root, 0o500);
      await expect(tree.rollback()).rejects.toMatchObject({
        cause: { code: "EACCES", syscall: "rmdir" },
      });
      expect(await readdir(output)).toEqual([]);
      await chmod(root, 0o700);
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(root, 0o700);
      await tree.closeHandles();
      await rm(root, { recursive: true, force: true });
    }
  },
);
