import {
  copyFile,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { execFileOutput } from "../../../src/process/ExecFileOutput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const run = (root: string, command: string, arguments_: readonly string[]) =>
  execFileOutput(command, arguments_, {
    cwd: root,
    stopSignal: "SIGTERM",
    timeout: 20_000,
  });

const commit = (root: string, message: string) =>
  run(root, "git", [
    "-c",
    "user.name=REA fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);

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
  await writeFile(join(root, "src", "value.ts"), "export const value = 1;\n");
  await writeFile(
    join(root, "src", "value.test.ts"),
    'import { expect, it } from "vitest"; import { writeFileSync } from "node:fs"; import { value } from "./value.js"; it("checks the selected source", () => { expect(value).toBe(1); writeFileSync("selected.txt", String(value)); });\n',
  );
  await run(root, "git", ["init", "--quiet"]);
  await run(root, "git", ["add", "."]);
  await commit(root, "fixture");
  return root;
};

const testCommand = (root: string, ...arguments_: string[]) =>
  run(root, process.execPath, [
    "scripts/run-development-tests.mjs",
    ...arguments_,
  ]);

it("executes an explicitly selected source test on a clean tree without build artifacts", async () => {
  const root = await fixture();
  const { stdout: status } = await run(root, "git", ["status", "--porcelain"]);
  expect(status).toBe("");
  await testCommand(root, "local", "src/value.test.ts");
  expect(await readFile(join(root, "selected.txt"), "utf8")).toBe("1");
});

it("uses committed dependency changes since the requested Git base to select source tests", async () => {
  const root = await fixture();
  const { stdout: base } = await run(root, "git", ["rev-parse", "HEAD"]);
  await writeFile(join(root, "src", "value.ts"), "export const value = 2;\n");
  await run(root, "git", ["add", "src/value.ts"]);
  await commit(root, "change dependency");
  await expect(
    testCommand(root, "changed", "--base", base.trim()),
  ).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining("src/value.test.ts"),
    stderr: expect.stringContaining("expected 2 to be 1"),
  });
});

it("rejects a compiled boundary in the source-only command and a missing exact test", async () => {
  const root = await fixture();
  await expect(
    testCommand(root, "local", "tests/acceptance/runtime.test.ts"),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Use test:focused"),
  });
  await expect(
    testCommand(root, "local", "src/missing.test.ts"),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("ENOENT"),
  });
});
