import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { seededLockFiles } from "./DesktopBuildBundle.js";

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "keeps lock inspection failures separate from empty and partially examined seeds",
  async () => {
    const root = await createTestTempDirectory("rea-seeded-locks-");
    expect(await seededLockFiles(root)).toEqual({ locks: [], unreadable: [] });
    const envs = join(root, "envs");
    const denied = join(envs, "denied", "seed");
    const available = join(envs, "available", "seed");
    await mkdir(denied, { recursive: true });
    await mkdir(available, { recursive: true });
    await writeFile(join(available, "SingletonLock"), "controlled lock");
    await chmod(denied, 0);
    try {
      const found = await seededLockFiles(root);
      expect(found.locks).toEqual(["envs/available/seed/SingletonLock"]);
      expect(found.unreadable).toEqual([
        { path: denied, reason: expect.stringContaining("EACCES") },
      ]);
    } finally {
      await chmod(denied, 0o700);
    }
    await chmod(envs, 0);
    try {
      expect(await seededLockFiles(root)).toEqual({
        locks: [],
        unreadable: [{ path: envs, reason: expect.stringContaining("EACCES") }],
      });
    } finally {
      await chmod(envs, 0o700);
    }
  },
);
