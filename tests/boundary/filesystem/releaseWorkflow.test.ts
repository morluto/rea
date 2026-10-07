import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const stepSchema = z.object({
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});
const jobSchema = z.object({
  outputs: z.record(z.string(), z.string()).optional(),
  steps: z.array(stepSchema),
});

async function readReleaseWorkflow() {
  return z
    .object({
      on: z.record(z.string(), z.unknown()),
      jobs: z.object({
        "release-please": jobSchema,
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

it("requires explicit release preparation or publication instead of main pushes", async () => {
  const workflow = await readReleaseWorkflow();
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
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
    "target-branch": "${{ inputs.release_branch }}",
    "skip-github-release": "${{ inputs.phase == 'prepare' }}",
    "skip-github-pull-request": "${{ inputs.phase == 'publish' }}",
  });
});

it("binds npm and MCP publication to the same immutable release SHA", async () => {
  const workflow = await readReleaseWorkflow();
  expect(workflow.jobs["release-please"].outputs?.sha).toBe(
    "${{ steps.release.outputs.sha }}",
  );
  for (const job of [workflow.jobs.publish, workflow.jobs["publish-mcp"]]) {
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with).toMatchObject({
      ref: "${{ needs.release-please.outputs.sha }}",
      "persist-credentials": false,
    });
  }
});

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
