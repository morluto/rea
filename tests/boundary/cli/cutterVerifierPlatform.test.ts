import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { resolveSwiftcCompileTimeoutMs } from "../../../src/process/DarwinProcessRunTokenReader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

const hostLabels: Partial<Record<NodeJS.Platform, string>> = {
  linux: "linux",
  darwin: "macOS",
  win32: "Windows",
};
const hostLabel = hostLabels[process.platform];
const preparationBudget =
  process.platform === "darwin" ? resolveSwiftcCompileTimeoutMs() : 0;

it("declares the three supported platform labels in the Cutter workflow", async () => {
  const workflow = parse(
    await readFile(".github/workflows/real-cutter.yml", "utf8"),
  );
  const labels = workflow.jobs["cutter-upstream"].strategy.matrix.include.map(
    (entry: { platform: string }) => entry.platform,
  );
  expect(labels).toEqual(["linux", "macOS", "Windows"]);
});

processTest.skipIf(hostLabel === undefined).for([
  {
    mode: "matching",
    selected: hostLabel,
    diagnostic: "no_live_bridge_found",
  },
  {
    mode: "omitted",
    selected: undefined,
    diagnostic: "no_live_bridge_found",
  },
  {
    mode: "mismatched",
    selected: hostLabel === "linux" ? "macOS" : "linux",
    diagnostic: "Cutter runner did not match its declared platform",
  },
  {
    mode: "unknown",
    selected: "unknown",
    diagnostic: "Unrecognized Cutter runner platform",
  },
])(
  "checks the Cutter verifier when the label is $mode",
  { timeout: Math.min(2_147_483_647, preparationBudget + 30_000) },
  async ({ selected, diagnostic }, { processes }) => {
    const root = await createTestTempDirectory("rea-cutter-platform-");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      REA_CUTTER_BRIDGE_DIR: join(root, "absent-bridge"),
    };
    if (selected === undefined) delete env.EXPECTED_PLATFORM;
    else env.EXPECTED_PLATFORM = selected;
    const result = await processes.run(
      process.execPath,
      ["scripts/verify-real-cutter.mjs"],
      { env, timeoutMs: Math.min(2_147_483_647, preparationBudget + 15_000) },
    );
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain(diagnostic);
    if (diagnostic === "no_live_bridge_found")
      expect(result.stderr).toContain(
        "Open upstream Cutter with the REA plugin",
      );
    expect(
      (await readdir(root)).filter((name) =>
        name.startsWith("rea-cutter-smoke-"),
      ),
    ).toEqual([]);
  },
);
