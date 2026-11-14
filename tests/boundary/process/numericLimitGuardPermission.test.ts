import { chmod, copyFile, mkdir, rename, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

processTest.skipIf(
  process.platform === "win32" ||
    (typeof process.getuid === "function" && process.getuid() === 0),
)(
  "fails the numeric limit guard when a required scan directory is unreadable",
  async ({ processes }) => {
    const root = await createTestTempDirectory("rea-limit-permission-");
    await mkdir(join(root, "scripts/verify"), { recursive: true });
    await mkdir(join(root, "tests/nested"), { recursive: true });
    for (const name of ["src", ".agents", "node_modules", "bridge"])
      await symlink(resolve(name), join(root, name), "dir");
    await symlink(
      resolve("scripts/hopper-demo-x11.py"),
      join(root, "scripts/hopper-demo-x11.py"),
    );
    await symlink(
      resolve("tests/boundary"),
      join(root, "tests/boundary"),
      "dir",
    );
    await copyFile(
      "scripts/verify/rea-numeric-limits.mjs",
      join(root, "scripts/verify/rea-numeric-limits.mjs"),
    );
    const run = () =>
      processes.run(
        process.execPath,
        ["scripts/verify/rea-numeric-limits.mjs"],
        { cwd: root },
      );
    const healthy = await run();
    expect(healthy.exitCode, healthy.stderr).toBe(0);
    for (const directory of [join(root, "tests"), join(root, "tests/nested")]) {
      try {
        await chmod(directory, 0);
        const refused = await run();
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stderr).toContain("EACCES");
        expect(refused.stderr).toContain(directory);
      } finally {
        await chmod(directory, 0o755);
      }
    }
    await rename(join(root, "tests"), join(root, "tests-saved"));
    try {
      const missing = await run();
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr).toContain("ENOENT");
      expect(missing.stderr).toContain(join(root, "tests"));
    } finally {
      await rename(join(root, "tests-saved"), join(root, "tests"));
    }
  },
);
