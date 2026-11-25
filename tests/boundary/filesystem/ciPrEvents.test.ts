import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { executeWorkflowFixture } from "../../support/workflowGit.js";

async function workflow(name: string) {
  return z
    .object({
      on: z.record(z.string(), z.unknown()),
      permissions: z.record(z.string(), z.string()),
      concurrency: z.object({ group: z.string() }).optional(),
      jobs: z.record(
        z.string(),
        z
          .object({
            env: z.record(z.string(), z.string()).optional(),
            name: z.string().optional(),
            if: z.string().optional(),
            uses: z.string().optional(),
            with: z.record(z.string(), z.string()).optional(),
            steps: z
              .array(
                z.object({
                  run: z.string().optional(),
                  uses: z.string().optional(),
                  with: z.record(z.string(), z.unknown()).optional(),
                  env: z.record(z.string(), z.string()).optional(),
                }),
              )
              .optional(),
          })
          .passthrough(),
      ),
    })
    .parse(
      parse(
        await readFile(
          new URL(`../../../.github/workflows/${name}`, import.meta.url),
          "utf8",
        ),
      ),
    );
}

it("refreshes title validation on edits without checking out PR code or cancelling CI", async () => {
  const title = await workflow("pr-title.yml");
  expect(title.on.pull_request).toMatchObject({
    types: ["opened", "synchronize", "reopened", "edited"],
  });
  expect(title.permissions).toEqual({});
  expect(title.concurrency?.group).not.toBe(
    (await workflow("ci.yml")).concurrency?.group,
  );
  const jobs = Object.values(title.jobs);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.name).toBe("Conventional PR title");
  expect(jobs[0]?.if).toBeUndefined(); // A skipped check must not green-light an invalid title on body edits.
  const steps = jobs[0]?.steps ?? [];
  expect(steps).toHaveLength(1);
  expect(steps[0]?.uses).toBeUndefined();
  expect(steps[0]?.env).toEqual({
    PR_TITLE: "${{ github.event.pull_request.title }}",
  });
  const command = z.string().parse(steps[0]?.run);
  for (const title of [
    "fix(ci): repair workflow",
    "feat!: changed contract",
    "docs: literal $(exit 91) `exit 92` text",
  ]) {
    await expect(
      executeWorkflowFixture("bash", ["-c", command], {
        env: { ...process.env, PR_TITLE: title },
      }),
    ).resolves.toMatchObject({ stderr: "" });
  }
  for (const title of ["", "Fix CI", "feat: "]) {
    await expect(
      executeWorkflowFixture("bash", ["-c", command], {
        env: { ...process.env, PR_TITLE: title },
      }),
    ).rejects.toMatchObject({ code: 1 });
  }
  expect((await workflow("ci.yml")).jobs["pr-title"]).toBeUndefined();
});

it("qualifies only ci:full label additions at the caller's merge revision", async () => {
  const full = await workflow("ci-full-pr.yml");
  expect(full.on.pull_request).toMatchObject({ types: ["labeled"] });
  expect(full.permissions).toEqual({ contents: "read", actions: "read" });
  expect(Object.values(full.jobs)).toEqual([
    {
      name: "Qualify labeled PR revision",
      if: "github.event.label.name == 'ci:full'",
      uses: "./.github/workflows/ci.yml",
      with: { source_sha: "${{ github.sha }}" },
    },
  ]);
  expect(full.jobs.qualification).not.toHaveProperty("secrets");
  // Metadata events must not create skipped replacements for the main CI checks.
  expect(full.jobs.required).toBeUndefined();
  expect(full.concurrency).toBeUndefined();
});

it("checks out test sources only for fast PRs and history only for revision comparisons", async () => {
  const changes = (await workflow("ci.yml")).jobs.changes!;
  const checkout = changes.steps?.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  )?.with;
  const sparse = z.string().parse(checkout?.["sparse-checkout"]);
  const depth = z.string().parse(checkout?.["fetch-depth"]);
  const fastSweep = "23 1,5,7,11,13,17,19,23 * * *";
  for (const [event, full, fullOnPush, schedule, expectedDepth, traceTests] of [
    ["pull_request", false, false, "", 0, true],
    ["pull_request", true, false, "", 1, false],
    ["push", false, false, "", 1, false],
    ["push", false, true, "", 0, false],
    ["schedule", false, false, fastSweep, 0, false],
    ["schedule", false, false, "23 3 * * *", 1, false],
    ["workflow_dispatch", false, false, "", 1, false],
  ] as const) {
    const context = {
      env: { ...changes.env, CI_FULL: String(full) },
      github: { event_name: event, event: { schedule } },
      vars: { REA_CI_FULL_ON_PUSH: String(fullOnPush) },
    };
    const expand = (value: string) =>
      value.replace(/\$\{\{([^}]+)\}\}/gu, (_match, expression: string) =>
        String(runInNewContext(expression, context, { timeout: 1_000 })),
      );
    expect(Number(expand(depth))).toBe(expectedDepth);
    const patterns = expand(sparse).trim().split("\n");
    expect(patterns).toContain("/.nvmrc");
    expect(patterns).toContain("/scripts/ci/");
    expect(patterns).toContain("/scripts/lib/");
    expect(patterns.includes("/scripts/")).toBe(traceTests);
    expect(patterns.includes("/tests/")).toBe(traceTests);
  }
});

it("includes release PR qualification in the ordinary required CI gate", async () => {
  const ci = await workflow("ci.yml");
  const full = ci.jobs.changes?.env?.CI_FULL;
  expect(full).toContain("github.event_name == 'pull_request'");
  expect(full).toContain(
    "github.event.pull_request.head.repo.full_name == github.repository",
  );
  expect(full).toContain(
    "startsWith(github.event.pull_request.head.ref, format('release-please--branches--{0}--', github.event.pull_request.base.ref))",
  );
  expect(ci.jobs.required?.name).toBe("CI required");
  expect(ci.jobs.required?.needs).toContain("static-deep");
});
