import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execFileAsync = promisify(execFile);
const stepSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.unknown()).optional(),
});
const jobSchema = z.object({
  if: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  outputs: z.record(z.string(), z.string()).optional(),
  steps: z.array(stepSchema),
});

async function readReleaseWorkflow() {
  return z
    .object({
      on: z.record(z.string(), z.unknown()),
      concurrency: z.object({ group: z.string() }),
      jobs: z.object({
        "release-proposal": jobSchema,
        "release-please": jobSchema,
        "merged-release": jobSchema,
        publish: jobSchema,
        "publish-mcp": jobSchema,
      }),
    })
    .parse(
      parse(
        await readFile(
          new URL("../../../.github/workflows/release.yml", import.meta.url),
          "utf8",
        ),
      ),
    );
}

it("validates the source before release creation and the prepared candidate before generation", async () => {
  const steps = (await readReleaseWorkflow()).jobs["release-please"].steps;
  const source = steps.findIndex(
    (step) =>
      step.name ===
      "Validate checkpoint version and ancestry before release creation",
  );
  const action = steps.findIndex((step) =>
    step.uses?.startsWith("googleapis/release-please-action@"),
  );
  const candidate = steps.findIndex(
    (step) =>
      step.name === "Validate prepared release version and migration notes",
  );
  const generation = steps.findIndex(
    (step) => step.name === "Regenerate release documentation",
  );
  expect(source).toBeGreaterThanOrEqual(0);
  expect(source).toBeLessThan(action);
  expect(steps[source]?.if).toBeUndefined();
  expect(steps[source]?.run).toContain("--source-sha");
  expect(candidate).toBeGreaterThan(action);
  expect(candidate).toBeLessThan(generation);
  expect(steps[candidate]?.if).toBe(
    "inputs.phase == 'prepare' && steps.release.outputs.prs_created == 'true'",
  );
  expect(steps[candidate]?.run).toContain("--stage candidate");
  for (const name of [
    "Check out release controller and Git history",
    "Check out release pull request",
  ]) {
    expect(
      steps.find((step) => step.name === name)?.with?.["fetch-depth"],
    ).toBe(0);
  }
});

it("keeps main pushes proposal-only and gates merged-release automation", async () => {
  const workflow = await readReleaseWorkflow();
  expect(workflow.on.push).toEqual({ branches: ["main"] });
  expect(workflow.on.pull_request).toMatchObject({
    types: ["closed"],
    branches: ["main"],
  });
  const proposal = workflow.jobs["release-proposal"];
  expect(proposal.if).toBe("github.event_name == 'push'");
  const action = proposal.steps.find((step) =>
    step.uses?.startsWith("googleapis/release-please-action@"),
  );
  expect(action?.with).toMatchObject({
    token: "${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}",
    "target-branch": "main",
    "skip-github-release": true,
  });
  expect(action?.with?.["skip-github-pull-request"]).not.toBe(true);
  const merged = workflow.jobs["merged-release"];
  expect(merged.if).toContain("github.event.pull_request.merged == true");
  expect(merged.if).toContain("github.repository");
  expect(merged.if).toContain("release-please--branches--main--");
  expect(merged.outputs).toEqual({
    release_created: "${{ steps.release.outputs.release_created }}",
    sha: "${{ steps.release.outputs.sha }}",
  });
  expect(workflow.jobs["release-please"].if).toBe(
    "github.event_name == 'workflow_dispatch'",
  );
  expect(workflow.concurrency.group).toBe(
    "release-${{ inputs.release_branch || github.event.pull_request.merge_commit_sha || github.ref_name }}",
  );
});

it("validates the reviewed merge before creating its release", async () => {
  const workflow = await readReleaseWorkflow();
  const steps = workflow.jobs["merged-release"].steps;
  const checkout = steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  expect(checkout?.with).toMatchObject({
    ref: "${{ github.event.pull_request.merge_commit_sha }}",
    "fetch-depth": 0,
  });
  const checkpoint = steps.find((step) =>
    step.run?.includes("verify-release-checkpoint.mjs"),
  );
  expect(checkpoint?.run).toContain("--phase publish --release-branch main");
  expect(checkpoint?.run).toContain('--source-sha "$SOURCE_SHA"');
  const release = steps.find((step) => step.id === "release");
  expect(release?.with).toMatchObject({
    "target-branch": "main",
    "skip-github-release": false,
    "skip-github-pull-request": true,
  });
  const bind = steps.find(
    (step) => step.name === "Bind publication to the reviewed merge",
  );
  expect(bind?.env).toMatchObject({
    SOURCE_SHA: "${{ github.event.pull_request.merge_commit_sha }}",
    RELEASE_SHA: "${{ steps.release.outputs.sha }}",
  });
});

it("keeps frozen candidate preparation and publication explicit", async () => {
  const workflow = await readReleaseWorkflow();
  expect(workflow.on.workflow_dispatch).toMatchObject({
    inputs: {
      release_branch: { required: true, type: "string" },
      phase: {
        required: true,
        type: "choice",
        default: "prepare",
        options: ["prepare", "publish"],
      },
    },
  });
  const release = workflow.jobs["release-please"].steps.find((step) =>
    step.uses?.startsWith("googleapis/release-please-action@"),
  );
  expect(release?.with).toMatchObject({
    token: "${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}",
    "target-branch": "${{ inputs.release_branch }}",
    "skip-github-release": "${{ inputs.phase == 'prepare' }}",
    "skip-github-pull-request": "${{ inputs.phase == 'publish' }}",
  });
  const catalogValidation = workflow.jobs["release-please"].steps.find(
    (step) => step.name === "Validate generated release documentation",
  );
  expect(catalogValidation?.run).toBe(
    "npm run docs:check && git diff --exit-code",
  );
});

it.skipIf(process.platform === "win32").each([
  { phase: "prepare", customToken: "" },
  { phase: "publish", customToken: "" },
  { phase: "prepare", customToken: "fixture-custom-token" },
  { phase: "publish", customToken: "fixture-custom-token" },
])(
  "accepts $phase with optional custom credentials: $customToken",
  async ({ phase, customToken }) => {
    const workflow = await readReleaseWorkflow();
    const steps = workflow.jobs["release-please"].steps;
    const actionIndex = steps.findIndex((step) =>
      step.uses?.startsWith("googleapis/release-please-action@"),
    );
    expect(actionIndex).toBeGreaterThanOrEqual(0);
    const commands = steps
      .slice(0, actionIndex)
      .filter((step) =>
        [
          "Validate release selection",
          "Resolve release branch tip",
          "Require the publish dispatch to match the branch tip",
        ].includes(step.name ?? ""),
      )
      .filter(
        (step) =>
          step.if === undefined ||
          (phase === "publish" && step.if === "inputs.phase == 'publish'"),
      )
      .map((step) => z.string().parse(step.run));
    const directory = await createTestTempDirectory("rea-release-credential-");
    const output = join(directory, "github-output");
    await writeFile(
      join(directory, "gh"),
      '#!/bin/sh\nprintf "%s\\n" "$GITHUB_SHA"\n',
      { mode: 0o755 },
    );
    await expect(
      execFileAsync(
        "bash",
        ["-e", "-o", "pipefail", "-c", commands.join("\n")],
        {
          env: {
            ...process.env,
            PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
            RELEASE_PLEASE_TOKEN: customToken,
            GH_TOKEN: customToken || "fixture-built-in-token",
            RELEASE_PHASE: phase,
            RELEASE_BRANCH: "release/5.0.0",
            GITHUB_REF:
              phase === "prepare"
                ? "refs/heads/main"
                : "refs/heads/release/5.0.0",
            GITHUB_REPOSITORY: "fixture/fixture",
            GITHUB_SHA: "1111111111111111111111111111111111111111",
            BRANCH_SHA: "1111111111111111111111111111111111111111",
            GITHUB_OUTPUT: output,
          },
        },
      ),
    ).resolves.toMatchObject({ stderr: "" });
    expect(await readFile(output, "utf8")).toBe(
      "sha=1111111111111111111111111111111111111111\n",
    );
  },
);

it("binds npm and MCP publication to the same immutable release SHA", async () => {
  const workflow = await readReleaseWorkflow();
  expect(workflow.jobs["release-please"].outputs).toEqual({
    release_created: "${{ steps.release.outputs.release_created }}",
    sha: "${{ steps.release.outputs.sha }}",
  });
  expect(workflow.jobs.publish.if).toContain("inputs.phase == 'publish'");
  expect(workflow.jobs.publish.if).toContain(
    "needs.release-please.outputs.release_created",
  );
  expect(workflow.jobs["publish-mcp"].if).toContain(
    "needs.publish.result == 'success'",
  );
  expect(workflow.jobs.publish.needs).toContain("merged-release");
  expect(workflow.jobs["publish-mcp"].needs).toContain("merged-release");
  for (const job of [workflow.jobs.publish, workflow.jobs["publish-mcp"]]) {
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with).toMatchObject({
      ref: "${{ needs.merged-release.outputs.sha || needs.release-please.outputs.sha }}",
      "persist-credentials": false,
    });
  }
  const preparation = [
    "Check out release pull request",
    "Set up Node.js for generated documentation",
    "Install dependencies",
    "Regenerate release documentation",
    "Validate generated release documentation",
  ];
  for (const name of preparation) {
    expect(
      workflow.jobs["release-please"].steps.find((step) => step.name === name)
        ?.if,
    ).toBe(
      "inputs.phase == 'prepare' && steps.release.outputs.prs_created == 'true'",
    );
  }
  const publishCommand = workflow.jobs.publish.steps.find(
    (step) => step.name === "Publish",
  )?.run;
  expect(publishCommand).toContain("scripts/release-npm-tag.mjs");
  expect(publishCommand).toContain(
    'npm publish --access public --tag "${tag}"',
  );
  for (const [version, tag] of [
    ["6.1.0", "latest"],
    ["6.1.0-rc.1", "next"],
  ] as const) {
    const helper = new URL(
      "../../../scripts/release-npm-tag.mjs",
      import.meta.url,
    );
    const result = await execFileAsync(process.execPath, [
      helper.pathname,
      version,
    ]);
    expect(result.stdout).toBe(tag);
  }
});

it.skipIf(process.platform === "win32").each([
  {
    created: "false",
    releaseSha: "1111111111111111111111111111111111111111",
    succeeds: false,
    reason: "did not create a release",
  },
  {
    created: "true",
    releaseSha: "1111111111111111111111111111111111111111",
    succeeds: true,
  },
  {
    created: "true",
    releaseSha: "2222222222222222222222222222222222222222",
    succeeds: false,
    reason: "refusing mismatched publication provenance",
  },
])(
  "publishes a merged release only when Release Please creates it at the reviewed SHA: $created/$releaseSha",
  async ({ created, releaseSha, succeeds, reason }) => {
    const workflow = await readReleaseWorkflow();
    const command = z
      .string()
      .parse(
        workflow.jobs["merged-release"].steps.find(
          (step) => step.name === "Bind publication to the reviewed merge",
        )?.run,
      );
    const result = execFileAsync(
      "bash",
      ["-e", "-o", "pipefail", "-c", command],
      {
        env: {
          ...process.env,
          SOURCE_SHA: "1111111111111111111111111111111111111111",
          RELEASE_CREATED: created,
          RELEASE_SHA: releaseSha,
        },
      },
    );
    if (succeeds) {
      await expect(result).resolves.toMatchObject({ stderr: "" });
    } else {
      await expect(result).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(z.string().parse(reason)),
      });
    }
  },
);

it
  .skipIf(process.platform === "win32")
  .each(["main", "feature/new-work", "release/", "release/../main"])(
  "rejects %s as a checkpoint before contacting GitHub",
  async (releaseBranch) => {
    const workflow = await readReleaseWorkflow();
    const command = z
      .string()
      .parse(
        workflow.jobs["release-please"].steps.find(
          (step) => step.name === "Validate release selection",
        )?.run,
      );
    await expect(
      execFileAsync("bash", ["-e", "-o", "pipefail", "-c", command], {
        env: {
          ...process.env,
          GITHUB_REF: "refs/heads/main",
          RELEASE_BRANCH: releaseBranch,
          RELEASE_PHASE: "prepare",
        },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/release_branch/u),
    });
  },
);

it.skipIf(process.platform === "win32").each([
  { phase: "prepare", ref: "refs/heads/feature/unreviewed-workflow" },
  { phase: "publish", ref: "refs/heads/main" },
  { phase: "publish", ref: "refs/heads/release/another-version" },
])(
  "rejects $phase from $ref before contacting GitHub",
  async ({ phase, ref }) => {
    const workflow = await readReleaseWorkflow();
    const command = z
      .string()
      .parse(
        workflow.jobs["release-please"].steps.find(
          (step) => step.name === "Validate release selection",
        )?.run,
      );
    await expect(
      execFileAsync("bash", ["-e", "-o", "pipefail", "-c", command], {
        env: {
          ...process.env,
          GITHUB_REF: ref,
          RELEASE_BRANCH: "release/5.0.0",
          RELEASE_PHASE: phase,
        },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`Run ${phase} from`),
    });
  },
);

it.skipIf(process.platform === "win32")(
  "checks the checkpoint locally and resolves the branch tip separately",
  async () => {
    const workflow = await readReleaseWorkflow();
    const validate = z
      .string()
      .parse(
        workflow.jobs["release-please"].steps.find(
          (step) => step.name === "Validate release selection",
        )?.run,
      );
    expect(validate).not.toMatch(/\bgh\b/u);
    const resolve = z
      .string()
      .parse(
        workflow.jobs["release-please"].steps.find(
          (step) => step.name === "Resolve release branch tip",
        )?.run,
      );
    expect(resolve).toContain("gh api");
    for (const releaseBranch of ["release/5.0.0", "release/5.0.0-rc.1"]) {
      await expect(
        execFileAsync("bash", ["-e", "-o", "pipefail", "-c", validate], {
          env: {
            ...process.env,
            GITHUB_REF: "refs/heads/main",
            RELEASE_BRANCH: releaseBranch,
            RELEASE_PHASE: "prepare",
          },
        }),
      ).resolves.toMatchObject({ stderr: "" });
    }
  },
);

it
  .skipIf(process.platform === "win32")
  .each(["", "release", "prepare ", "true"])(
  "rejects phase %j before contacting GitHub",
  async (phase) => {
    const workflow = await readReleaseWorkflow();
    const command = z
      .string()
      .parse(
        workflow.jobs["release-please"].steps.find(
          (step) => step.name === "Validate release selection",
        )?.run,
      );
    await expect(
      execFileAsync("bash", ["-e", "-o", "pipefail", "-c", command], {
        env: {
          ...process.env,
          GITHUB_REF: "refs/heads/main",
          RELEASE_BRANCH: "release/5.0.0",
          RELEASE_PHASE: phase,
        },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("phase must be prepare or publish"),
    });
  },
);

it.skipIf(process.platform === "win32").each([true, false])(
  "creates a release only when the branch tip is the dispatched checkpoint (match: %s)",
  async (match) => {
    const workflow = await readReleaseWorkflow();
    const command = z
      .string()
      .parse(
        workflow.jobs["release-please"].steps.find(
          (step) =>
            step.name ===
            "Require the publish dispatch to match the branch tip",
        )?.run,
      );
    const result = execFileAsync(
      "bash",
      ["-e", "-o", "pipefail", "-c", command],
      {
        env: {
          ...process.env,
          GITHUB_SHA: "1111111111111111111111111111111111111111",
          BRANCH_SHA: match
            ? "1111111111111111111111111111111111111111"
            : "2222222222222222222222222222222222222222",
        },
      },
    );
    if (match) {
      await expect(result).resolves.toMatchObject({ stderr: "" });
    } else {
      await expect(result).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "refusing to create a release for a moved source",
        ),
      });
    }
  },
);

it.skipIf(process.platform === "win32").each([true, false])(
  "publishes only when the tag and provenance source match (match: %s)",
  async (match) => {
    const workflow = await readReleaseWorkflow();
    const command = z
      .string()
      .parse(
        workflow.jobs["release-please"].steps.find(
          (step) =>
            step.name === "Bind publication to the dispatched checkpoint",
        )?.run,
      );
    const result = execFileAsync(
      "bash",
      ["-e", "-o", "pipefail", "-c", command],
      {
        env: {
          ...process.env,
          GITHUB_SHA: "1111111111111111111111111111111111111111",
          RELEASE_SHA: match
            ? "1111111111111111111111111111111111111111"
            : "2222222222222222222222222222222222222222",
        },
      },
    );
    if (match) {
      await expect(result).resolves.toMatchObject({ stderr: "" });
    } else {
      await expect(result).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "refusing to publish mismatched source provenance",
        ),
      });
    }
  },
);

it("runs release PR CI without enabling implementation pushes on release branches", async () => {
  const workflow = z
    .object({
      on: z.object({
        push: z.object({ branches: z.array(z.string()) }),
        pull_request: z.object({ branches: z.array(z.string()) }),
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
  expect(workflow.on.push.branches).toEqual(["main"]);
  expect(workflow.on.pull_request.branches).toEqual(
    expect.arrayContaining(["main", "release/*"]),
  );
});

it("checks website changes on release-branch pull requests", async () => {
  const workflow = z
    .object({
      on: z.object({
        pull_request: z.object({ branches: z.array(z.string()) }),
      }),
    })
    .parse(
      parse(
        await readFile(
          new URL(
            "../../../.github/workflows/website-check.yml",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
  expect(workflow.on.pull_request.branches).toEqual(["main", "release/*"]);
});

// Publishing is irreversible. Keep the release authority invariant as a static
// boundary check; it is not proof that package installation or publishing works.
it("requires package verification before publishing and retains the registry canary", async () => {
  const workflow = z
    .object({
      jobs: z.object({
        publish: z.object({
          steps: z.array(z.object({ run: z.string().optional() })),
        }),
      }),
    })
    .parse(
      parse(
        await readFile(
          new URL("../../../.github/workflows/release.yml", import.meta.url),
          "utf8",
        ),
      ),
    );
  const commands = workflow.jobs.publish.steps.map(({ run }) => run ?? "");
  const verify = commands.findIndex((command) =>
    command.includes("npm run verify:package"),
  );
  const publish = commands.findIndex((command) =>
    command.includes("npm publish"),
  );
  expect(verify).toBeGreaterThanOrEqual(0);
  expect(publish).toBeGreaterThan(verify);
  expect(
    commands
      .slice(publish + 1)
      .some((command) => command.includes("verify-published-package.mjs")),
  ).toBe(true);
});
