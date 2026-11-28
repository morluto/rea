import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { runInNewContext } from "node:vm";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// These policy expressions use only JS-compatible boolean operators, property
// access, literals and format; exercise the parsed workflow rather than copies.
const evaluatePolicy = (
  expression: string,
  context: Record<string, unknown>,
): unknown =>
  runInNewContext(
    expression
      .replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
      .replace(
        /\b(steps|outputs)\.([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/gu,
        (_reference, parent: string, key: string) =>
          `${parent}[${JSON.stringify(key)}]`,
      ),
    {
      ...context,
      format: (template: string, value: string) =>
        template.replace("{0}", value),
    },
    { timeout: 100 },
  );

const assertRetentionPolicy = (expression: string): void => {
  for (const [currentRepository, defaultBranch] of [
    ["owner/repo", "main"],
    ["another/project", "stable"],
  ]) {
    for (const conclusion of [
      "success",
      "failure",
      "timed_out",
      "cancelled",
      "skipped",
      "action_required",
    ]) {
      for (const event of [
        "push",
        "schedule",
        "workflow_dispatch",
        "pull_request",
        "workflow_call",
        "deployment",
      ]) {
        for (const [repositoryName, branch] of [
          [currentRepository, defaultBranch],
          ["untrusted/fork", defaultBranch],
          [currentRepository, "feature"],
        ]) {
          const permitted =
            repositoryName === currentRepository &&
            branch === defaultBranch &&
            ["push", "schedule", "workflow_dispatch"].includes(event) &&
            ["success", "failure", "timed_out"].includes(conclusion);
          expect(
            evaluatePolicy(expression, {
              github: {
                repository: currentRepository,
                event: {
                  repository: { default_branch: defaultBranch },
                  workflow_run: {
                    conclusion,
                    event,
                    head_repository: { full_name: repositoryName },
                    head_branch: branch,
                  },
                },
              },
            }),
            `${currentRepository}:${defaultBranch}:${repositoryName}:${branch}:${event}:${conclusion}`,
          ).toBe(permitted);
        }
      }
    }
  }
};

const repository = process.cwd();
const actionPath = join(repository, ".github/actions/npm-cache/action.yml");
const readAction = async () =>
  z
    .object({
      inputs: z
        .record(
          z.string(),
          z.object({ default: z.string().optional() }).passthrough(),
        )
        .optional(),
      outputs: z.record(z.string(), z.object({ value: z.string() })),
      runs: z.object({
        steps: z.array(
          z.object({
            id: z.string().optional(),
            if: z.string().optional(),
            uses: z.string().optional(),
            with: z.record(z.string(), z.string()).optional(),
            run: z.string().optional(),
            env: z.record(z.string(), z.string()).optional(),
          }),
        ),
      }),
    })
    .parse(parse(await readFile(actionPath, "utf8")));

const readWorkflows = async () => {
  const directory = join(repository, ".github/workflows");
  const files = (await readdir(directory)).filter((file) =>
    /\.ya?ml$/u.test(file),
  );
  return Promise.all(
    files.map(async (file) => ({
      file,
      workflow: z
        .object({
          env: z.record(z.string(), z.unknown()).optional(),
          jobs: z
            .record(
              z.string(),
              z
                .object({
                  env: z.record(z.string(), z.unknown()).optional(),
                  steps: z
                    .array(
                      z
                        .object({
                          uses: z.string().optional(),
                          with: z.record(z.string(), z.unknown()).optional(),
                        })
                        .passthrough(),
                    )
                    .optional(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough()
        .parse(parse(await readFile(join(directory, file), "utf8"))),
    })),
  );
};

let workflows: Awaited<ReturnType<typeof readWorkflows>>;
beforeAll(async () => {
  workflows = await readWorkflows();
});

function aggregateHashFilesContent(contents: Buffer[]) {
  const aggregate = createHash("sha256");
  for (const content of contents)
    aggregate.update(createHash("sha256").update(content).digest());
  return aggregate.digest("hex");
}

async function verifyPrefixedHashFiles(
  retentionEnv: Record<string, string>,
  runnerWorkspace: string,
  legacyRoot: string,
) {
  const keyExpressions = [
    retentionEnv.CACHE_KEEP_KEY,
    retentionEnv.CACHE_DEEP_KEEP_KEY,
    retentionEnv.CACHE_KNIP_KEEP_KEY,
  ];
  let targetHash: string | undefined;
  for (const expression of keyExpressions) {
    if (expression === undefined)
      throw new Error("Missing retention cache key");
    const paths = expression.match(/hashFiles\(([^)]*)\)/u)?.[1];
    expect(paths).toBeDefined();
    const targetPaths = paths!.split(", ").map((path) => path.slice(1, -1));
    expect(
      targetPaths.every((path) => path.startsWith("triggering-source/")),
    ).toBe(true);
    const fileNames = targetPaths.map((path) =>
      path.slice("triggering-source/".length),
    );
    expect(fileNames.every((name) => !name.includes("/"))).toBe(true);
    const nestedHash = aggregateHashFilesContent(
      await Promise.all(
        targetPaths.map((path) => readFile(join(runnerWorkspace, path))),
      ),
    );
    const flatHash = aggregateHashFilesContent(
      await Promise.all(
        fileNames.map((name) => readFile(join(legacyRoot, name))),
      ),
    );
    expect(nestedHash).toBe(flatHash);
    if (expression === retentionEnv.CACHE_KEEP_KEY) targetHash = nestedHash;
  }
  expect(targetHash).toBeDefined();
  return targetHash!;
}

const retentionKeyFiles = [
  ".npmrc",
  ".nvmrc",
  "knip.json",
  "package-lock.json",
  "package.json",
  "tsconfig.json",
];

async function exerciseTrustedRetentionWithLegacyTarget(
  retentionRun: unknown,
  retentionEnv: Record<string, string>,
  trustedSparseCheckout: string,
) {
  const runnerWorkspace = await createTestTempDirectory(
    "rea-ci-retention-trusted-checkout-",
  );
  const legacyTarget = join(runnerWorkspace, "triggering-source");
  const legacyRoot = join(runnerWorkspace, "legacy-root");
  const trustedSource = join(runnerWorkspace, "trusted-retention");
  const targetSha = "0123456789abcdef0123456789abcdef01234567";
  await mkdir(legacyTarget, { recursive: true });
  await mkdir(legacyRoot, { recursive: true });
  for (const name of retentionKeyFiles) {
    const contents = `target-source:${name}\n`;
    await writeFile(join(legacyTarget, name), contents);
    await writeFile(join(legacyRoot, name), contents);
  }
  const trustedHelperPath = join(
    trustedSource,
    "scripts/ci/cache-retention.mjs",
  );
  for (const pattern of trustedSparseCheckout.trim().split("\n")) {
    expect(pattern).toMatch(/^\/(?:\.nvmrc|scripts\/ci\/[\w-]+\.mjs)$/u);
    const filename = pattern.slice(1);
    const destination = join(trustedSource, filename);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(repository, filename), destination);
  }
  await expect(access(join(trustedSource, ".nvmrc"))).resolves.toBeUndefined();
  await expect(
    access(join(legacyTarget, "scripts/ci/cache-retention.mjs")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(trustedHelperPath)).resolves.toBeUndefined();

  // Actions hashFiles hashes file bytes, then the ordered per-file digests.
  // A common checkout-directory prefix preserves both file contents and order.
  const targetHash = await verifyPrefixedHashFiles(
    retentionEnv,
    runnerWorkspace,
    legacyRoot,
  );

  const prefix = "rea-static-v1-Linux-X64-";
  const keepKey = `${prefix}${targetHash}-${targetSha}`;
  const cacheFixture = {
    actions_caches: [
      {
        id: 1,
        key: `${prefix}old`,
        created_at: "2026-10-01T00:00:00Z",
        last_accessed_at: "2026-10-01T00:00:00Z",
        size_in_bytes: 10,
        version: "a".repeat(64),
        ref: "refs/heads/main",
      },
      {
        id: 2,
        key: `${prefix}mid`,
        created_at: "2026-10-15T00:00:00Z",
        last_accessed_at: "2026-10-15T00:00:00Z",
        size_in_bytes: 20,
        version: "a".repeat(64),
        ref: "refs/heads/main",
      },
      {
        id: 3,
        key: `${prefix}new`,
        created_at: "2026-10-20T00:00:00Z",
        last_accessed_at: "2026-10-20T00:00:00Z",
        size_in_bytes: 30,
        version: "a".repeat(64),
        ref: "refs/heads/main",
      },
      {
        id: 4,
        key: keepKey,
        created_at: "2026-09-30T00:00:00Z",
        last_accessed_at: "2026-09-30T00:00:00Z",
        size_in_bytes: 40,
        version: "a".repeat(64),
        ref: "refs/heads/main",
      },
    ],
  };
  const ghPath = join(runnerWorkspace, "bin/gh");
  const ghLog = join(runnerWorkspace, "fake-gh.log");
  const cacheInput = join(runnerWorkspace, "cache-list.json");
  await mkdir(join(runnerWorkspace, "bin"), { recursive: true });
  await writeFile(cacheInput, JSON.stringify(cacheFixture));
  await writeFile(
    ghPath,
    `#!${process.execPath}\nconst fs = require("node:fs");\nconst [command, option, method, endpoint] = process.argv.slice(2);\nif (command !== "api" || option !== "--method") process.exit(2);\nfs.appendFileSync(process.env.FAKE_GH_LOG, method + " " + endpoint + "\\n");\nif (method === "GET") process.stdout.write(fs.readFileSync(process.env.FAKE_GH_CACHE_INPUT, "utf8"));\nelse if (method !== "DELETE") process.exit(2);\n`,
  );
  await chmod(ghPath, 0o755);
  expect(retentionRun).toBe(
    "node trusted-retention/scripts/ci/cache-retention.mjs",
  );
  const helperPath = join(
    runnerWorkspace,
    String(retentionRun).replace(/^node /u, ""),
  );
  const command = execFileSync(process.execPath, [helperPath], {
    cwd: runnerWorkspace,
    env: {
      PATH: join(runnerWorkspace, "bin"),
      CI_REPOSITORY: "morluto/rea",
      CACHE_PREFIX: prefix,
      CACHE_KEEP_KEY: keepKey,
      FAKE_GH_LOG: ghLog,
      FAKE_GH_CACHE_INPUT: cacheInput,
    },
    encoding: "utf8",
  });
  const requests = await readFile(ghLog, "utf8");
  expect(JSON.parse(command)).toEqual({
    dryRun: false,
    families: [{ prefix, deleteCount: 1, deleteBytes: 10 }],
    npmDuplicateDeleteCount: 0,
    npmDuplicateDeleteBytes: 0,
  });
  const calls = requests.trim().split("\n");
  expect(calls).toHaveLength(2);
  const [listing, deletion] = calls;
  expect(listing).toMatch(/^GET /u);
  const endpoint = new URL(
    listing!.slice("GET ".length),
    "https://example.test",
  );
  expect(endpoint.pathname).toBe("/repos/morluto/rea/actions/caches");
  expect(Object.fromEntries(endpoint.searchParams)).toEqual({
    per_page: "100",
    page: "1",
    sort: "created_at",
    direction: "desc",
    key: prefix,
  });
  expect(deletion).toBe("DELETE repos/morluto/rea/actions/caches/1");
}

describe("hosted npm download-cache policy", () => {
  it("only allows shared writes for trusted original default-branch events", async () => {
    const action = await readAction();
    const policy = action.runs.steps.find((step) => step.id === "context");
    const command = z.string().parse(policy?.run);

    const outputDirectory = await createTestTempDirectory(
      "rea-ci-cache-policy-",
    );
    const npmStub = join(outputDirectory, "npm");
    await writeFile(
      npmStub,
      String.raw`#!/bin/sh
printf '%s\n' 'C:\Users\runner with spaces\AppData\Local\npm-cache'
`,
    );
    await chmod(npmStub, 0o755);

    for (const [event, ref, defaultBranch, expected] of [
      ["push", "refs/heads/main", "main", "true"],
      ["schedule", "refs/heads/main", "main", "true"],
      ["workflow_dispatch", "refs/heads/main", "main", "true"],
      ["push", "refs/heads/stable", "stable", "true"],
      ["pull_request", "refs/heads/main", "main", "false"],
      ["pull_request_target", "refs/heads/main", "main", "false"],
      ["workflow_call", "refs/heads/main", "main", "false"],
      ["push", "refs/heads/feature/cache", "main", "false"],
      ["push", "refs/heads/main", "stable", "false"],
      ["push", "refs/heads/main", "", "false"],
    ]) {
      const outputPath = join(
        outputDirectory,
        `policy-${Date.now()}-${Math.random()}`,
      );
      execFileSync("bash", ["-euo", "pipefail", "-c", command], {
        env: {
          ...process.env,
          PATH: `${outputDirectory}${delimiter}${process.env.PATH ?? ""}`,
          GITHUB_EVENT_NAME: event,
          GITHUB_REF: ref,
          GITHUB_OUTPUT: outputPath,
          DEFAULT_BRANCH: defaultBranch,
          LOCKFILES_HASH: "lock-hash",
          RUNNER_OS: "Windows",
        },
      });
      const output = await readFile(outputPath, "utf8");
      expect(output).toContain(`can-save=${expected}\n`);
      expect(output).toContain(
        `path=${String.raw`C:\Users\runner with spaces\AppData\Local\npm-cache`}\n`,
      );
      expect(output).toContain(
        `key=npm-download-Windows-${process.arch}-lock-hash\n`,
      );
      expect(output).toContain(
        `restore-key=npm-download-Windows-${process.arch}-\n`,
      );
    }
  });

  it("uses a lockfile-, npmrc-, OS-, and runtime-architecture-scoped download cache", async () => {
    const action = await readAction();
    const policy = action.runs.steps.find((step) => step.id === "context");
    const restoreAndSave = action.runs.steps.find((step) =>
      step.uses?.startsWith("actions/cache@"),
    );
    const restoreOnly = action.runs.steps.find((step) =>
      step.uses?.startsWith("actions/cache/restore@"),
    );

    expect(action.inputs?.save?.default).toBe("false");
    expect(action.outputs["can-save"]?.value).toBe(
      "${{ steps.context.outputs.can-save }}",
    );
    expect(action.outputs.path?.value).toBe(
      "${{ steps.context.outputs.path }}",
    );
    expect(policy?.env?.DEFAULT_BRANCH).toBe(
      "${{ github.event.repository.default_branch }}",
    );
    expect(policy?.env?.LOCKFILES_HASH).toBe(
      "${{ hashFiles('package-lock.json', 'npm-shrinkwrap.json', '.npmrc') }}",
    );
    const revision = restoreAndSave?.uses?.split("@")[1];
    expect(revision).toMatch(/^[0-9a-f]{40}$/u);
    expect(restoreAndSave?.if).toBe(
      "steps.context.outputs.can-save == 'true' && inputs.save == 'true'",
    );
    expect(restoreOnly?.uses).toBe(`actions/cache/restore@${revision}`);
    expect(restoreOnly?.if).toBe(
      "steps.context.outputs.can-save != 'true' || inputs.save != 'true'",
    );
    expect(restoreAndSave?.with?.path).toBe(
      "${{ steps.context.outputs.path }}",
    );
    expect(restoreOnly?.with?.path).toBe(restoreAndSave?.with?.path);
    expect(restoreAndSave?.with?.key).toBe("${{ steps.context.outputs.key }}");
    expect(restoreOnly?.with?.key).toBe(restoreAndSave?.with?.key);
    expect(restoreAndSave?.with?.["restore-keys"]).toBe(
      "${{ steps.context.outputs.restore-key }}",
    );
    expect(restoreOnly?.with?.["restore-keys"]).toBe(
      restoreAndSave?.with?.["restore-keys"],
    );
  });

  it("pairs npm caches with preceding Node setup and preserves conditions", async () => {
    let npmCacheSteps = 0;

    for (const { file, workflow } of workflows) {
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        const steps = job.steps ?? [];
        for (let index = 0; index < steps.length; index++) {
          const step = steps[index];
          if (
            typeof step?.uses === "string" &&
            step.uses.startsWith("actions/setup-node@")
          ) {
            expect(step.with).not.toHaveProperty("cache", "npm");
            expect(step.with).toMatchObject({ "package-manager-cache": false });
          }
          if (step?.uses !== "./.github/actions/npm-cache") continue;
          npmCacheSteps++;
          const setup = steps
            .slice(0, index)
            .findLast(
              (candidate) =>
                typeof candidate.uses === "string" &&
                candidate.uses.startsWith("actions/setup-node@"),
            );
          expect(
            setup,
            `${file}:${jobName} npm cache action requires preceding setup-node`,
          ).toBeDefined();
          expect(step.if).toBe(setup?.if);
          const installCommand =
            file === "ci-timings.yml" && jobName === "report"
              ? "npm ci --omit=dev --ignore-scripts"
              : "npm ci";
          const npmCiIndex = steps.findIndex(
            (candidate, candidateIndex) =>
              candidateIndex > index && candidate.run === installCommand,
          );
          expect(
            npmCiIndex,
            `${file}:${jobName} retains npm ci after cache`,
          ).toBeGreaterThan(index);
        }
      }
    }

    expect(npmCacheSteps).toBeGreaterThan(0);
  });
});

const expectSavePolicy = (
  expression: unknown,
  restore: string,
  requiresCode: boolean,
) => {
  const condition = z.string().parse(expression);
  for (const [success, allowed, hit, code, expected] of [
    [true, true, "", true, true],
    [true, true, "false", true, true],
    [false, true, "false", true, false],
    [true, false, "false", true, false],
    [true, true, "true", true, false],
    [true, true, "false", false, !requiresCode],
  ] as const) {
    expect(
      evaluatePolicy(condition, {
        success: () => success,
        needs: { changes: { outputs: { code: String(code) } } },
        steps: {
          "npm-cache": { outputs: { "can-save": String(allowed) } },
          [restore]: { outputs: { "cache-hit": hit } },
        },
      }),
      `${restore} save with success=${success}, allowed=${allowed}, hit=${JSON.stringify(hit)}, code=${code}`,
    ).toBe(expected);
  }
};

it("shares static task snapshots only after validation using the npm cache owner's write authority", async () => {
  const ci = workflows.find(({ file }) => file === "ci.yml");
  const steps = ci?.workflow.jobs?.static?.steps ?? [];
  expect(
    steps.find((step) => step.uses === "./.github/actions/npm-cache")?.id,
  ).toBe("npm-cache");
  const restore = steps.find((step) => step.id === "static-cache");
  const save = steps.find(
    (step) => step.name === "Save validated static task cache",
  );
  expect(restore?.uses).toMatch(/^actions\/cache\/restore@/u);
  expect(restore?.if).toBe("needs.changes.outputs.code == 'true'");
  expect(restore?.with).toMatchObject({ path: ".turbo/cache/" });
  expect(save?.uses).toMatch(/^actions\/cache\/save@/u);
  expectSavePolicy(save?.if, "static-cache", true);
  expect(save?.with).toEqual({
    path: ".turbo/cache/",
    key: "${{ steps.static-cache.outputs.cache-primary-key }}",
  });
  const fastCheck = steps.findIndex(
    (step) => step.run === "npm run check:ci:fast",
  );
  expect(fastCheck).toBeGreaterThanOrEqual(0);
  expect(steps.indexOf(save!)).toBeGreaterThan(fastCheck);
  const deep = ci?.workflow.jobs?.["static-deep"]?.steps ?? [];
  const deepSave = deep.find(
    (step) => step.name === "Save validated deep static task cache",
  );
  const build = ci?.workflow.jobs?.build?.steps ?? [];
  const knipRestore = build.find((step) => step.id === "knip-cache");
  const knipSave = build.find(
    (step) => step.name === "Save Knip analysis cache",
  );
  const knipCheck = build.findIndex(
    (step) => step.run === "node scripts/run-turbo.mjs run knip",
  );
  expect(deepSave?.uses).toMatch(/^actions\/cache\/save@/u);
  expectSavePolicy(deepSave?.if, "static-cache", false);
  const deepCheck = deep.findIndex(
    (step) => step.run === "npm run check:ci:deep:job",
  );
  expect(deepCheck).toBeGreaterThanOrEqual(0);
  expect(deep.indexOf(deepSave!)).toBeGreaterThan(deepCheck);
  expect(knipCheck).toBeGreaterThan(
    build.findIndex((step) => step.run === "npm run test:prepare"),
  );
  expect(build.indexOf(knipRestore!)).toBeLessThan(knipCheck);
  expect(build.indexOf(knipSave!)).toBeGreaterThan(knipCheck);
  const knipWith = z
    .object({
      path: z.string(),
      key: z.string(),
      "restore-keys": z.string(),
    })
    .parse(knipRestore?.with);
  expect(knipWith.path).toBe("node_modules/.cache/knip");
  expect(knipWith.key).toContain("${{ github.sha }}");
  expect(knipWith["restore-keys"]).not.toContain("github.sha");
  expect(knipWith["restore-keys"].startsWith("knip-meta-v1-")).toBe(true);
  expectSavePolicy(knipSave?.if, "knip-cache", true);
  expect(knipSave?.with).toEqual({
    path: "node_modules/.cache/knip",
    key: "${{ steps.knip-cache.outputs.cache-primary-key }}",
  });
  expect(
    steps.find((step) => step.run === "node scripts/ci/cache-retention.mjs"),
  ).toBeUndefined();
});

it("deletes superseded caches only from the trusted follow-up workflow", async () => {
  const workflow = z
    .object({
      on: z.object({
        workflow_run: z.object({
          workflows: z.array(z.literal("CI")),
          types: z.array(z.literal("completed")),
          branches: z.array(z.literal("main")),
        }),
        workflow_call: z.unknown().optional(),
        pull_request: z.unknown().optional(),
      }),
      permissions: z.record(z.string(), z.string()),
      jobs: z.record(
        z.string(),
        z.object({
          if: z.string(),
          "runs-on": z.literal("ubuntu-latest"),
          steps: z.array(z.record(z.string(), z.unknown())),
        }),
      ),
    })
    .parse(
      workflows.find(({ file }) => file === "cache-retention.yml")?.workflow,
    );
  expect(workflow.on.workflow_call).toBeUndefined();
  expect(workflow.on.pull_request).toBeUndefined();
  expect(workflow.permissions).toEqual({
    contents: "read",
    actions: "write",
  });
  const job = workflow.jobs.retain;
  assertRetentionPolicy(z.string().parse(job?.if));
  const steps = job?.steps ?? [];
  expect(steps.some((step) => step.run === "npm ci")).toBe(false);
  const checkouts = steps.filter(
    (step) =>
      step.uses === "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
  );
  const trustedCheckout = checkouts[0];
  expect(trustedCheckout?.with).toMatchObject({
    ref: "${{ github.workflow_sha }}",
    path: "trusted-retention",
    "persist-credentials": false,
    "sparse-checkout-cone-mode": false,
  });
  const targetCheckout = checkouts[1];
  expect(targetCheckout?.with).toMatchObject({
    ref: "${{ github.event.workflow_run.head_sha }}",
    path: "triggering-source",
    "persist-credentials": false,
    "sparse-checkout-cone-mode": false,
    "sparse-checkout": retentionKeyFiles.map((name) => `/${name}\n`).join(""),
  });
  expect(checkouts).toHaveLength(2);
  const setupNode = steps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/setup-node@"),
  );
  expect(setupNode?.with).toMatchObject({
    "node-version-file": "trusted-retention/.nvmrc",
  });
  const retention = steps.find(
    (step) =>
      step.run === "node trusted-retention/scripts/ci/cache-retention.mjs",
  );
  expect(retention).toBeDefined();
  const retentionEnv = z.record(z.string(), z.string()).parse(retention?.env);
  expect(retentionEnv.CACHE_PREFIX).toBe(
    "rea-static-v1-${{ runner.os }}-${{ runner.arch }}-",
  );
  expect(retentionEnv.CACHE_PORTABLE_PREFIX).toBe(
    "rea-portable-build-v2-${{ runner.os }}-${{ runner.arch }}-",
  );
  expect(retentionEnv.CACHE_WINDOWS_BUILD_PREFIX).toBe(
    "rea-windows-build-v1-Windows-X64-",
  );
  expect(retentionEnv.DEDUPE_NPM_DOWNLOADS).toBe("true");
  expect(retentionEnv.GH_TOKEN).toBe("${{ github.token }}");

  // Exercise the selected trusted helper against a legacy target tree.
  const trustedInputs = z
    .object({ "sparse-checkout": z.string() })
    .parse(trustedCheckout?.with);
  await exerciseTrustedRetentionWithLegacyTarget(
    retention?.run,
    retentionEnv,
    trustedInputs["sparse-checkout"],
  );
  const ci = workflows.find(({ file }) => file === "ci.yml")?.workflow;
  if (ci === undefined) throw new Error("Missing CI workflow");
  expect(ci.permissions).toMatchObject({ contents: "read" });
  for (const permissions of [
    ci.permissions,
    ...Object.values(ci.jobs ?? {}).map((job) => job.permissions),
  ]) {
    expect(permissions).not.toBe("write-all");
    expect(permissions ?? {}).not.toHaveProperty("actions", "write");
  }
  const staticSteps = ci.jobs?.static?.steps ?? [];
  const deepSteps = ci.jobs?.["static-deep"]?.steps ?? [];
  const buildSteps = ci.jobs?.build?.steps ?? [];
  const publishedKey = (steps: typeof deepSteps, id: string) =>
    z
      .string()
      .parse(
        z
          .record(z.string(), z.unknown())
          .parse(steps.find((step) => step.id === id)?.with).key,
      );
  const savedOnThisRun = "${{ github.event.workflow_run.head_sha }}";
  const deepPrefix = "rea-static-deep-v1-${{ runner.os }}-${{ runner.arch }}-";
  const knipPrefix = "knip-meta-v1-${{ runner.os }}-";
  const targetSourceKey = (steps: typeof deepSteps, id: string) =>
    publishedKey(steps, id)
      .replaceAll("${{ github.sha }}", savedOnThisRun)
      .replaceAll("hashFiles('", "hashFiles('triggering-source/")
      .replaceAll(", '", ", 'triggering-source/");
  expect(retentionEnv.CACHE_KEEP_KEY).toBe(
    targetSourceKey(staticSteps, "static-cache"),
  );
  const staticPrefix = z.string().min(1).parse(retentionEnv.CACHE_PREFIX);
  expect(
    publishedKey(staticSteps, "static-cache").startsWith(staticPrefix),
  ).toBe(true);
  expect(retentionEnv.CACHE_DEEP_PREFIX).toBe(deepPrefix);
  expect(retentionEnv.CACHE_DEEP_KEEP_KEY).toBe(
    targetSourceKey(deepSteps, "static-cache"),
  );
  expect(publishedKey(deepSteps, "static-cache").startsWith(deepPrefix)).toBe(
    true,
  );
  expect(retentionEnv.CACHE_KNIP_PREFIX).toBe(knipPrefix);
  expect(retentionEnv.CACHE_KNIP_KEEP_KEY).toBe(
    targetSourceKey(buildSteps, "knip-cache"),
  );
  expect(publishedKey(buildSteps, "knip-cache").startsWith(knipPrefix)).toBe(
    true,
  );
  const toolchain = "hashFiles('.nvmrc', '.npmrc', 'package-lock.json')";
  for (const [steps, id, inputs] of [
    [staticSteps, "static-cache", toolchain],
    [deepSteps, "static-cache", toolchain],
    [
      buildSteps,
      "knip-cache",
      "hashFiles('knip.json', 'tsconfig.json', 'package.json', 'package-lock.json')",
    ],
  ] as const) {
    const key = publishedKey(steps, id);
    expect(key).toContain(inputs);
    expect(key.endsWith("${{ github.sha }}")).toBe(true);
  }
  const windowsNativeSteps = ci.jobs?.["windows-native-build"]?.steps ?? [];
  const windowsNativeKey = windowsNativeSteps.find(
    (step) => step.id === "windows-native-key",
  );
  expect(String(windowsNativeKey?.run)).toContain("ImageOS");
  expect(String(windowsNativeKey?.run)).toContain("ImageVersion");
  expect(String(windowsNativeKey?.run)).toContain("date -u +%Y-%m-%d");
});

it("replaces Windows cross-build artifacts on retries under their consumer names", async () => {
  const ci = workflows.find(({ file }) => file === "ci.yml");
  const jobs = ci?.workflow.jobs;
  const producer = jobs?.["windows-native-build"]?.steps ?? [];
  const verifiedAt = producer.findIndex(
    (step) => step.name === "Verify cross-built Windows test fixtures",
  );
  const uploadPositions = producer.flatMap((step, index) =>
    step.uses?.startsWith("actions/upload-artifact@") ? [index] : [],
  );
  expect(verifiedAt).toBeGreaterThanOrEqual(0);
  expect(uploadPositions).toHaveLength(3);
  for (const index of uploadPositions)
    expect(index).toBeGreaterThan(verifiedAt);
  const uploads = uploadPositions.map((index) => producer[index]?.with);
  expect(uploads).toMatchObject([
    {
      name: "windows-native-inspection-fixture",
      overwrite: true,
      "if-no-files-found": "error",
    },
    {
      name: "windows-process-boundary-fixture",
      overwrite: true,
      "if-no-files-found": "error",
    },
    {
      name: "windows-native-controls",
      overwrite: true,
      "if-no-files-found": "error",
    },
  ]);
  const names = new Set(uploads.map((upload) => upload?.name));
  for (const job of ["package-e2e", "windows-curated"]) {
    const downloads = jobs?.[job]?.steps?.filter(
      (step) =>
        step.uses?.startsWith("actions/download-artifact@") &&
        names.has(step.with?.name),
    );
    expect(downloads?.map((step) => step.with?.name).sort()).toEqual(
      job === "package-e2e" ? ["windows-native-controls"] : [...names].sort(),
    );
  }
});

it("publishes each hosted npm download cache from one writer", async () => {
  const writers: { file: string; job: string; save: string }[] = [];
  for (const { file, workflow } of workflows)
    for (const [job, definition] of Object.entries(workflow.jobs ?? {}))
      for (const step of definition.steps ?? []) {
        if (step.uses !== "./.github/actions/npm-cache") continue;
        const save = z
          .record(z.string(), z.unknown())
          .parse(step.with ?? {}).save;
        if (save === undefined) continue;
        writers.push({ file, job, save: z.string().parse(save) });
      }
  expect(writers).toEqual([
    { file: "ci.yml", job: "static", save: "true" },
    {
      file: "ci.yml",
      job: "package-e2e",
      save: "${{ matrix.os != 'ubuntu-latest' }}",
    },
    {
      file: "ci.yml",
      job: "windows-curated",
      save: "${{ matrix.suite == 'capabilities' }}",
    },
  ]);
  const ci = workflows.find(({ file }) => file === "ci.yml");
  expect(ci?.workflow.jobs?.static?.permissions).toBeUndefined();
  expect(ci?.workflow.jobs?.build?.permissions).toEqual({
    contents: "read",
    actions: "read",
  });
});

it("passes the npm cache owner's selected path to package installation", async () => {
  const ci = workflows.find(({ file }) => file === "ci.yml");
  const steps = ci?.workflow.jobs?.["package-e2e"]?.steps ?? [];
  const cacheIndex = steps.findIndex(
    (step) => step.uses === "./.github/actions/npm-cache",
  );
  expect(steps[cacheIndex]?.id).toBe("npm-cache");
  const consumerIndex = steps.findIndex(
    (step) => step.run === "npm run verify:package",
  );
  expect(consumerIndex).toBeGreaterThan(cacheIndex);
  expect(
    z.record(z.string(), z.unknown()).parse(steps[consumerIndex]?.env)
      .npm_config_cache,
  ).toBe("${{ steps.npm-cache.outputs.path }}");
});

it("exports turbo remote-cache credentials wherever a workflow runs turbo", async () => {
  const packageScripts = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(
      JSON.parse(await readFile(join(repository, "package.json"), "utf8")),
    ).scripts;
  const turboScripts = new Set<string>();
  let discovered = true;
  while (discovered) {
    discovered = false;
    for (const [scriptName, scriptCommand] of Object.entries(packageScripts)) {
      if (turboScripts.has(scriptName)) continue;
      if (/\bturbo\b|run-turbo\.mjs/u.test(scriptCommand)) {
        turboScripts.add(scriptName);
        discovered = true;
        continue;
      }
      for (const match of scriptCommand.matchAll(/\bnpm run ([\w:-]+)/gu))
        if (match[1] !== undefined && turboScripts.has(match[1])) {
          turboScripts.add(scriptName);
          discovered = true;
          break;
        }
    }
  }
  const runsTurboCommand = (command: string): boolean => {
    if (/\bturbo\b/u.test(command)) return true;
    for (const match of command.matchAll(
      /\bnpm run (?:--silent\s+)?(?!--)([\w:-]+)/gu,
    ))
      if (match[1] !== undefined && turboScripts.has(match[1])) return true;
    return false;
  };
  const checkedPolicies = new Set<string>();
  const explicitGrant = z.object({
    workflow_call: z.object({
      inputs: z.object({
        remote_cache_write: z.object({ type: z.literal("boolean") }),
      }),
    }),
  });
  for (const { file, workflow } of workflows) {
    const grantsReleaseWrite = explicitGrant.safeParse(workflow.on).success;
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      const runsTurbo = job.steps?.some(
        (step) => typeof step.run === "string" && runsTurboCommand(step.run),
      );
      if (!runsTurbo) continue;
      const env = { ...workflow.env, ...job.env };
      const token = z.string().parse(env.TURBO_TOKEN);
      const cache = z.string().parse(env.TURBO_CACHE);
      expect(env.TURBO_TEAM, `${file}:${name}`).toBe("${{ vars.TURBO_TEAM }}");
      const policy = JSON.stringify([token, cache, grantsReleaseWrite]);
      if (checkedPolicies.has(policy)) continue;
      checkedPolicies.add(policy);
      for (const defaultBranch of ["main", "stable"]) {
        for (const event of [
          "push",
          "schedule",
          "workflow_dispatch",
          "pull_request",
          "workflow_call",
          "deployment",
        ]) {
          for (const ref of [
            `refs/heads/${defaultBranch}`,
            "refs/heads/feature",
          ]) {
            for (const grant of [false, true]) {
              const permitted =
                (grantsReleaseWrite && grant) ||
                (ref === `refs/heads/${defaultBranch}` &&
                  (["push", "schedule", "workflow_dispatch"].includes(event) ||
                    (!grantsReleaseWrite && event === "workflow_call")));
              const context = {
                github: {
                  ref,
                  event_name: event,
                  event: { repository: { default_branch: defaultBranch } },
                },
                inputs: { remote_cache_write: grant },
                secrets: { TURBO_TOKEN: "recording-token" },
              };
              const label = `${file}:${name}:${defaultBranch}:${event}:${ref}:${grant}`;
              expect(evaluatePolicy(token, context), label).toBe(
                permitted ? "recording-token" : "",
              );
              expect(evaluatePolicy(cache, context), label).toBe(
                permitted
                  ? "local:rw,remote:rw"
                  : grantsReleaseWrite
                    ? "local:rw"
                    : "local:rw,remote:r",
              );
            }
          }
        }
      }
    }
  }
});

it("bounds the rolling static snapshot with Turbo age and size eviction", async () => {
  const turbo = z
    .object({
      cacheMaxAge: z.string(),
      cacheMaxSize: z.string(),
    })
    .parse(JSON.parse(await readFile(join(repository, "turbo.json"), "utf8")));
  // The static job restores the previous snapshot by prefix and saves the
  // whole .turbo/cache directory again. Without local eviction every main
  // commit carries all historical entries into a new immutable GitHub cache,
  // growing transfers toward the 10 GB repository limit.
  expect(turbo.cacheMaxAge).toMatch(/^[1-9]\d*(s|m|h|d|w)$/u);
  const size = /^(\d+(?:\.\d+)?)(MB|GB|TB)$/iu.exec(turbo.cacheMaxSize);
  expect(size, "cacheMaxSize must use an explicit MB/GB/TB budget").not.toBe(
    null,
  );
  const value = Number(size?.[1] ?? "0");
  const unit = (size?.[2] ?? "MB").toUpperCase();
  const megabytes =
    unit === "TB" ? value * 1024 * 1024 : unit === "GB" ? value * 1024 : value;
  expect(megabytes).toBeGreaterThan(0);
  expect(megabytes).toBeLessThanOrEqual(1024);
});
