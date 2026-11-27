import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { execFileOutput } from "../../../src/process/ExecFileOutput.js";
import { withoutSearchPermission } from "../../fixtures/permissionDenial.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { copyScriptsWithImports } from "../../support/scriptImportClosure.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

it("preserves caller labels and recognizable ownership in both shared factories", async () => {
  for (const prefix of ["reference-unicode-", "rea-example-", "bb-session-"]) {
    const expected = prefix === "reference-unicode-" ? `rea-${prefix}` : prefix;
    const directory = await createTestTempDirectory(prefix);
    expect(basename(directory).startsWith(expected)).toBe(true);
    const workspace = await createTestWorkspace(prefix);
    try {
      expect(basename(workspace.root).startsWith(expected)).toBe(true);
    } finally {
      await removeTestWorkspace(workspace.root);
    }
  }
});

it.skipIf(process.platform === "win32").each(["return", "throw"] as const)(
  "restores a fixture directory's mode when its callback ends with %s",
  async (ending) => {
    const directory = await createTestTempDirectory("rea-permission-restore-");
    await chmod(directory, 0o1751);
    const marker = new Error("fixture callback");
    const pending = withoutSearchPermission(directory, async () => {
      expect((await stat(directory)).mode & 0o7777).toBe(0);
      if (ending === "throw") throw marker;
      return marker;
    });
    if (ending === "throw") await expect(pending).rejects.toBe(marker);
    else await expect(pending).resolves.toBe(marker);
    expect((await stat(directory)).mode & 0o7777).toBe(0o1751);
  },
);

it.each(["clean", "file", "directory", "cache", "symlink", "failed-test"])(
  "verifies shared fixture ownership with a %s producer",
  async (scenario) => {
    const root = await createTestTempDirectory("rea-test-hygiene-boundary-");
    await mkdir(join(root, "node_modules/vitest"), { recursive: true });
    await copyScriptsWithImports(
      ["scripts/verify-test-temp-hygiene.mjs"],
      root,
    );
    await mkdir(join(root, "external"));
    await writeFile(join(root, "external", "evidence"), "preserved");
    const workspaceModule = pathToFileURL(
      join(process.cwd(), "tests/support/workspace/workspaceFixture.ts"),
    ).href;
    // The real shared factory produces the fixture. A stand-in runner controls
    // its cleanup outcome and a foreign cache without running a nested suite.
    await writeFile(
      join(root, "node_modules/vitest/vitest.mjs"),
      `import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestWorkspace, removeTestWorkspace } from ${JSON.stringify(workspaceModule)};
await writeFile("temporary-root.txt", tmpdir());
const { root } = await createTestWorkspace("reference-unicode-");
await writeFile("owned-root.txt", root);
const scenario = ${JSON.stringify(scenario)};
if (["clean", "file", "cache", "symlink"].includes(scenario)) await removeTestWorkspace(root);
if (scenario === "file") await writeFile(root, "retained");
if (scenario === "cache") await mkdir(join(tmpdir(), "tsx-fixture-cache"));
if (scenario === "symlink")
  await symlink(join(process.cwd(), "external"), root, process.platform === "win32" ? "junction" : "dir");
if (scenario === "failed-test") process.exitCode = 7;
`,
    );
    const result = execFileOutput(
      process.execPath,
      ["scripts/verify-test-temp-hygiene.mjs"],
      {
        cwd: root,
        stopSignal: "SIGTERM",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
    if (["clean", "cache"].includes(scenario))
      await expect(result).resolves.toMatchObject({
        stdout: expect.stringContaining("no owned residues remain"),
      });
    else
      await expect(result).rejects.toMatchObject({
        code: 1,
        stderr:
          scenario === "failed-test"
            ? expect.stringMatching(/status 7[\s\S]*rea-reference-unicode-/u)
            : expect.stringContaining("rea-reference-unicode-"),
      });
    const ownedRoot = await readFile(join(root, "owned-root.txt"), "utf8");
    expect(basename(ownedRoot).startsWith("rea-reference-unicode-")).toBe(true);
    const temporaryRoot = await readFile(
      join(root, "temporary-root.txt"),
      "utf8",
    );
    await expect(stat(temporaryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "external", "evidence"), "utf8")).toBe(
      "preserved",
    );
  },
);
