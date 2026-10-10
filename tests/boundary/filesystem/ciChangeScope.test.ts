import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  executeWorkflowFixture as execFileAsync,
  workflowGit as git,
} from "../../support/workflowGit.js";

const workflowSchema = z.object({
  jobs: z.object({
    changes: z.object({
      steps: z.array(
        z.object({ id: z.string().optional(), run: z.string().optional() }),
      ),
    }),
  }),
});

async function commit(directory: string) {
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "fix: fixture change"]);
  return git(directory, ["rev-parse", "HEAD"]);
}

async function change(
  directory: string,
  paths: readonly string[],
  content = "Changed fixture content\n",
) {
  for (const path of paths) {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return commit(directory);
}

async function fixture() {
  const directory = await createTestTempDirectory("rea-ci-scope-");
  await git(directory, ["init", "--initial-branch=main"]);
  const base = await change(
    directory,
    ["src/provider.ts", "README.md"],
    "Initial fixture content\n",
  );
  return { directory, base };
}

async function classify(
  directory: string,
  base: string,
  head: string,
  event = "pull_request",
) {
  const workflow = workflowSchema.parse(
    parse(
      await readFile(
        new URL("../../../.github/workflows/ci.yml", import.meta.url),
        "utf8",
      ),
    ),
  );
  const command = z
    .string()
    .parse(
      workflow.jobs.changes.steps.find((step) => step.id === "package")?.run,
    );
  const output = join(directory, "scope-output");
  await writeFile(output, "");
  await execFileAsync("bash", ["-e", "-o", "pipefail", "-c", command], {
    cwd: directory,
    env: {
      ...process.env,
      BASE_SHA: base,
      HEAD_SHA: head,
      GITHUB_EVENT_NAME: event,
      GITHUB_OUTPUT: output,
    },
  });
  return readFile(output, "utf8");
}

it("keeps every translated root README and authored guide on the documentation lane", async () => {
  const { directory, base } = await fixture();
  const readmes = (await readdir(new URL("../../../", import.meta.url))).filter(
    (name) => /^README(?:_.*)?\.md$/u.test(name),
  );
  expect(readmes).toContain("README.md");
  const head = await change(directory, [
    ...readmes,
    "docs/guide.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
  ]);
  expect(await classify(directory, base, head)).toBe("required=false\n");
});

it("does not charge a documentation PR for unrelated implementation updates on main", async () => {
  const { directory, base } = await fixture();
  await git(directory, ["switch", "-c", "docs/change"]);
  const head = await change(directory, ["README_zh-TW.md"]);
  await git(directory, ["switch", "main"]);
  const advancedBase = await change(directory, ["src/anotherProvider.ts"]);
  expect(advancedBase).not.toBe(base);
  expect(await classify(directory, advancedBase, head)).toBe(
    "required=false\n",
  );
});

it.each([
  "src/README.md",
  "README.md.ts",
  "package.json",
  "bridge/ghidra/provider.py",
  "tests/fixture.test.ts",
  ".github/workflows/ci.yml",
  "unknown-file",
])(
  "retains complete checks when documentation is mixed with %s",
  async (path) => {
    const { directory, base } = await fixture();
    const head = await change(directory, ["README.md", path]);
    expect(await classify(directory, base, head)).toBe("required=true\n");
  },
);

it("retains complete checks when implementation is renamed into documentation", async () => {
  const { directory, base } = await fixture();
  await mkdir(join(directory, "docs"));
  await rename(
    join(directory, "src/provider.ts"),
    join(directory, "docs/provider.md"),
  );
  const head = await commit(directory);
  expect(await classify(directory, base, head)).toBe("required=true\n");
});

it("retains the complete main-push baseline even for documentation", async () => {
  const { directory, base } = await fixture();
  const head = await change(directory, ["README_ja.md"]);
  expect(await classify(directory, base, head, "push")).toBe("required=true\n");
});

it("fails classification rather than treating an invalid Git comparison as a scope", async () => {
  const { directory, base } = await fixture();
  await expect(classify(directory, "missing-ref", base)).rejects.toMatchObject({
    code: 128,
  });
  expect(await readFile(join(directory, "scope-output"), "utf8")).toBe("");
});

it("retains native Inspector verification on every documented package host", async () => {
  const stepSchema = z.object({
    run: z.string().optional(),
    if: z.string().optional(),
  });
  const steps = z.array(stepSchema);
  const workflow = z
    .object({
      jobs: z.object({
        "package-e2e": z.object({
          strategy: z.object({
            matrix: z.object({
              include: z.array(
                z.object({ platform: z.string(), architecture: z.string() }),
              ),
            }),
          }),
          steps,
        }),
        "windows-curated": z.object({ steps }),
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
  const packageLane = workflow.jobs["package-e2e"];
  const packageInspector = stepSchema.parse(
    packageLane.steps.find((step) => step.run === "npm run verify:inspector"),
  );
  expect(packageInspector.if).toBeUndefined();
  expect(
    packageLane.strategy.matrix.include
      .map(({ platform, architecture }) => `${platform}/${architecture}`)
      .sort(),
  ).toEqual(["darwin/arm64", "darwin/x64", "linux/arm64", "linux/x64"]);
  const windowsInspector = stepSchema.parse(
    workflow.jobs["windows-curated"].steps.find(
      (step) => step.run === "npm run verify:inspector",
    ),
  );
  expect(windowsInspector.if).toBeUndefined();
});
