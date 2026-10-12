import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { parseTestDurations } from "../../ciTestSequencer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const script = new URL("../../../scripts/ci/test-report.mjs", import.meta.url);
const stepsSchema = z.array(
  z.object({
    name: z.string().optional(),
    run: z.string().optional(),
    uses: z.string().optional(),
    if: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    with: z.record(z.string(), z.unknown()).optional(),
  }),
);
const workflow = async () =>
  z
    .object({
      jobs: z.object({
        test: z.object({ steps: stepsSchema }),
        build: z.object({ steps: stepsSchema }),
        docs: z.object({ steps: stepsSchema }),
        static: z.object({ steps: stepsSchema }),
      }),
    })
    .parse(
      parse(
        await readFile(
          new URL("../../../.github/workflows/ci.yml", import.meta.url),
          "utf8",
        ),
      ),
    ).jobs;

it("collects failed-shard diagnostics before enforcing the shard result", async () => {
  const steps = (await workflow()).test!.steps;
  const merge = steps.findIndex((step) => step.run?.includes("test:ci:merge"));
  const upload = steps.findIndex((step) => step.with?.name === "test-results");
  const gate = steps.findIndex(
    (step) => step.env?.SHARD_RESULT && step.run?.includes("test "),
  );
  expect(merge).toBeGreaterThan(0);
  expect(upload).toBeGreaterThan(merge);
  expect(gate).toBeGreaterThan(upload);
  expect(steps[merge]?.if).not.toContain("needs.test-shard.result");
  const command = steps[gate]?.run;
  if (command === undefined) throw new Error("Missing shard result gate");
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    await expect(
      execute("bash", ["-c", command], {
        env: { ...process.env, CODE_REQUIRED: "true", SHARD_RESULT: result },
      }),
    ).rejects.toMatchObject({ code: 1 });
  }
  await expect(
    execute("bash", ["-c", command], {
      env: { ...process.env, CODE_REQUIRED: "false", SHARD_RESULT: "skipped" },
    }),
  ).resolves.toMatchObject({ stderr: "" });
});

it("keeps diagnosis available after merge failure and publishes only complete successful history", async () => {
  const steps = (await workflow()).test!.steps;
  const diagnosis = steps.find((step) => step.with?.name === "test-results");
  expect(diagnosis?.if).toContain("!cancelled()");
  expect(diagnosis?.if).not.toContain("success()");
  const history = steps.find((step) => step.with?.name === "test-timings");
  expect(history?.if).toContain("success()");
  expect(history?.if).toContain("needs.test-shard.result == 'success'");
  expect(history?.with?.path).toBe(".cache/ci-test-history/test-results.json");
  const download = (await workflow()).build!.steps.find(
    (step) => step.name === "Download previous timing report",
  );
  expect(download?.with?.name).toBe(history?.with?.name);
});

it("runs the existing onboarding and Python producer guards from their selected CI owners", async () => {
  const jobs = await workflow();
  const scripts = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(
      JSON.parse(
        await readFile(
          new URL("../../../package.json", import.meta.url),
          "utf8",
        ),
      ),
    ).scripts;
  expect(
    jobs.docs.steps.some((step) => step.run === "npm run docs:check"),
  ).toBe(true);
  expect(scripts["docs:check"]).toContain(
    "tests/conformance/readmeConsistency.test.ts",
  );
  const producer = jobs.static.steps.find(
    (step) => step.run === "npm run test:python",
  );
  expect(producer?.if).toBe("needs.changes.outputs.code == 'true'");
  expect(scripts["test:python"]).toContain(
    "bridge/native/test_rea_lldb_tracer.py",
  );
});

it("exports portable timing history and removes it on a failed, partial, or invalid rerun", async () => {
  const root = await createTestTempDirectory("rea-ci-report-");
  const summary = join(root, "summary.md");
  const history = join(root, ".cache/ci-test-history/test-results.json");
  const report = {
    success: true,
    numFailedTests: 0,
    testResults: [
      {
        name: join(root, "tests/slow.test.ts"),
        startTime: 10,
        endTime: 110,
        assertionResults: [{ large: "not timing data" }],
      },
      { name: join(root, "tests/fast.test.ts"), startTime: 20, endTime: 30 },
    ],
  };
  const run = async (value: unknown, shards = "success", merge = "success") => {
    await writeFile(join(root, "test-results.json"), JSON.stringify(value));
    await writeFile(summary, "");
    return execute(process.execPath, [fileURLToPath(script)], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summary,
        SHARD_RESULT: shards,
        MERGE_RESULT: merge,
      },
    });
  };
  await run(report);
  const contents = await readFile(history, "utf8");
  expect(contents).not.toContain("assertionResults");
  expect(contents).not.toContain(root);
  expect(
    parseTestDurations(contents, resolve(root, "different-checkout")),
  ).toEqual(
    new Map([
      ["tests/slow.test.ts", 100],
      ["tests/fast.test.ts", 10],
    ]),
  );
  for (const [value, shards, merge] of [
    [{ ...report, success: false, numFailedTests: 1 }, "failure", "failure"],
    [report, "cancelled", "success"],
    [report, "success", "failure"],
  ] as const) {
    await run(report);
    await run(value, shards, merge);
    await expect(readFile(history)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(summary, "utf8")).toContain("diagnostic only");
  }
  await run(report);
  await expect(
    run({
      ...report,
      testResults: [{ name: "../outside.test.ts", startTime: 1, endTime: 3 }],
    }),
  ).rejects.toMatchObject({ code: 1 });
  await expect(readFile(history)).rejects.toMatchObject({ code: "ENOENT" });
});
