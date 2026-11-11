import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
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

processTest.skipIf(hostLabel === undefined)(
  "enforces workflow platform labels before contacting Cutter",
  { timeout: Math.min(2_147_483_647, 2 * preparationBudget + 30_000) },
  async ({ processes }) => {
    const workflow = parse(
      await readFile(".github/workflows/real-cutter.yml", "utf8"),
    );
    const labels = workflow.jobs["cutter-upstream"].strategy.matrix.include.map(
      (entry: { platform: string }) => entry.platform,
    );
    expect(labels).toEqual(["linux", "macOS", "Windows"]);
    const root = await createTestTempDirectory("rea-cutter-platform-");
    // A private absent directory proves actual discovery without contacting a user's bridge.
    const bridgeDirectory = join(root, "absent-bridge");
    const check = async (selected: string | undefined) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TMPDIR: root,
        TMP: root,
        TEMP: root,
        REA_CUTTER_BRIDGE_DIR: bridgeDirectory,
      };
      if (selected === undefined) delete env.EXPECTED_PLATFORM;
      else env.EXPECTED_PLATFORM = selected;
      const result = await processes.run(
        process.execPath,
        ["scripts/verify-real-cutter.mjs"],
        {
          env,
          timeoutMs: Math.min(2_147_483_647, preparationBudget + 15_000),
        },
      );
      expect(result.exitCode, result.stderr).toBe(1);
      return result.stderr;
    };
    for (const selected of [hostLabel, undefined]) {
      const stderr = await check(selected);
      expect(stderr).toContain("Open upstream Cutter with the REA plugin");
      expect(stderr).toContain("no_live_bridge_found");
    }
    const other = labels.find((label: string) => label !== hostLabel);
    expect(other).toBeDefined();
    expect(await check(other)).toContain(
      "Cutter runner did not match its declared platform",
    );
    expect(await check("unknown")).toContain(
      "Unrecognized Cutter runner platform",
    );
    expect(
      (await readdir(root)).filter((name) =>
        name.startsWith("rea-cutter-smoke-"),
      ),
    ).toEqual([]);
  },
);
