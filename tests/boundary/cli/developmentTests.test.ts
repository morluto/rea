import {
  copyFile,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { execFileOutput } from "../../../src/process/ExecFileOutput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const run = (root: string, command: string, arguments_: readonly string[]) =>
  execFileOutput(command, arguments_, {
    cwd: root,
    stopSignal: "SIGTERM",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });

const git = (root: string, ...arguments_: string[]) =>
  run(root, "git", arguments_);

const commit = (root: string, message: string) =>
  git(
    root,
    "-c",
    "user.name=REA fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--quiet",
    "-m",
    message,
  );

const fixture = async () => {
  const root = await createTestTempDirectory("rea-development-tests-");
  await mkdir(join(root, "scripts", "lib"), { recursive: true });
  await mkdir(join(root, "src"));
  for (const path of [
    "scripts/run-development-tests.mjs",
    "scripts/lib/development-tests.mjs",
  ])
    await copyFile(join(process.cwd(), path), join(root, path));
  await symlink(
    join(process.cwd(), "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : undefined,
  );
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, ".gitignore"), "node_modules\nselected.txt\n");
  await writeFile(
    join(root, "vitest.config.mjs"),
    'export default { test: { projects: [{ test: { name: "domain", include: ["src/**/*.test.ts"] } }] } };\n',
  );
  await writeFile(join(root, "src/value.ts"), "export const value = 1;\n");
  await writeFile(
    join(root, "src/value.test.ts"),
    'import { expect, it } from "vitest"; import { writeFileSync } from "node:fs"; import { value } from "./value.js"; it("checks the selected source", () => { expect(value).toBe(1); writeFileSync("selected.txt", String(value)); });\n',
  );
  await git(root, "init", "--quiet", "-b", "main");
  await git(root, "add", ".");
  await commit(root, "fixture");
  return root;
};

const testCommand = (root: string, ...arguments_: string[]) =>
  run(root, process.execPath, [
    "scripts/run-development-tests.mjs",
    ...arguments_,
  ]);

describe("development test runner public CLI", () => {
  it("runs an explicitly selected source test on a clean tree without build artifacts", async () => {
    const root = await fixture();
    const { stdout: status } = await git(root, "status", "--porcelain");
    expect(status).toBe("");
    await testCommand(root, "local", "src/value.test.ts");
    expect(await readFile(join(root, "selected.txt"), "utf8")).toBe("1");
  });

  it("plans an exact local test without building", async () => {
    const root = await fixture();
    const { stdout } = await testCommand(
      root,
      "local",
      "src/value.test.ts",
      "--dry-run",
    );
    expect(JSON.parse(stdout)).toMatchObject({
      needsBuild: false,
      artifactTasks: [],
      vitestArguments: expect.arrayContaining([
        "run",
        "--project",
        "domain",
        "--project",
        "services",
        "--project",
        "adapters",
        "--project",
        "composition",
        "--project",
        "conformance",
        "--project",
        "evaluation",
        "src/value.test.ts",
      ]),
    });
  });

  it("uses committed dependency changes to select source tests and reports failures", async () => {
    const root = await fixture();
    const { stdout: base } = await git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "src/value.ts"), "export const value = 2;\n");
    await git(root, "add", "src/value.ts");
    await commit(root, "change dependency");
    await expect(
      testCommand(root, "changed", "--base", base.trim()),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("src/value.test.ts"),
      stderr: expect.stringContaining("expected 2 to be 1"),
    });
  });

  it("runs changed and focused tests from a committed branch regression", async () => {
    const root = await fixture();
    const { stdout: baseline } = await git(root, "rev-parse", "HEAD");
    await git(root, "update-ref", "refs/remotes/origin/main", baseline.trim());
    await git(root, "switch", "--quiet", "-c", "regression");
    await writeFile(join(root, "src/value.ts"), "export const value = 2;\n");
    await writeFile(
      join(root, "src/value.test.ts"),
      'import { expect, it } from "vitest"; import { value } from "./value.js"; it("checks current source", () => expect(value).toBe(2));\n',
    );
    await git(root, "add", "src");
    await commit(root, "regression fix");
    expect((await git(root, "status", "--porcelain")).stdout).toBe("");

    const changed = await testCommand(root, "changed");
    expect(changed.stdout).toContain("1 passed");
    const focused = await testCommand(root, "focused", "src/value.test.ts");
    expect(focused.stdout).toContain("1 passed");
  }, 60_000);

  it("reports a missing comparison base and rejects missing or compiled-boundary paths", async () => {
    const root = await fixture();
    await expect(
      testCommand(root, "changed", "--base", "missing-test-base", "--dry-run"),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "Fetch origin/main or pass --base REVISION",
      ),
    });
    await expect(
      testCommand(root, "focused", "src/missing.test.ts"),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ENOENT"),
    });
    await expect(
      testCommand(root, "local", "tests/acceptance/runtime.test.ts"),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Use test:focused"),
    });
  });
});
