import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  executeWorkflowFixture,
  workflowFixtureEnvironment,
  workflowGit,
} from "../../support/workflowGit.js";

const script = fileURLToPath(
  new URL("../../../scripts/ci/darwin-gated-tests.mjs", import.meta.url),
);

const DIRECTORY = "tests/boundary/filesystem";

// Each fixture is one test module; the name says whether macOS gates it.
const FIXTURES = {
  "darwinSkip.test.ts": `it.skipIf(process.platform !== "darwin")("runs", () => {});`,
  "darwinRun.test.ts": `describe.runIf(process.platform === "darwin")("runs", () => {});`,
  "darwinConstant.test.ts": `const onDarwin = process.platform === "darwin";\nit.skipIf(!onDarwin)("runs", () => {});`,
  "darwinArm64.test.ts": `it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("runs", () => {});`,
  "darwinCases.test.ts": `it.for(["portable", ...(process.platform === "darwin" ? ["plist"] : [])])("%s", () => {});`,
  "notLinux.test.ts": `it.skipIf(process.platform === "linux")("runs", () => {});`,
  "ungated.test.ts": `it("runs everywhere", () => {});`,
  "linuxOnly.test.ts": `it.skipIf(process.platform !== "linux")("runs", () => {});`,
  "posixHosts.test.ts": `it.skipIf(!["darwin", "linux"].includes(process.platform))("runs", () => {});`,
  "windowsOnly.test.ts": `it.runIf(process.platform === "win32")("runs", () => {});`,
  "notDarwin.test.ts": `it.skipIf(process.platform === "darwin")("runs", () => {});`,
  "unknownGate.test.ts": `it.skipIf(process.env.CI === "1")("runs", () => {});`,
  "portableCases.test.ts": `it.for([...(process.platform === "darwin" ? ["mac"] : ["linux"])])("%s", () => {});`,
} as const;

const GATED = [
  "darwinArm64.test.ts",
  "darwinCases.test.ts",
  "darwinConstant.test.ts",
  "darwinRun.test.ts",
  "darwinSkip.test.ts",
  "notLinux.test.ts",
].map((name) => `${DIRECTORY}/${name}`);

const fixtureRepository = async (files: Readonly<Record<string, string>>) => {
  const directory = await createTestTempDirectory("rea-ci-darwin-gated-");
  await workflowGit(directory, ["init", "--initial-branch=main"]);
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), `${source}\n`);
  }
  await workflowGit(directory, ["add", "."]);
  await workflowGit(directory, ["commit", "-m", "fixture tests"]);
  return directory;
};

const discover = (directory: string) =>
  executeWorkflowFixture(process.execPath, [script], {
    cwd: directory,
    env: workflowFixtureEnvironment(),
  });

it("lists exactly the tracked tests that run on macOS but never on Linux", async () => {
  const directory = await fixtureRepository(
    Object.fromEntries(
      Object.entries(FIXTURES).map(([name, source]) => [
        `${DIRECTORY}/${name}`,
        source,
      ]),
    ),
  );
  // An untracked module is not part of the revision under test.
  await writeFile(
    join(directory, DIRECTORY, "untracked.test.ts"),
    FIXTURES["darwinSkip.test.ts"],
  );
  const { stdout } = await discover(directory);
  expect(stdout.trim().split("\n")).toEqual(GATED);
});

it("fails closed when no test is gated to macOS", async () => {
  const directory = await fixtureRepository({
    [`${DIRECTORY}/ungated.test.ts`]: FIXTURES["ungated.test.ts"],
    [`${DIRECTORY}/linuxOnly.test.ts`]: FIXTURES["linuxOnly.test.ts"],
  });
  await expect(discover(directory)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("No darwin-gated test files"),
  });
});

it("fails closed on a gated test that no Vitest project owns", async () => {
  const directory = await fixtureRepository({
    "fixtures/darwinSkip.test.ts": FIXTURES["darwinSkip.test.ts"],
  });
  await expect(discover(directory)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("No test project owns"),
  });
});

it("runs every discovered macOS-gated test in the macOS lane", async () => {
  const workflow = z
    .object({
      jobs: z.object({
        "apple-artifacts": z.object({
          "runs-on": z.string(),
          steps: z.array(z.object({ run: z.string().optional() })),
        }),
      }),
    })
    .parse(
      parse(
        await readFile(
          new URL("../../../.github/workflows/ci.yml", import.meta.url),
          "utf8",
        ),
      ),
    );
  const job = workflow.jobs["apple-artifacts"];
  expect(job["runs-on"]).toMatch(/^macos-/u);
  expect(job.steps.map((step) => step.run)).toContainEqual(
    expect.stringMatching(
      /tests="\$\(node scripts\/ci\/darwin-gated-tests\.mjs\)"[\s\S]*npm run test:focused -- \$tests/u,
    ),
  );
});
