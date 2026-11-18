import {
  chmod,
  copyFile,
  mkdir,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
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
    const root = await realpath(
      await createTestTempDirectory("rea-limit-permission-"),
    );
    const source = join(root, "src");
    const nested = join(source, "nested");
    await mkdir(join(root, "scripts/verify"), { recursive: true });
    await mkdir(join(source, "domain"), { recursive: true });
    await mkdir(join(source, "resources"));
    await mkdir(nested);
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    await writeFile(
      join(source, "domain/analysisSettingDefinitions.ts"),
      'export const ANALYSIS_SETTINGS = { fixture: { environment: "REA_PERMISSION_LIMIT", updateMode: "runtime" } };',
    );
    await writeFile(
      join(source, "domain/numericLimitRegistry.ts"),
      "export const NUMERIC_LIMIT_REGISTRY = [];",
    );
    await writeFile(
      join(nested, "limit.ts"),
      "export const limit = Number(process.env.REA_PERMISSION_LIMIT);",
    );
    for (const owner of [
      "domain/artifactReaderLimits.ts",
      "domain/webNetworkCapture.ts",
      "resources/ArtifactReaderLimits.ts",
    ]) {
      await writeFile(
        join(source, owner),
        'export const limit = { update_mode: "parameter" };',
      );
    }
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
    expect(healthy.stdout).toContain("1 discovered.");
    for (const directory of [source, nested]) {
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
    const saved = join(root, "src-saved");
    await rename(source, saved);
    try {
      const missing = await run();
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr).toContain("ENOENT");
      expect(missing.stderr).toContain(source);
    } finally {
      await rename(saved, source);
    }
  },
);
