import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import {
  BUILT_TEST_PROJECTS,
  SOURCE_TEST_PROJECTS,
  projectForTest,
} from "../../../scripts/lib/test-projects.mjs";
import {
  developmentTestPlan,
  parseDevelopmentTestRequest,
} from "../../../scripts/lib/development-tests.mjs";

import {
  processTest,
  type TestProcesses,
} from "../../support/process/processFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeRepositoryOxlintConfiguration } from "../../fixtures/oxlintConfiguration.js";

const repository = process.cwd();
const oxlint = join(repository, "node_modules/oxlint/bin/oxlint");

const runOxlint = async (
  processes: TestProcesses,
  cwd: string,
  config: string,
  files: readonly string[],
) => {
  const result = await processes.run(
    process.execPath,
    [oxlint, "--threads=1", "--config", config, "--format", "json", ...files],
    { cwd },
  );
  expect(result.signal, result.stderr).toBeNull();
  expect([0, 1], result.stderr).toContain(result.exitCode);
  return {
    exitCode: result.exitCode,
    report: JSON.parse(result.stdout) as {
      diagnostics?: Array<{
        code?: string;
        severity: string;
        filename: string;
      }>;
    },
  };
};

describe("canonical test-project ownership", () => {
  it("assigns every tracked test file exactly once to source or built", () => {
    const files = execFileSync("git", ["ls-files", "*.test.ts"], {
      cwd: repository,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    const grouped = new Map<string, string[]>();
    for (const file of files) {
      const project = projectForTest(file);
      grouped.set(project.group, [...(grouped.get(project.group) ?? []), file]);
    }

    expect(grouped.get("source")).not.toBeUndefined();
    expect(grouped.get("built")).not.toBeUndefined();
    expect(
      (grouped.get("source")?.length ?? 0) +
        (grouped.get("built")?.length ?? 0),
    ).toBe(files.length);
    expect(
      SOURCE_TEST_PROJECTS.reduce(
        (count, project) => count + project.include.length,
        0,
      ),
    ).toBeGreaterThan(0);
    expect(
      BUILT_TEST_PROJECTS.every((project) => project.group === "built"),
    ).toBe(true);
    expect(() => projectForTest("tests/unowned/example.test.ts")).toThrow(
      "No test project owns",
    );
  });

  it("owns the Hopper real-provider conformance test as built and requires preparation", () => {
    const testPath =
      "tests/conformance/providers/hopper/realHopperSearch.test.ts";
    expect(projectForTest(testPath)).toMatchObject({
      name: "boundary",
      group: "built",
    });
    expect(() => parseDevelopmentTestRequest("local", [testPath])).toThrow(
      `Use test:focused for built test projects: ${testPath}`,
    );
    const request = parseDevelopmentTestRequest("focused", [testPath]);
    expect(developmentTestPlan(request)).toMatchObject({ needsBuild: true });
  });
});

describe("Vitest project configuration", () => {
  processTest(
    "uses canonical test-project selectors in Vitest",
    async ({ processes }) => {
      const root = await createTestTempDirectory(
        "rea-vitest-project-selectors-",
      );
      const script = join(root, "project-selectors.mjs");
      await writeFile(
        script,
        `
      const { default: config } = await import(process.argv[2]);
      console.log(JSON.stringify(config.test.projects.map(({ test }) => ({
        name: test.name,
        include: test.include,
        exclude: test.exclude ?? [],
      }))));
    `,
      );
      const result = await processes.run(
        process.execPath,
        [
          "--import",
          "tsx",
          script,
          pathToFileURL(join(repository, "vitest.config.ts")).href,
        ],
        {
          cwd: repository,
        },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const selectors = JSON.parse(result.stdout) as Array<{
        name: string;
        include: string[];
        exclude: string[];
      }>;
      const canonical = [...SOURCE_TEST_PROJECTS, ...BUILT_TEST_PROJECTS].map(
        ({ name, include, exclude }) => ({
          name,
          include,
          exclude: exclude ?? [],
        }),
      );
      expect(selectors.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
        canonical.sort((a, b) => a.name.localeCompare(b.name)),
      );
    },
  );

  processTest.for(
    [
      { flags: [], timeout: 30_000, lines: 68 },
      { flags: ["--coverage"], timeout: 60_000, lines: 68 },
      { flags: ["--coverage.enabled"], timeout: 60_000, lines: 68 },
      { flags: ["--coverage=false"], timeout: 30_000, lines: 68 },
      {
        flags: ["--coverage.enabled=false"],
        timeout: 30_000,
        lines: 68,
      },
      {
        flags: ["--coverage.provider=v8"],
        timeout: 30_000,
        lines: 68,
      },
      {
        flags: ["--coverage.enabled", "--shard", "1/6"],
        timeout: 60_000,
        lines: 0,
      },
      {
        flags: ["--coverage.enabled=false", "--shard=1/6"],
        timeout: 30_000,
        lines: 0,
      },
    ].flatMap((policy) =>
      // Hosted CI owns a four-core runner: up to four workers, doubled deadlines.
      [
        { ...policy, hosted: false, workers: 2, scale: 1 },
        { ...policy, hosted: true, workers: 4, scale: 2 },
      ],
    ),
  )(
    "resolves worker resources from actual CLI options: $flags (hosted: $hosted)",
    async (
      { flags, timeout, lines, hosted, workers, scale },
      { processes },
    ) => {
      const root = await createTestTempDirectory("rea-vitest-worker-policy-");
      const script = join(root, "worker-policy.mjs");
      await writeFile(
        script,
        `
      import config from ${JSON.stringify(pathToFileURL(join(repository, "vitest.config.ts")).href)};
      const project = (name) => config.test.projects.find(project => project.test.name === name).test;
      const deadlines = (name) => [project(name).testTimeout, project(name).hookTimeout];
      console.log(JSON.stringify({
        execArgv: project('cli-boundary').execArgv,
        deadlines: {
          default: [config.test.testTimeout, config.test.hookTimeout],
          source: deadlines('domain'),
          built: deadlines('cli-boundary'),
          longRunning: config.test.tags.find(tag => tag.name === 'long-running').timeout,
        },
        lines: config.test.coverage.thresholds.lines,
        workers: config.test.maxWorkers,
      }));
    `,
      );
      const result = await processes.run(
        process.execPath,
        ["--import", "tsx", script, ...flags],
        {
          cwd: repository,
          // Select the runner explicitly; CI itself sets GITHUB_ACTIONS.
          env: { ...process.env, GITHUB_ACTIONS: hosted ? "true" : "" },
        },
      );
      // Deadlines are hang detection owned by the project: the source
      // deadline scales with coverage and hosted runners, built projects allow
      // four times it, and the long-running tag ten times.
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        execArgv: ["--max-old-space-size=512"],
        deadlines: {
          default: [timeout * scale, timeout * scale],
          source: [timeout * scale, timeout * scale],
          built: [4 * timeout * scale, 4 * timeout * scale],
          longRunning: 10 * timeout * scale,
        },
        lines,
        workers: Math.min(workers, availableParallelism()),
      });
    },
  );
});

describe("test module isolation", () => {
  it.each([
    [
      "tests/process-global/evidenceBundleHeadroom.test.ts",
      "process-global",
      "built",
    ],
    [
      "tests/process-global/javascriptAnalysisCancellation.test.ts",
      "process-global",
      "built",
    ],
  ])("keeps %s in its isolated preparation group", (path, name, group) => {
    expect(projectForTest(path)).toMatchObject({ name, group });
  });

  processTest(
    "uses canonical module isolation in the actual Vitest configuration",
    async ({ processes }) => {
      const files = execFileSync("git", ["ls-files", "*.test.ts"], {
        cwd: repository,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);
      const root = await createTestTempDirectory("rea-vitest-project-policy-");
      const script = join(root, "project-isolation.mjs");
      await writeFile(
        script,
        `
      import config from ${JSON.stringify(pathToFileURL(join(repository, "vitest.config.ts")).href)};
      console.log(JSON.stringify(Object.fromEntries(
        config.test.projects.map(project => [project.test.name, project.test.isolate]),
      )));
    `,
      );
      const result = await processes.run(
        process.execPath,
        ["--import", "tsx", script],
        {
          cwd: repository,
        },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const isolated = JSON.parse(result.stdout) as Record<string, boolean>;
      expect(files.length).toBeGreaterThan(0);
      expect(
        files.filter((file) => {
          const project = projectForTest(file);
          return isolated[project.name] !== (project.isolate !== false);
        }),
      ).toEqual([]);

      // Repository-wide rule execution belongs to the normal lint gate. The
      // configured rule is exercised across every project by the probes below.
    },
  );

  processTest(
    "enforces configured module-mock isolation across every canonical project",
    async ({ processes }) => {
      const root = await createTestTempDirectory("rea-vitest-mock-probe-");
      const config = await writeRepositoryOxlintConfiguration(root);
      const files = execFileSync("git", ["ls-files", "*.test.ts"], {
        cwd: repository,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);
      const probes = [...SOURCE_TEST_PROJECTS, ...BUILT_TEST_PROJECTS].map(
        (project) => {
          const path = files.find(
            (file) => projectForTest(file).name === project.name,
          );
          if (path === undefined)
            throw new Error(`No tracked test in ${project.name}`);
          return { path, isolated: project.isolate !== false };
        },
      );
      for (const form of ["named", "namespace"] as const) {
        for (const probe of probes) {
          const path = join(root, probe.path);
          await mkdir(dirname(path), { recursive: true });
          const receiver = form === "named" ? "testing" : "testing.vi";
          await writeFile(
            path,
            [
              form === "named"
                ? 'import { vi as testing } from "vitest";'
                : 'import * as testing from "vitest";',
              `${receiver}.mock("./dependency.js");`,
              `${receiver}.doMock("./other.js");`,
              'const local = { mock() {} }; local.mock("unrelated");',
            ].join("\n"),
          );
        }
        const { exitCode, report } = await runOxlint(
          processes,
          root,
          config,
          probes.map(({ path }) => path),
        );
        expect(exitCode).toBe(1);
        const errors =
          report.diagnostics?.filter(
            ({ code, severity }) =>
              code === "rea(no-shared-module-mock)" && severity === "error",
          ) ?? [];
        expect(errors).toHaveLength(
          2 * probes.filter(({ isolated }) => !isolated).length,
        );
        for (const probe of probes) {
          const selected = errors.filter(
            ({ filename }) =>
              resolve(root, filename) === resolve(root, probe.path),
          );
          expect(selected, `${form}: ${probe.path}`).toHaveLength(
            probe.isolated ? 0 : 2,
          );
        }
      }
    },
  );
});
