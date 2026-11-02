import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  processTest,
  type TestProcesses,
} from "../../support/process/processFixture.js";

const preload = fileURLToPath(
  new URL("../../fixtures/signalVerifierPreload.mjs", import.meta.url),
);
const script = fileURLToPath(
  new URL("../../../scripts/verify-signal-recording.mjs", import.meta.url),
);

/** Run the real verifier with authored owners; only its cleanup ownership is observed. */
const runScenario = async (processes: TestProcesses, scenario: string) => {
  const root = await createTestTempDirectory("rea-signal-verifier-cleanup-");
  const temporary = join(root, "temporary");
  await mkdir(temporary);
  const log = join(root, "events.log");
  const result = await processes.run(
    process.execPath,
    ["--import", preload, script],
    {
      env: {
        ...process.env,
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
        REA_SIGROK_COMMAND: join(root, "authored-absent-sigrok-cli"),
        REA_SIGNAL_TEST_EVENTS: log,
        REA_SIGNAL_TEST_SCENARIO: scenario,
      },
      timeoutMs: 20_000,
    },
  );
  const recorded = await readFile(log, "utf8").then(
    (text) => text.split("\n").filter((line) => line !== ""),
    () => [],
  );
  const fixtureRoot = recorded
    .find((line) => line.startsWith("root-create "))
    ?.slice("root-create ".length);
  return {
    ...result,
    events: recorded.map((line) => line.split(" ")[0]),
    rootRetained: fixtureRoot !== undefined && existsSync(fixtureRoot),
  };
};

processTest(
  "acquires no fixture root before the inherited limits are readable",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "limits-unreadable");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("authored limits read failure");
    expect(outcome.events).toEqual([]);
  },
);

processTest(
  "releases the root only after its owners closed and lineage was verified",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "owners-released");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("authored connection failure");
    expect(outcome.stderr).not.toContain("retained fixture root");
    expect(outcome.events).toEqual([
      "root-create",
      "client-close",
      "transport-close",
      "lineage-observe",
      "root-close",
    ]);
    expect(outcome.rootRetained).toBe(false);
  },
);

processTest.for(["client", "transport"])(
  "retains the root and the other owner's close when the %s close is refused",
  async (owner, { processes }) => {
    const outcome = await runScenario(processes, `${owner}-close-refused`);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("authored connection failure");
    expect(outcome.stderr).toContain(`authored ${owner} close failure`);
    expect(outcome.stderr).toContain("retained fixture root");
    expect(outcome.events).toEqual([
      "root-create",
      "client-close",
      "transport-close",
    ]);
    expect(outcome.rootRetained).toBe(true);
  },
);

processTest(
  "retains the root when owned process lineage cannot be verified",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "lineage-unverified");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("authored lineage unavailability");
    expect(outcome.stderr).toContain("retained fixture root");
    expect(outcome.events).toEqual([
      "root-create",
      "client-close",
      "transport-close",
      "lineage-observe",
    ]);
    expect(outcome.rootRetained).toBe(true);
  },
);
