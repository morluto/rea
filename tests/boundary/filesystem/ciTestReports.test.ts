import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { planTestSelection } from "../../../scripts/ci/test-selection.mjs";

import { parseTestDurations } from "../../ciTestSequencer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { workflowGit } from "../../support/workflowGit.js";

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
  const merges = steps.filter((step) => step.run?.includes("--reporter=json"));
  expect(merges).toHaveLength(2);
  for (const step of merges)
    expect(step.run).toContain(
      "--reporter=./scripts/ci/test-timing-reporter.mjs",
    );
  expect(steps[upload]?.with?.path).toContain("test-timings.json");
  expect(steps[upload]?.with).toMatchObject({ "include-hidden-files": true });
  expect(steps[upload]?.with?.path).toContain(
    ".cache/ci-test-selection/report.json",
  );
  const summary = steps.find((step) =>
    step.run?.includes("scripts/ci/test-report.mjs"),
  );
  expect(summary?.env?.CI_TEST_SELECTION).toBe(
    "${{ needs.changes.outputs.test_selection }}",
  );
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
  expect(history?.if).toContain("needs.changes.outputs.tier == 'full'");
  expect(history?.with?.path).toBe(".cache/ci-test-history/test-results.json");
  const buildSteps = (await workflow()).build!.steps;
  const lookup = buildSteps.find((step) =>
    step.run?.includes("test-history.mjs"),
  );
  expect(lookup?.env).toMatchObject({
    CI_REPOSITORY: "${{ github.repository }}",
    CI_REPOSITORY_ID: "${{ github.repository_id }}",
    CI_DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
  });
  const download = buildSteps.find(
    (step) => step.name === "Download previous timing report",
  );
  expect(download?.with?.name).toBe(history?.with?.name);
  expect(download?.with?.["run-id"]).toBe(
    "${{ steps.history.outputs.run-id }}",
  );
});

it("rejects successful shard reports with missing or duplicate portable files", async () => {
  const root = await createTestTempDirectory("rea-ci-report-inventory-");
  await workflowGit(root, ["init"]);
  await mkdir(join(root, "tests"));
  for (const name of ["first", "second"])
    await writeFile(join(root, `tests/${name}.test.ts`), "// fixture\n");
  await workflowGit(root, ["add", "tests"]);
  const run = async (names: readonly string[]) => {
    await writeFile(
      join(root, "test-timings.json"),
      JSON.stringify({
        version: 1,
        success: true,
        files: names.map((name) => ({ name, durationMs: 1 })),
      }),
    );
    return execute(process.execPath, [fileURLToPath(script)], {
      cwd: root,
      env: {
        ...process.env,
        SHARD_RESULT: "success",
        MERGE_RESULT: "success",
        CI_VERIFY_TEST_INVENTORY: "true",
      },
    });
  };
  await expect(
    run(["tests/first.test.ts", "tests/second.test.ts"]),
  ).resolves.toMatchObject({ stderr: "" });
  for (const names of [
    ["tests/first.test.ts"],
    ["tests/first.test.ts", "tests/second.test.ts", "tests/unplanned.test.ts"],
    ["tests/first.test.ts", "tests/first.test.ts", "tests/second.test.ts"],
  ]) {
    await expect(run(names)).rejects.toMatchObject({
      stderr: expect.stringContaining("Incomplete portable test inventory"),
    });
    await expect(
      readFile(join(root, ".cache/ci-test-history/test-results.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
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
    version: 1,
    success: true,
    files: [
      {
        name: join(root, "tests/slow.test.ts"),
        durationMs: 100,
        phases: {
          execution: 20,
          preparation: 20,
          environment: 10,
          imports: 40,
          setup: 10,
        },
      },
      { name: join(root, "tests/fast.test.ts"), durationMs: 10 },
    ],
  };
  const run = async (value: unknown, shards = "success", merge = "success") => {
    await writeFile(join(root, "test-timings.json"), JSON.stringify(value));
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
  expect(contents).not.toContain("phases");
  expect(contents).not.toContain("startTime");
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
    [{ ...report, success: false }, "failure", "failure"],
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
      files: [{ name: "../outside.test.ts", durationMs: 2 }],
    }),
  ).rejects.toMatchObject({ code: 1 });
  await expect(readFile(history)).rejects.toMatchObject({ code: "ENOENT" });
  await run(report);
  await expect(
    run({
      ...report,
      files: [{ name: "tests/invalid.test.ts", durationMs: -1 }],
    }),
  ).rejects.toMatchObject({ code: 1 });
  await expect(readFile(history)).rejects.toMatchObject({ code: "ENOENT" });
});

it("recovers complete module costs from real blob reports without executing tests again", async () => {
  const root = await createTestTempDirectory("rea-ci-module-timing-");
  const config = join(root, "vitest.config.mjs");
  await writeFile(
    config,
    'export default { test: { globals: true, include: ["sample.test.js"], maxWorkers: 1 } };',
  );
  await writeFile(
    join(root, "sample.test.js"),
    [
      'import { writeFileSync } from "node:fs";',
      "beforeAll(() => new Promise(resolve => setTimeout(resolve, 80)));",
      "afterAll(() => new Promise(resolve => setTimeout(resolve, 80)));",
      'it("has cheap assertions and expensive outer hooks", () => { writeFileSync("executed", "yes"); expect(1).toBe(1); });',
    ].join("\n"),
  );
  const vitest = fileURLToPath(
    new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
  );
  const reporter = fileURLToPath(
    new URL("../../../scripts/ci/test-timing-reporter.mjs", import.meta.url),
  );
  const run = (args: string[]) =>
    execute(process.execPath, [vitest, ...args, "--config", config], {
      cwd: root,
      env: process.env,
      timeout: 20_000,
    });
  await run(["run", "--reporter=blob"]);
  expect(await readFile(join(root, "executed"), "utf8")).toBe("yes");
  await rm(join(root, "executed"));
  await run([
    "--merge-reports",
    `--reporter=${reporter}`,
    "--reporter=json",
    "--outputFile.json=body.json",
  ]);
  await expect(readFile(join(root, "executed"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const report = z
    .object({
      version: z.literal(1),
      success: z.literal(true),
      files: z.array(
        z.object({
          name: z.string(),
          durationMs: z.number(),
          phases: z.record(z.string(), z.number()),
        }),
      ),
    })
    .parse(JSON.parse(await readFile(join(root, "test-timings.json"), "utf8")));
  expect(
    JSON.parse(await readFile(join(root, "test-timings.json"), "utf8")),
  ).toMatchObject({
    reason: "passed",
    unhandledErrors: 0,
    files: [{ state: "passed" }],
  });
  expect(report.files).toHaveLength(1);
  const file = report.files[0]!;
  const json = z
    .object({
      testResults: z.array(
        z.object({ startTime: z.number(), endTime: z.number() }),
      ),
    })
    .parse(JSON.parse(await readFile(join(root, "body.json"), "utf8")));
  const body = json.testResults[0]!;
  expect(
    file.phases.execution! - (body.endTime - body.startTime),
  ).toBeGreaterThan(100);
  expect(file.phases.imports).toBeGreaterThan(0);
  expect(file.phases.preparation).toBeGreaterThan(0);
  expect(file.durationMs).toBeCloseTo(
    Object.values(file.phases).reduce((sum, value) => sum + value, 0),
  );
  await execute(process.execPath, [fileURLToPath(script)], {
    cwd: root,
    env: { ...process.env, SHARD_RESULT: "success", MERGE_RESULT: "success" },
  });
  expect(
    parseTestDurations(
      await readFile(
        join(root, ".cache/ci-test-history/test-results.json"),
        "utf8",
      ),
      root,
    )?.get("sample.test.js"),
  ).toBe(file.durationMs);

  await writeFile(
    join(root, "sample.test.js"),
    'it("fails", () => { throw new Error("fixture failure"); });',
  );
  await expect(run(["run", "--reporter=blob"])).rejects.toMatchObject({
    code: 1,
  });
  await expect(
    run(["--merge-reports", `--reporter=${reporter}`]),
  ).rejects.toMatchObject({ code: 1 });
  const failed = JSON.parse(
    await readFile(join(root, "test-timings.json"), "utf8"),
  ) as unknown;
  expect(failed).toMatchObject({
    version: 1,
    success: false,
    reason: "failed",
    unhandledErrors: 0,
    files: [{ state: "failed" }],
  });
  // Even a caller accidentally marking the merge successful cannot publish this report.
  await execute(process.execPath, [fileURLToPath(script)], {
    cwd: root,
    env: { ...process.env, SHARD_RESULT: "success", MERGE_RESULT: "success" },
  });
  await expect(
    readFile(join(root, ".cache/ci-test-history/test-results.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("records failed omissions from full reports without treating partial or unhandled outcomes as parity", async () => {
  const root = await createTestTempDirectory("rea-ci-selection-report-");
  await workflowGit(root, ["init"]);
  const paths = [
    "src/sqlite/provider.test.ts",
    "src/evm/provider.test.ts",
    "tests/boundary/mcp/workflow.test.ts",
  ];
  for (const path of paths) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "// fixture\n");
  }
  await workflowGit(root, ["add", "src", "tests"]);
  const timing = {
    version: 1,
    success: false,
    reason: "failed",
    unhandledErrors: 0,
    files: paths.map((name, index) => ({
      name,
      durationMs: 10,
      state: index === 1 ? "failed" : "passed",
    })),
  };
  const run = async (report: unknown) => {
    await writeFile(join(root, "test-timings.json"), JSON.stringify(report));
    await execute(process.execPath, [fileURLToPath(script)], {
      cwd: root,
      env: {
        ...process.env,
        SHARD_RESULT: "failure",
        MERGE_RESULT: "failure",
        CI_VERIFY_TEST_INVENTORY: "true",
        CI_TEST_SELECTION: JSON.stringify(
          planTestSelection(["src/sqlite/Provider.ts"], "pull_request", "fast"),
        ),
        GITHUB_SHA: "merge-sha",
        CI_PR_HEAD_SHA: "pr-head-sha",
      },
    });
    return JSON.parse(
      await readFile(
        join(root, ".cache/ci-test-selection/report.json"),
        "utf8",
      ),
    ) as unknown;
  };
  expect(await run(timing)).toMatchObject({
    observational: true,
    complete: true,
    selected: [paths[0], paths[2]],
    omitted: [paths[1]],
    missedFailures: [paths[1]],
    executionSha: "merge-sha",
    prHeadSha: "pr-head-sha",
  });
  for (const report of [
    { ...timing, files: timing.files.slice(0, 1) },
    { ...timing, unhandledErrors: 1 },
    { ...timing, reason: "interrupted" },
  ])
    expect(await run(report)).toMatchObject({ complete: false });
  await expect(run({ ...timing, files: "invalid" })).rejects.toMatchObject({
    code: 1,
  });
  await expect(
    readFile(join(root, ".cache/ci-test-selection/report.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(join(root, ".cache/ci-test-history/test-results.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
