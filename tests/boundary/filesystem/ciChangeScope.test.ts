import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, matchesGlob } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";
import {
  executeWorkflowFixture as execFileAsync,
  workflowGit as git,
} from "../../support/workflowGit.js";

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

let seed: { directory: string; base: string } | undefined;
let seedWorkspaceRoot: string | undefined;

beforeAll(async () => {
  const workspace = await createTestWorkspace("rea-ci-scope-seed-");
  seedWorkspaceRoot = workspace.root;
  const directory = await workspace.mkdir("repository");
  await git(directory, ["init", "--initial-branch=main"]);
  const base = await change(
    directory,
    ["src/provider.ts", "README.md"],
    "Initial fixture content\n",
  );
  seed = { directory, base };
});

afterAll(async () => {
  if (seedWorkspaceRoot !== undefined)
    await removeTestWorkspace(seedWorkspaceRoot);
});

async function fixture() {
  const initial = seed;
  if (initial === undefined)
    throw new Error("CI scope seed was not initialized");
  const directory = await createTestTempDirectory("rea-ci-scope-");
  // Copy the pristine object database, refs and index; each case owns its mutations.
  await cp(initial.directory, directory, { recursive: true });
  return { directory, base: initial.base };
}

async function classify(
  directory: string,
  base: string,
  head: string,
  event = "pull_request",
  full = false,
) {
  const output = join(directory, "scope-output");
  await writeFile(output, "");
  const result = await execFileAsync(
    process.execPath,
    [new URL("../../../scripts/ci/plan.mjs", import.meta.url).pathname],
    {
      cwd: directory,
      env: {
        ...process.env,
        BASE_SHA: base,
        HEAD_SHA: head,
        GITHUB_EVENT_NAME: event,
        CI_FULL: String(full),
        GITHUB_OUTPUT: output,
      },
    },
  );
  return z.record(z.string(), z.unknown()).parse(JSON.parse(result.stdout));
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
  expect(await classify(directory, base, head)).toMatchObject({
    code: false,
    package: false,
    docs: true,
  });
});

it("does not charge a documentation PR for unrelated implementation updates on main", async () => {
  const { directory, base } = await fixture();
  await git(directory, ["switch", "-c", "docs/change"]);
  const head = await change(directory, ["README_zh-TW.md"]);
  await git(directory, ["switch", "main"]);
  const advancedBase = await change(directory, ["src/anotherProvider.ts"]);
  expect(advancedBase).not.toBe(base);
  expect(await classify(directory, advancedBase, head)).toMatchObject({
    code: false,
    package: false,
  });
});

it.each([
  "src/README.md",
  "README.md.ts",
  "bridge/ghidra/provider.py",
  "tests/fixture.test.ts",
  ".github/workflows/ci.yml",
  "unknown-file",
])(
  "retains complete checks when documentation is mixed with %s",
  async (path) => {
    const { directory, base } = await fixture();
    const head = await change(directory, ["README.md", path]);
    expect(await classify(directory, base, head)).toMatchObject({ code: true });
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
  expect(await classify(directory, base, head)).toMatchObject({
    code: true,
    runtime: true,
  });
});

it("retains the complete main-push baseline even for documentation", async () => {
  const { directory, base } = await fixture();
  const head = await change(directory, ["README_ja.md"]);
  expect(await classify(directory, base, head, "push")).toMatchObject({
    code: true,
    package: true,
  });
});

it("fails classification rather than treating an invalid Git comparison as a scope", async () => {
  const { directory, base } = await fixture();
  await expect(classify(directory, "missing-ref", base)).rejects.toMatchObject({
    code: 1,
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
    (await classify((await fixture()).directory, "", "", "push")).matrix,
  ).toEqual({
    include: [
      { os: "ubuntu-latest", platform: "linux", architecture: "x64" },
      { os: "ubuntu-24.04-arm", platform: "linux", architecture: "arm64" },
      { os: "macos-15", platform: "darwin", architecture: "arm64" },
      { os: "macos-15-intel", platform: "darwin", architecture: "x64" },
    ],
  });
  const windowsInspector = stepSchema.parse(
    workflow.jobs["windows-curated"].steps.find(
      (step) => step.run === "npm run verify:inspector",
    ),
  );
  expect(windowsInspector.if).toBeUndefined();
});

it.each([
  [
    "src/evm/client.ts",
    { code: true, runtime: true, evm: true, browser: false, package: false },
  ],
  [
    "src/browser/execution/evaluate.ts",
    {
      code: true,
      runtime: true,
      browser: true,
      web_runtime: true,
      evm: false,
      package: false,
    },
  ],
  [
    "tests/module/example.test.ts",
    { code: true, runtime: false, browser: false, package: false },
  ],
  ["website/src/index.ts", { code: false, website: true, package: false }],
  [
    "website/locales/zh-CN/messages.po",
    { code: false, website: true, package: false },
  ],
  ["scripts/website_i18n.py", { code: false, website: true, package: false }],
  ["README_ja.md", { code: false, docs: true, website: true, package: false }],
  [
    ".github/workflows/website-pages.yml",
    { code: false, website: true, package: false },
  ],
  [
    "src/process/ProviderProcess.ts",
    { code: true, package: true, evm: true, browser: true },
  ],
  [
    "package-lock.json",
    { code: true, package: true, evm: true, browser: true },
  ],
  [
    ".github/workflows/real-evm-interface.yml",
    { code: false, evm: true, browser: false, package: false },
  ],
  ["unknown-input", { code: true, package: true, evm: true, browser: true }],
  [
    "src/application/Example.ts",
    {
      code: true,
      runtime: true,
      package: false,
      apple: false,
      evm: false,
      browser: false,
    },
  ],
  [
    "bridge/ghidra/Example.java",
    { code: true, runtime: true, package: false, apple: false },
  ],
  [
    "src/native/AppleExample.ts",
    { code: true, runtime: true, apple: true, package: false, evm: false },
  ],
  [
    "scripts/verify/apple/example.mjs",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "src/windows/Example.ts",
    { code: true, runtime: true, package: true, apple: false, evm: false },
  ],
  ["install.sh", { code: true, runtime: true, package: true, evm: false }],
  [
    ".agents/skills/reverse-engineer-anything/SKILL.md",
    { code: true, runtime: true, docs: true, package: false, evm: false },
  ],
  [
    "scripts/verify-real-ghidra.mjs",
    { code: true, runtime: false, package: false, apple: false, evm: false },
  ],
  [
    "scripts/verify-claude-client.mjs",
    { code: true, runtime: false, package: false, browser: false },
  ],
  [
    "tests/boundary/process/darwinProcessRunTokenReader.test.ts",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "tests/boundary/cli/nativePlistCli.test.ts",
    { code: true, apple: true, package: false, runtime: false },
  ],
  [
    "tests/boundary/filesystem/windowsNpxRegistration.test.ts",
    { code: true, package: true, runtime: true, apple: false },
  ],
  [
    "src/process/ProcessOwnership.test.ts",
    { code: true, package: true, apple: false, evm: false, browser: false },
  ],
])("selects the appropriate lanes for %s", async (path, expected) => {
  const { directory, base } = await fixture();
  const head = await change(directory, [path]);
  expect(await classify(directory, base, head)).toMatchObject(expected);
});

it("scopes package script edits while retaining broad dependency checks", async () => {
  const { directory } = await fixture();
  const before = {
    name: "fixture",
    scripts: { "verify:evm": "node scripts/verify-evm-interface.mjs" },
  };
  const base = await change(
    directory,
    ["package.json"],
    JSON.stringify(before),
  );
  const after = {
    ...before,
    scripts: {
      "verify:evm": "node scripts/verify-evm-interface.mjs --verbose",
    },
  };
  const head = await change(directory, ["package.json"], JSON.stringify(after));
  expect(await classify(directory, base, head)).toMatchObject({
    code: true,
    evm: true,
    browser: false,
    package: false,
  });
  const dependency = await change(
    directory,
    ["package.json"],
    JSON.stringify({ ...after, dependencies: { example: "1.0.0" } }),
  );
  expect(await classify(directory, head, dependency)).toMatchObject({
    code: true,
    browser: true,
    package: true,
  });
});

it.each([
  ["browser", "real-browser"],
  ["binary_layout", "real-binary-layout"],
  ["evm", "real-evm-interface"],
  ["javascript_recovery", "real-javascript-recovery"],
  ["recorded_crash", "real-recorded-crash"],
  ["web_network", "real-web-network-captures"],
  ["web_runtime", "real-web-runtime"],
  ["web_source_map", "real-web-source-map"],
  ["nativeaot", "nativeaot-fixtures"],
  ["website", "website-check"],
])(
  "routes %s through the selector without a duplicate PR trigger",
  async (scope, name) => {
    const workflow = z
      .object({
        on: z.object({ workflow_call: z.null() }).passthrough(),
      })
      .parse(
        parse(
          await readFile(
            new URL(`../../../.github/workflows/${name}.yml`, import.meta.url),
            "utf8",
          ),
        ),
      );
    expect(workflow.on).not.toHaveProperty("pull_request");
    const ci = z
      .object({
        jobs: z.record(
          z.string(),
          z.object({
            uses: z.string().optional(),
            if: z.string().optional(),
          }),
        ),
      })
      .parse(
        parse(
          await readFile(
            new URL("../../../.github/workflows/ci.yml", import.meta.url),
            "utf8",
          ),
        ),
      );
    expect(ci.jobs[scope]).toMatchObject({
      uses: `./.github/workflows/${name}.yml`,
      if: `needs.changes.outputs.${scope} == 'true'`,
    });
  },
);

it("rejects skipped selected work while allowing unselected lanes to skip", async () => {
  const command = new URL("../../../scripts/ci/required.mjs", import.meta.url)
    .pathname;
  const jobs = {
    changes: { result: "success", outputs: { evm: "true" } },
    static: { result: "success" },
    test: { result: "success" },
    evm: { result: "success" },
    browser: { result: "skipped" },
  };
  const run = (result: string) =>
    execFileAsync(process.execPath, [command], {
      env: {
        ...process.env,
        CI_JOBS: JSON.stringify({ ...jobs, evm: { result } }),
      },
    });
  await expect(run("success")).resolves.toMatchObject({ stderr: "" });
  for (const result of ["failure", "cancelled", "skipped"]) {
    await expect(run(result)).rejects.toMatchObject({ code: 1 });
  }
});

it.each([
  [
    ".github/workflows/real-termux.yml",
    { workflows: true, code: false, package: false, website: false },
  ],
  [
    "src/domain/javascript/example.test.ts",
    { code: true, runtime: false, javascript_recovery: false, package: false },
  ],
  [
    "src/process/capture/example.test.ts",
    { code: true, runtime: false, browser: false, package: false },
  ],
  [".nvmrc", { code: true, package: true, browser: true, evm: true }],
  [
    "tsconfig.build.json",
    { code: true, package: true, browser: true, evm: true },
  ],
  ["docs/.vitepress/config.ts", { code: false, docs: true, package: false }],
  ["CHANGELOG.md", { code: false, docs: true, package: false }],
  ["SECURITY.md", { code: false, docs: true, package: false }],
  [".github/pull_request_template.md", { code: false, docs: true }],
  [
    ".github/ISSUE_TEMPLATE/bug.yml",
    { code: false, docs: true, workflows: false },
  ],
  ["native/windows/README.md", { code: false, docs: true, package: false }],
  [
    "src/contracts/evm/tools.ts",
    { code: true, docs: true, evm: true, package: false },
  ],
  ["scripts/unknown-website-helper.mjs", { code: true, package: true }],
  [
    ".github/workflows/release.yml",
    { workflows: true, code: true, package: false, website: false },
  ],
  [
    ".github/workflows/real-ghidra-windows.yml",
    { workflows: true, code: true, package: false, website: false },
  ],
  [
    "tests/conformance/c/fixture.c",
    { code: true, fixtures: true, readiness: true, package: false },
  ],
  [
    "tests/conformance/swift/fixture.swift",
    { code: true, fixtures: true, readiness: true, package: false },
  ],
  [
    "tests/conformance/readiness/javascript-cli/package.json",
    { code: true, fixtures: false, readiness: true, package: false },
  ],
  [
    "tests/conformance/ghidra/no-return.c",
    { code: true, fixtures: false, readiness: false, package: false },
  ],
])("preserves scope boundaries for %s", async (path, expected) => {
  const { directory, base } = await fixture();
  const head = await change(directory, [path]);
  expect(await classify(directory, base, head)).toMatchObject(expected);
});

it("unions provider scopes across mixed changes and deletions", async () => {
  const { directory } = await fixture();
  const base = await change(directory, ["src/evm/client.ts"]);
  await git(directory, ["rm", "src/evm/client.ts"]);
  const head = await change(directory, ["src/browser/execution/evaluate.ts"]);
  expect(await classify(directory, base, head)).toMatchObject({
    evm: true,
    browser: true,
    runtime: true,
    package: false,
  });
});

it("fails without emitting a plan when package metadata is malformed", async () => {
  const { directory } = await fixture();
  const base = await change(directory, ["package.json"], '{"scripts":{}}');
  const head = await change(directory, ["package.json"], "{broken");
  await expect(classify(directory, base, head)).rejects.toMatchObject({
    code: 1,
  });
  expect(await readFile(join(directory, "scope-output"), "utf8")).toBe("");
});

it.each([
  [
    "verify:keyed-archive",
    "npm run build:cached && node scripts/verify/apple/keyed-archive.mjs",
    { apple: true, package: false, evm: false, browser: false },
  ],
  [
    "verify:inspector",
    "npm run build:cached && node scripts/verify/inspector/runtime-observation.mjs",
    { package: true, apple: false, evm: false, browser: false },
  ],
  [
    "verify:windows-native",
    "node scripts/verify-windows-native.mjs",
    { package: true, apple: false, evm: false, browser: false },
  ],
])(
  "routes the %s script to its glob-owned lane",
  async (script, command, expected) => {
    const { directory } = await fixture();
    const base = await change(
      directory,
      ["package.json"],
      JSON.stringify({ scripts: { [script]: command } }),
    );
    const head = await change(
      directory,
      ["package.json"],
      JSON.stringify({ scripts: { [script]: `${command} --verbose` } }),
    );
    expect(await classify(directory, base, head)).toMatchObject({
      code: true,
      ...expected,
    });
  },
);

it("retains a broad fallback when a provider script adds shared shell work", async () => {
  const { directory } = await fixture();
  const before = {
    scripts: { "verify:evm": "node scripts/verify-evm-interface.mjs" },
  };
  const base = await change(
    directory,
    ["package.json"],
    JSON.stringify(before),
  );
  const after = {
    scripts: {
      "verify:evm": "node scripts/verify-evm-interface.mjs && npm run compile",
    },
  };
  const head = await change(directory, ["package.json"], JSON.stringify(after));
  expect(await classify(directory, base, head)).toMatchObject({
    evm: true,
    browser: true,
    package: true,
  });
});

it.each(["workflow_dispatch", "schedule"])(
  "retains full selection for %s",
  async (event) => {
    const { directory, base } = await fixture();
    expect(await classify(directory, base, base, event)).toMatchObject({
      code: true,
      package: true,
      evm: true,
      browser: true,
    });
  },
);

it("honors ci:full for successive PR revisions", async () => {
  const { directory, base } = await fixture();
  const first = await change(directory, ["README.md"]);
  const second = await change(directory, ["README_ja.md"]);
  for (const head of [first, second]) {
    expect(
      await classify(directory, base, head, "pull_request", true),
    ).toMatchObject({ code: true, package: true, evm: true, browser: true });
  }
});

it.each(["compile:termux", "build:termux", "build:termux:run"])(
  "does not expand %s edits into unrelated providers",
  async (script) => {
    const { directory } = await fixture();
    const base = await change(
      directory,
      ["package.json"],
      JSON.stringify({ scripts: { [script]: "npm run compile:termux" } }),
    );
    const head = await change(
      directory,
      ["package.json"],
      JSON.stringify({
        scripts: {
          [script]:
            "node scripts/run-exclusive.mjs artifacts npm run compile:termux",
        },
      }),
    );
    expect(await classify(directory, base, head)).toMatchObject({
      code: true,
      workflows: true,
      runtime: false,
      package: false,
      browser: false,
      evm: false,
    });
  },
);

const INTEL_HOST = {
  os: "macos-15-intel",
  platform: "darwin",
  architecture: "x64",
};

it("keeps macOS x64 package verification for ci:full and non-PR events", async () => {
  const { directory, base } = await fixture();
  const head = await change(directory, ["src/windows/Example.ts"]);
  const matrix = z.object({ include: z.array(z.unknown()) });
  const hosts = async (event: string, full: boolean) =>
    matrix.parse((await classify(directory, base, head, event, full)).matrix)
      .include;
  const pullRequest = await hosts("pull_request", false);
  expect(pullRequest).toHaveLength(3);
  expect(pullRequest).not.toContainEqual(INTEL_HOST);
  expect(await hosts("pull_request", true)).toContainEqual(INTEL_HOST);
  for (const event of ["push", "schedule", "workflow_dispatch"])
    expect(await hosts(event, false)).toContainEqual(INTEL_HOST);
});

const workflowFile = async (name: string): Promise<unknown> =>
  parse(
    await readFile(
      new URL(`../../../.github/workflows/${name}`, import.meta.url),
      "utf8",
    ),
  );

const scopesSchema = z.object({
  SCOPES: z.record(z.string(), z.array(z.string())),
  MANUAL_VERIFIERS: z.array(z.string()),
});

const loadScopes = async () =>
  scopesSchema.parse(
    await import(
      new URL("../../../scripts/ci/scopes.mjs", import.meta.url).href
    ),
  );

const stepRuns = z.object({
  on: z.unknown(),
  jobs: z.record(
    z.string(),
    z.object({
      steps: z.array(z.object({ run: z.string().optional() })).optional(),
    }),
  ),
});

it("owns every explicit native-host test path with the lane that runs it", async () => {
  const { SCOPES } = await loadScopes();
  const ci = stepRuns.parse(await workflowFile("ci.yml"));
  const listed = (job: string) =>
    (ci.jobs[job]?.steps ?? [])
      .flatMap((step) => step.run?.split(/\s+/) ?? [])
      .filter((token) => token.endsWith(".test.ts"));
  const unowned = (job: string, scope: string) =>
    listed(job).filter(
      (path) =>
        !(SCOPES[scope] ?? []).some((pattern) => matchesGlob(path, pattern)),
    );
  expect(listed("apple-artifacts").length).toBeGreaterThan(0);
  expect(listed("windows-curated").length).toBeGreaterThan(0);
  expect(unowned("apple-artifacts", "apple")).toEqual([]);
  expect(unowned("windows-curated", "package")).toEqual([]);
});

it("never runs a manual-only verifier from an automatic workflow", async () => {
  const { MANUAL_VERIFIERS } = await loadScopes();
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
  const directory = new URL("../../../.github/workflows/", import.meta.url);
  const commands: string[] = [];
  for (const name of await readdir(directory)) {
    const workflow = stepRuns.parse(await workflowFile(name));
    const triggers = JSON.stringify(workflow.on);
    if (
      name !== "ci.yml" &&
      !triggers.includes("workflow_call") &&
      !triggers.includes("pull_request")
    )
      continue;
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps ?? []) if (step.run) commands.push(step.run);
  }
  const files = new Set<string>();
  const seen = new Set<string>();
  while (commands.length) {
    const command = commands.pop() ?? "";
    for (const [, file] of command.matchAll(/\b(scripts\/[\w./-]+\.mjs)\b/g))
      if (file) files.add(file);
    for (const [, script] of command.matchAll(/npm run ([\w:.-]+)/g)) {
      if (!script || seen.has(script)) continue;
      seen.add(script);
      const body = scripts[script];
      if (body) commands.push(body);
    }
  }
  expect(files.size).toBeGreaterThan(0);
  expect(
    [...files].filter((file) =>
      MANUAL_VERIFIERS.some((pattern) => matchesGlob(file, pattern)),
    ),
  ).toEqual([]);
});
