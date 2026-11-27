import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  processTest,
  type TestProcesses,
} from "../support/process/processFixture.js";

const script = fileURLToPath(
  new URL("../../scripts/ci/require-provider-tests.mjs", import.meta.url),
);
const cleanupCases = [
  "capture",
  "tool",
  "limiter",
  "kernel",
  "field-tool",
  "field-limiter",
  "field-kernel",
].map(
  (item) =>
    `retains failed ${item} descriptors and retries them before further acquisition and shutdown`,
);
const commonLimits = [
  "enforces both address-space limits before any producer allocation",
  "preserves lower inherited file/CPU limits in the real launch",
];
const requiredCases = {
  packet: {
    "tests/boundary/captures/resourceLimits.test.ts": [
      ...commonLimits,
      "reports a real kernel file-limit termination with its effective ceiling",
    ],
    "tests/boundary/captures/captureDescriptorCleanup.test.ts": cleanupCases,
    "tests/acceptance/pcapVerifier.test.ts": [
      "verifies complete and unresolved HTTP coverage with real Wireshark tools",
    ],
  },
  signal: {
    "tests/boundary/signals/resourceLimits.test.ts": commonLimits,
    "tests/boundary/signals/recordingDescriptorCleanup.test.ts": cleanupCases,
  },
};
const report = (root: string, lane: keyof typeof requiredCases) => ({
  success: true,
  testResults: Object.entries(requiredCases[lane]).map(([path, names]) => ({
    name: resolve(root, path),
    status: "passed",
    assertionResults: names.map((fullName) => ({ fullName, status: "passed" })),
  })),
});

const checkReport = async (processes: TestProcesses) => {
  const cwd = await createTestTempDirectory("rea-required-cases-");
  const run = (lane: string, path = "report.json") =>
    processes.run(process.execPath, [script, lane, path], { cwd });
  return {
    cwd,
    run,
    check: async (lane: string, value: unknown) => {
      await writeFile(join(cwd, "report.json"), JSON.stringify(value));
      return run(lane);
    },
  };
};
const expectRefusal = (
  result: { exitCode: number | null; stderr: string },
  diagnostic: string | RegExp,
) => {
  expect(result.exitCode, result.stderr).toBe(1);
  expect(result.stderr).toMatch(diagnostic);
};

processTest.for(["packet", "signal"] as const)(
  "requires the %s resource and descriptor cases without banning unrelated skips",
  async (lane, { processes }) => {
    const { cwd, check } = await checkReport(processes);
    const passing = report(cwd, lane);
    const withUnrelatedSkip = structuredClone(passing);
    withUnrelatedSkip.testResults.push({
      name: resolve(cwd, "tests/unrelated.test.ts"),
      status: "passed",
      assertionResults: [{ fullName: "host-specific", status: "pending" }],
    });
    const result = await check(lane, withUnrelatedSkip);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("cases passed");

    for (const [index, file] of passing.testResults.entries()) {
      const removed = structuredClone(passing);
      const missing = removed.testResults[index]!.assertionResults.shift()!;
      const filePath = relative(cwd, file.name).replaceAll("\\", "/");
      expectRefusal(
        await check(lane, removed),
        `Required provider test did not pass: ${filePath}: ${missing.fullName}`,
      );
    }
    const first = passing.testResults[0]!;
    const withoutFile = structuredClone(passing);
    withoutFile.testResults.shift();
    const withDuplicateFile = structuredClone(passing);
    withDuplicateFile.testResults.push(first);
    for (const invalid of [withoutFile, withDuplicateFile])
      expectRefusal(
        await check(lane, invalid),
        "Expected exactly one provider test result",
      );

    const failedFile = structuredClone(passing);
    failedFile.testResults[0]!.status = "failed";
    expectRefusal(
      await check(lane, failedFile),
      "Required provider test file did not pass",
    );
  },
);

processTest(
  "rejects nonpassing and duplicate required assertions",
  async ({ processes }) => {
    const { cwd, check } = await checkReport(processes);
    const packet = report(cwd, "packet");
    for (const status of ["pending", "failed"]) {
      packet.testResults[0]!.assertionResults[0]!.status = status;
      expectRefusal(
        await check("packet", packet),
        "Required provider test did not pass",
      );
    }

    const signal = report(cwd, "signal");
    const assertions = signal.testResults[0]!.assertionResults;
    assertions.push(assertions[0]!);
    expectRefusal(
      await check("signal", signal),
      "Required provider test did not pass",
    );
  },
);

processTest(
  "rejects a report path outside the checkout",
  async ({ processes }) => {
    const { cwd, run } = await checkReport(processes);
    for (const path of ["../report.json", `${cwd}-outside/report.json`])
      expectRefusal(
        await run("packet", path),
        '{"code":"report_path_outside_checkout"}',
      );
  },
);

processTest(
  "rejects unknown lanes and missing or invalid reports",
  async ({ processes }) => {
    const { cwd, check, run } = await checkReport(processes);
    expectRefusal(await run("packet"), /ENOENT[^\n]*report\.json/u);
    expectRefusal(await run("other"), "Expected provider test lane");
    for (const invalid of [null, { ...report(cwd, "packet"), success: false }])
      expectRefusal(
        await check("packet", invalid),
        "missing a successful test inventory",
      );
  },
);

it.for([
  [
    "real-packet-capture.yml",
    "tshark",
    "packet",
    "tests/boundary/captures/resourceLimits.test.ts",
    "tests/boundary/captures/captureDescriptorCleanup.test.ts",
  ],
  [
    "real-signal-recording.yml",
    "sigrok",
    "signal",
    "tests/boundary/signals/resourceLimits.test.ts",
    "tests/boundary/signals/recordingDescriptorCleanup.test.ts",
  ],
] as const)(
  "keeps required case validation in %s",
  ([workflow, job, lane, limits, cleanup]) => {
    const file = new URL(
      `../../.github/workflows/${workflow}`,
      import.meta.url,
    );
    const parsed = z
      .object({
        jobs: z.record(
          z.string(),
          z.object({
            steps: z.array(z.object({ run: z.string().optional() })),
          }),
        ),
      })
      .parse(parse(readFileSync(file, "utf8")));
    const step = parsed.jobs[job]?.steps.find((item) =>
      item.run?.includes("scripts/ci/require-provider-tests.mjs"),
    );
    expect(step?.run).toContain('rm -f "$report"');
    expect(step?.run).toContain("node scripts/run-exact-tests.mjs run");
    expect(step?.run).toContain("--reporter=json");
    expect(step?.run).toContain('--outputFile.json="$report"');
    expect(step?.run).toContain(limits);
    expect(step?.run).toContain(cleanup);
    if (lane === "packet")
      expect(step?.run).toContain("tests/acceptance/pcapVerifier.test.ts");
    expect(step?.run).toContain(
      `node scripts/ci/require-provider-tests.mjs ${lane} "$report"`,
    );
  },
);
