import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const runner = resolve("scripts/run-development-tests.mjs");

describe("development test runner", () => {
  it("rejects nonexistent explicit paths instead of returning a zero-test success", async () => {
    await expect(
      execute(process.execPath, [
        runner,
        "focused",
        "src/missing.test.ts",
        "--dry-run",
      ]),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("reports actionable remediation when the comparison base is unavailable", async () => {
    await expect(
      execute(process.execPath, [
        runner,
        "changed",
        "--base",
        "missing-test-base",
        "--dry-run",
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "Fetch origin/main or pass --base REVISION",
      ),
    });
  });

  it("runs a committed branch regression through real Git and Vitest without dist", async () => {
    const root = await createTestTempDirectory("rea-development-tests-");
    await mkdir(join(root, "src"));
    await symlink(
      resolve("node_modules"),
      join(root, "node_modules"),
      "junction",
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(join(root, ".gitignore"), "node_modules\n");
    await writeFile(
      join(root, "vitest.config.ts"),
      `export default { test: { projects: [{ test: { name: "domain", include: ["src/**/*.test.ts"] } }] } };`,
    );
    await writeFile(join(root, "src/value.ts"), "export const value = 1;\n");
    await writeFile(
      join(root, "src/value.test.ts"),
      `import { it, expect } from "vitest"; import { value } from "./value"; it("checks current source", () => expect(value).toBe(1));\n`,
    );
    const git = (arguments_: string[]) =>
      execute("git", arguments_, { cwd: root });
    await git(["init", "-b", "main"]);
    await git(["add", ".gitignore", "package.json", "vitest.config.ts", "src"]);
    const commit = [
      "-c",
      "user.name=REA fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "fixture",
    ];
    await git(commit);
    const { stdout: baseline } = await git(["rev-parse", "HEAD"]);
    await git(["update-ref", "refs/remotes/origin/main", baseline.trim()]);
    await git(["switch", "-c", "regression"]);
    await writeFile(join(root, "src/value.ts"), "export const value = 2;\n");
    await writeFile(
      join(root, "src/value.test.ts"),
      `import { it, expect } from "vitest"; import { value } from "./value"; it("checks current source", () => expect(value).toBe(2));\n`,
    );
    await git(["add", "src"]);
    await git(commit);
    expect((await git(["status", "--porcelain"])).stdout).toBe("");
    const { stdout } = await execute(process.execPath, [runner, "changed"], {
      cwd: root,
    });
    expect(stdout).toContain("1 passed");
    const explicit = await execute(
      process.execPath,
      [runner, "focused", "src/value.test.ts"],
      { cwd: root },
    );
    expect(explicit.stdout).toContain("1 passed");
  }, 30_000);
});
