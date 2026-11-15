import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { executeWorkflowFixture } from "../../support/workflowGit.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

async function workflow(name: string) {
  return z
    .object({
      on: z.record(z.string(), z.unknown()),
      permissions: z.record(z.string(), z.string()),
      concurrency: z
        .object({
          group: z.string(),
          "cancel-in-progress": z.union([z.string(), z.boolean()]).optional(),
        })
        .optional(),
      jobs: z.record(
        z.string(),
        z
          .object({
            name: z.string().optional(),
            if: z.string().optional(),
            uses: z.string().optional(),
            with: z.record(z.string(), z.string()).optional(),
            steps: z
              .array(
                z.object({
                  run: z.string().optional(),
                  uses: z.string().optional(),
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
  expect(title.on.merge_group).toEqual({ types: ["checks_requested"] });
  expect(title.permissions).toEqual({});
  expect(title.concurrency?.group).not.toBe(
    (await workflow("ci.yml")).concurrency?.group,
  );
  // A queued group's check uses its exact head and is never superseded.
  expect(title.concurrency?.group).toContain(
    "github.event.merge_group.head_sha",
  );
  expect(title.concurrency?.["cancel-in-progress"]).toBe(
    "${{ github.event_name == 'pull_request' }}",
  );
  const jobs = Object.values(title.jobs);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.name).toBe("Conventional PR title");
  expect(jobs[0]?.if).toBeUndefined(); // A skipped check must not green-light an invalid title on body edits.
  // The token reads only the merge group comparison.
  expect(jobs[0]?.permissions).toEqual({ contents: "read" });
  const steps = jobs[0]?.steps ?? [];
  expect(steps).toHaveLength(1);
  expect(steps[0]?.uses).toBeUndefined();
  expect(steps[0]?.env).toEqual({
    PR_TITLE: "${{ github.event.pull_request.title }}",
    GH_TOKEN: "${{ github.token }}",
    MERGE_GROUP_BASE_SHA: "${{ github.event.merge_group.base_sha }}",
    MERGE_GROUP_HEAD_SHA: "${{ github.event.merge_group.head_sha }}",
  });
  const command = z.string().parse(steps[0]?.run);
  const runPullRequest = (title: string) =>
    executeWorkflowFixture("bash", ["-c", command], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        PR_TITLE: title,
      },
    });
  for (const title of [
    "fix(ci): repair workflow",
    "feat!: changed contract",
    "docs: literal $(exit 91) `exit 92` text",
  ]) {
    await expect(runPullRequest(title)).resolves.toMatchObject({ stderr: "" });
  }
  for (const title of ["", "Fix CI", "feat: "]) {
    await expect(runPullRequest(title)).rejects.toMatchObject({ code: 1 });
  }
  await expect(
    executeWorkflowFixture("bash", ["-c", command], {
      env: { ...process.env, GITHUB_EVENT_NAME: "push", PR_TITLE: "fix: x" },
    }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Unsupported title validation event"),
  });
  expect((await workflow("ci.yml")).jobs["pr-title"]).toBeUndefined();
});

it("validates every squash subject a queued merge group lands", async () => {
  const [step] =
    Object.values((await workflow("pr-title.yml")).jobs)[0]?.steps ?? [];
  const command = z.string().parse(step?.run);
  const workspace = await createTestWorkspace("rea-pr-title-queue-");
  try {
    // The fake gh records its request and prints the queued comparison.
    const bin = await workspace.mkdir("bin");
    const request = workspace.path("gh-request");
    await writeFile(
      join(bin, "gh"),
      '#!/bin/sh\nprintf "%s " "$@" > "$GH_REQUEST"\ncat "$GH_COMPARISON_FILE"\n',
    );
    await chmod(join(bin, "gh"), 0o755);
    const base = "a".repeat(40);
    const head = "c".repeat(40);
    const comparison = (
      subjects: readonly string[],
      overrides: Record<string, unknown> = {},
    ) => ({
      status: "ahead",
      behind_by: 0,
      total_commits: subjects.length,
      commits: subjects.map((subject, index) => ({
        sha: index === subjects.length - 1 ? head : "b".repeat(40),
        commit: { message: `${subject}\n\n* fixup: body text` },
      })),
      ...overrides,
    });
    const comparisonFile = workspace.path("gh-comparison.json");
    const run = async (value: unknown) => {
      await writeFile(comparisonFile, JSON.stringify(value));
      return executeWorkflowFixture("bash", ["-c", command], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GITHUB_EVENT_NAME: "merge_group",
          GITHUB_REPOSITORY: "owner/repository",
          MERGE_GROUP_BASE_SHA: base,
          MERGE_GROUP_HEAD_SHA: head,
          GH_REQUEST: request,
          GH_COMPARISON_FILE: comparisonFile,
          // A merge group carries no PR title; it must not be consulted.
          PR_TITLE: "fix: ignored",
        },
      });
    };
    await expect(
      run(comparison(["fix(ci): first (#1)", "feat!: second (#2)"])),
    ).resolves.toMatchObject({ stderr: "" });
    expect(await readFile(request, "utf8")).toBe(
      `api repos/owner/repository/compare/${base}...${head} `,
    );
    // The comparison carries file patches; a large group must not exceed the
    // per-string environment limit (128 KiB on Linux) or the argument limit.
    await expect(
      run(
        comparison(["fix: large (#3)"], {
          files: [{ filename: "large.txt", patch: "+x\n".repeat(1_000_000) }],
        }),
      ),
    ).resolves.toMatchObject({ stderr: "" });
    await expect(
      run(comparison(["fix: first (#1)", "Second change (#2)"])),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Queued commit subject: Second change"),
    });
    // Incomplete, diverged or foreign comparisons fail closed.
    for (const value of [
      null,
      {},
      comparison([]),
      comparison(["fix: one (#1)"], { status: "diverged" }),
      comparison(["fix: one (#1)"], { behind_by: 1 }),
      comparison(["fix: one (#1)"], { total_commits: 251 }),
      comparison(["fix: one (#1)"], {
        commits: [{ sha: "d".repeat(40), commit: { message: "fix: one" } }],
      }),
    ]) {
      await expect(run(value)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("could not be identified"),
      });
    }
  } finally {
    await removeTestWorkspace(workspace.root);
  }
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
