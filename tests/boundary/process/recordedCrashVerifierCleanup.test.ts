import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  processTest,
  type TestProcesses,
} from "../../support/process/processFixture.js";

const preload = fileURLToPath(
  new URL("../../fixtures/recordedCrashVerifierPreload.mjs", import.meta.url),
);
const script = fileURLToPath(
  new URL("../../../scripts/verify-recorded-crash.mjs", import.meta.url),
);

const reportSchema = z.object({
  status: z.enum(["passed", "failed"]),
  retained_root: z.string().nullable(),
  verifier: z.object({
    process_lineage: z.object({ status: z.string() }),
  }),
});

/** Run the real verifier with authored owners; only its ownership handling is observed. */
const runScenario = async (processes: TestProcesses, scenario: string) => {
  const root = await createTestTempDirectory("rea-core-verifier-cleanup-");
  const temporary = join(root, "temporary");
  await mkdir(temporary);
  const log = join(root, "events.log");
  const authored = join(root, "authored-absent-tool");
  const result = await processes.run(
    process.execPath,
    ["--import", preload, script],
    {
      env: {
        ...process.env,
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
        REA_PWNTOOLS_PYTHON: authored,
        REA_PWNDBG_GDB: authored,
        REA_PWNDBG_GDBINIT: authored,
        REA_PWNDBG_VENV_PATH: authored,
        REA_VERIFY_STRACE_COMMAND: authored,
        REA_CORE_TEST_EVENTS: log,
        REA_CORE_TEST_SCENARIO: scenario,
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
  expect(result.exitCode, result.stderr).toBe(1);
  return {
    ...result,
    report: reportSchema.parse(JSON.parse(result.stdout)),
    events: recorded.map((line) => line.split(" ")[0]),
    fixtureRoot,
    rootRetained: fixtureRoot !== undefined && existsSync(fixtureRoot),
  };
};

const ownersClosed = ["client-close", "transport-close", "sentinel-close"];

processTest(
  "releases the root after a prerequisite failure acquired no owner",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "prerequisite-unavailable");
    expect(outcome.stderr).toContain("prerequisite unavailable: gcc");
    expect(outcome.stderr).toContain("authored gcc absence");
    expect(outcome.events).toEqual([
      "root-create",
      "lineage-observe",
      "root-close",
    ]);
    expect(outcome.report).toMatchObject({
      status: "failed",
      retained_root: null,
    });
    expect(outcome.rootRetained).toBe(false);
  },
);

processTest(
  "releases the root only after its owners closed and lineage was verified",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "owners-released");
    expect(outcome.stderr).toContain("authored CLI failure");
    expect(outcome.stderr).not.toContain("retained fixture root");
    expect(outcome.events).toEqual([
      "root-create",
      ...ownersClosed,
      "lineage-observe",
      "root-close",
    ]);
    expect(outcome.report).toMatchObject({
      status: "failed",
      retained_root: null,
      verifier: { process_lineage: { status: "verified" } },
    });
    expect(outcome.rootRetained).toBe(false);
  },
);

processTest.for(["client", "transport", "sentinel"])(
  "retains the root and the other owners' closes when the %s close is refused",
  async (owner, { processes }) => {
    const outcome = await runScenario(processes, `${owner}-close-refused`);
    expect(outcome.stderr).toContain("authored CLI failure");
    expect(outcome.stderr).toContain(`authored ${owner} close failure`);
    expect(outcome.stderr).toContain("retained fixture root");
    // Lineage is still observed for the report, after every owner and
    // without releasing the root.
    expect(outcome.events).toEqual([
      "root-create",
      ...ownersClosed,
      "lineage-observe",
    ]);
    expect(outcome.report).toMatchObject({
      status: "failed",
      retained_root: outcome.fixtureRoot,
    });
    expect(outcome.rootRetained).toBe(true);
  },
);

processTest(
  "retains the root when owned process lineage cannot be verified",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "lineage-unverified");
    expect(outcome.stderr).toContain("authored lineage unavailability");
    expect(outcome.stderr).toContain("retained fixture root");
    expect(outcome.events).toEqual([
      "root-create",
      ...ownersClosed,
      "lineage-observe",
    ]);
    expect(outcome.report).toMatchObject({
      status: "failed",
      retained_root: outcome.fixtureRoot,
      verifier: { process_lineage: { status: "unavailable" } },
    });
    expect(outcome.rootRetained).toBe(true);
  },
);

processTest(
  "closes a session whose connection failed before releasing the root",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "connect-refused");
    expect(outcome.stderr).toContain("authored connection failure");
    expect(outcome.stderr).not.toContain("retained fixture root");
    // The session is owned before it connects, so its owners still close.
    expect(outcome.events).toEqual([
      "root-create",
      ...ownersClosed,
      "lineage-observe",
      "root-close",
    ]);
    expect(outcome.report).toMatchObject({
      status: "failed",
      retained_root: null,
    });
    expect(outcome.rootRetained).toBe(false);
  },
);

processTest(
  "retains the root when a failed connection's transport close is refused",
  async ({ processes }) => {
    const outcome = await runScenario(processes, "connect-and-close-refused");
    expect(outcome.stderr).toContain("authored connection failure");
    expect(outcome.stderr).toContain("authored transport close failure");
    expect(outcome.stderr).toContain("retained fixture root");
    expect(outcome.events).toEqual([
      "root-create",
      ...ownersClosed,
      "lineage-observe",
    ]);
    expect(outcome.report).toMatchObject({
      status: "failed",
      retained_root: outcome.fixtureRoot,
    });
    expect(outcome.rootRetained).toBe(true);
  },
);
