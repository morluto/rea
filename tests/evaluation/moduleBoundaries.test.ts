import { spawnSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

describe("incremental module import boundaries", () => {
  it.each([
    ["src/domain/probe.ts", "../application/Workflow.js", false],
    ["src/domain/probe.ts", "../browser/Provider.js", false],
    ["src/contracts/probe.ts", "../android/Provider.js", false],
    ["src/contracts/probe.ts", "../cli.js", false],
    ["src/contracts/probe.ts", "../composition/android.js", false],
    ["src/domain/probe.test.ts", "../composition/firmware.js", false],
    ["src/application/probe.ts", "../android/JadxProvider.js", false],
    ["src/application/probe.ts", "../composition/android.js", false],
    ["src/server/probe.ts", "../firmware/FirmwareProvider.js", false],
    ["src/domain/probe.ts", "./result.js", true],
    ["src/contracts/probe.ts", "../domain/result.js", true],
    ["src/application/probe.ts", "../domain/result.js", true],
    ["src/composition/probe.ts", "../ghidra/Provider.js", true],
    ["src/composition/probe.ts", "../android/JadxProvider.js", true],
    ["src/composition/probe.ts", "../firmware/FirmwareProvider.js", true],
  ])("checks %s importing %s", async (file, dependency, allowed) => {
    const temporary = await createTestTempDirectory("rea-module-boundary-");
    const config = join(temporary, ".oxlintrc.json");
    await copyFile(resolve(".oxlintrc.json"), config);
    const fixture = join(temporary, file);
    await mkdir(dirname(fixture), { recursive: true });
    await writeFile(
      fixture,
      `import { value } from ${JSON.stringify(dependency)}; export { value };\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("node_modules/oxlint/bin/oxlint"),
        "-c",
        config,
        "--format",
        "json",
        file,
      ],
      { cwd: temporary, encoding: "utf8" },
    );
    if (result.error !== undefined) throw result.error;
    expect(result.status).toBe(allowed ? 0 : 1);
    if (!allowed) expect(result.stdout).toContain("no-restricted-imports");
  });
});
