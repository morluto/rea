import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { SolveSandboxRoot } from "./SolveSandboxRoot.js";

it("joins overlapping cleanup requests for one owned root", async () => {
  const parent = await createTestTempDirectory("solve-root-overlap-");
  const python = execFileSync(
    "python3",
    ["-c", "import sys; print(sys.executable)"],
    { encoding: "utf8" },
  ).trim();
  const root = await SolveSandboxRoot.create(python, {
    ...process.env,
    AGENT_ENV_LOCAL_SANDBOX_DIR: parent,
  });
  const results = await Promise.all([root.stop(), root.stop()]);
  expect(results).toEqual([
    { status: "verified-cleanup" },
    { status: "verified-cleanup" },
  ]);
  expect(await readdir(parent)).toEqual([]);
});
