import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { parse } from "yaml";
import { inspectReleaseCheckpoint } from "../../../scripts/lib/release-checkpoint.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
  type TestWorkspace,
} from "../../support/workspace/workspaceFixture.js";
import {
  executeWorkflowFixture as execFileAsync,
  workflowGit as git,
} from "../../support/workflowGit.js";

const verifier = fileURLToPath(
  new URL("../../../scripts/verify-release-checkpoint.mjs", import.meta.url),
);

const pluginManifestPaths = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
] as const;

const pluginManifest = (version: string, launch = version) => ({
  version,
  mcpServers: {
    rea: {
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/scripts/plugin-mcp-launcher.mjs", launch],
    },
  },
});

const codexServerConfig = (version: string, launch = version) => ({
  mcpServers: {
    rea: {
      command: "node",
      args: ["./scripts/plugin-mcp-launcher.mjs", launch],
      cwd: ".",
      startup_timeout_sec: 30,
    },
  },
});

async function metadata(
  directory: string,
  version: string,
  notes: string,
  versioning?: string,
) {
  await mkdir(join(directory, "src"), { recursive: true });
  for (const path of [...pluginManifestPaths, ".cursor-plugin/plugin.json"])
    await mkdir(join(directory, dirname(path)), { recursive: true });
  const files = {
    ".claude-plugin/plugin.json": pluginManifest(version),
    ".codex-plugin/plugin.json": {
      version,
      mcpServers: "./.codex-plugin/mcp.json",
    },
    ".codex-plugin/mcp.json": codexServerConfig(version),
    ".cursor-plugin/plugin.json": { version },
    "mcp.json": {
      mcpServers: {
        rea: {
          command: "npx",
          args: ["-y", `rea-agents@${version}`, "mcp"],
        },
      },
    },
    "package.json": {
      name: "rea-agents",
      version,
      repository: {
        type: "git",
        url: "git+https://github.com/fixture/rea.git",
      },
    },
    "package-lock.json": { version, packages: { "": { version } } },
    ".release-please-manifest.json": { ".": version },
    "server.json": {
      version,
      packages: [{ registryType: "npm", identifier: "rea-agents", version }],
    },
    "release-please-config.json": {
      ...(versioning === undefined ? {} : { versioning }),
      "changelog-sections": [
        { type: "feat", hidden: false },
        { type: "fix", hidden: false },
        { type: "chore", hidden: true },
      ],
    },
  };
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(directory, name), JSON.stringify(value));
  }
  await writeFile(
    join(directory, "src/generatedPackageMetadata.ts"),
    `export const METADATA = {\n  version: "${version}",\n};\n`,
  );
  await writeFile(
    join(directory, "CHANGELOG.md"),
    `# Changelog\n\n## [${version}]\n\n${notes}\n`,
  );
}

interface ReleaseSeed {
  readonly directory: string;
  readonly releasedSha: string;
}

const seedWorkspaces: TestWorkspace[] = [];
const seedPromises = new Map<string, Promise<ReleaseSeed>>();

const releaseSeed = (versioning?: string): Promise<ReleaseSeed> => {
  const key = versioning ?? "default";
  const existing = seedPromises.get(key);
  if (existing !== undefined) return existing;

  const pending = (async (): Promise<ReleaseSeed> => {
    const workspace = await createTestWorkspace("rea-release-checkpoint-seed-");
    seedWorkspaces.push(workspace);
    const directory = workspace.path(key);
    await mkdir(directory, { recursive: true });
    await git(directory, ["init", "--initial-branch=main"]);
    await metadata(directory, "4.0.0", "Initial release", versioning);
    await git(directory, ["add", "."]);
    await git(
      directory,
      ["commit", "-m", "chore: seed"],
      "2026-01-01T00:00:00Z",
    );
    await git(directory, ["switch", "-c", "release/5.0.0"]);
    await metadata(directory, "5.0.0", "Previous release", versioning);
    await git(directory, ["add", "."]);
    await git(
      directory,
      ["commit", "-m", "chore: release 5.0.0"],
      "2026-01-03T00:00:00Z",
    );
    const releasedSha = await git(directory, ["rev-parse", "HEAD"]);
    await git(directory, ["tag", "rea-agents-5.0.0"]);
    await git(directory, ["switch", "main"]);
    return { directory, releasedSha };
  })();
  seedPromises.set(key, pending);
  return pending;
};

afterAll(async () => {
  await Promise.allSettled(seedPromises.values());
  const cleanup = await Promise.allSettled(
    seedWorkspaces.map(({ root }) => removeTestWorkspace(root)),
  );
  const failures = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      "Could not remove release checkpoint seeds",
    );
});

async function fixture(
  subject = "fix(contracts)!: require absolute paths (#948)",
  footer = "",
  options: { mergePullRequest?: boolean; versioning?: string } = {},
) {
  const seed = await releaseSeed(options.versioning);
  const directory = await createTestTempDirectory("rea-release-ancestry-");
  await cp(seed.directory, directory, { recursive: true, dereference: true });
  if (options.mergePullRequest) {
    await git(directory, ["switch", "-c", "change/contracts"]);
  }
  await writeFile(
    join(directory, "behavior.txt"),
    "Unreleased mainline behavior\n",
  );
  await git(directory, ["add", "."]);
  await git(
    directory,
    ["commit", "-m", subject, "-m", footer],
    "2026-01-02T00:00:00Z",
  );
  if (options.mergePullRequest) {
    await git(directory, ["switch", "main"]);
    await git(
      directory,
      [
        "merge",
        "--no-ff",
        "change/contracts",
        "-m",
        "Merge pull request #948 from fixture/absolute-paths",
        "-m",
        subject,
      ],
      "2026-01-02T00:00:00Z",
    );
  }
  const changedSha = await git(directory, ["rev-parse", "HEAD"]);
  await git(directory, [
    "merge",
    "--no-ff",
    "release/5.0.0",
    "-m",
    "chore: sync published baseline",
  ]);
  const sourceSha = await git(directory, ["rev-parse", "HEAD"]);
  return {
    directory,
    sourceSha,
    changedSha,
    releasedSha: seed.releasedSha,
    versioning: options.versioning,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function candidate(
  f: Fixture,
  version: string,
  notes = "### ⚠ BREAKING CHANGES\n\n* MCP callers must use absolute paths; CLI paths remain compatible. See #948.",
  overrides: Readonly<Record<string, string>> = {},
) {
  await metadata(f.directory, version, notes, f.versioning);
  for (const [path, content] of Object.entries(overrides))
    await writeFile(join(f.directory, path), content);
  await git(f.directory, ["add", "."]);
  await git(
    f.directory,
    ["commit", "-m", `chore: release ${version}`],
    "2026-01-05T00:00:00Z",
  );
  return git(f.directory, ["rev-parse", "HEAD"]);
}

function verify(
  f: Pick<Fixture, "directory" | "sourceSha">,
  version = "6.0.0",
  phase = "prepare",
  stage = "candidate",
) {
  return execFileAsync(
    process.execPath,
    [
      verifier,
      "--phase",
      phase,
      "--stage",
      stage,
      "--release-branch",
      version === "main" ? "main" : `release/${version}`,
      "--source-sha",
      f.sourceSha,
    ],
    { cwd: f.directory },
  );
}

const reportSchema = z.object({
  expectedVersion: z.string(),
  baselineVersion: z.string(),
  baselineSha: z.string(),
  sourceSha: z.string(),
  applicationSha: z.string(),
  commits: z.array(
    z.object({
      sha: z.string(),
      subject: z.string(),
      conventionalTitle: z.string().optional(),
      breaking: z.boolean(),
    }),
  ),
  missingNotes: z.array(
    z.object({
      sha: z.string(),
      subject: z.string(),
      conventionalTitle: z.string().optional(),
      type: z.string().optional(),
      breaking: z.boolean(),
    }),
  ),
});

it("retains an unreleased breaking commit hidden by the side-branch chronological cutoff", async () => {
  const f = await fixture();
  const walk = (
    await git(f.directory, ["log", "--format=%H", f.sourceSha])
  ).split("\n");
  expect(walk.slice(0, walk.indexOf(f.releasedSha))).not.toContain(
    f.changedSha,
  );
  await candidate(f, "6.0.0");
  const result = await verify(f);
  const report = reportSchema.parse(JSON.parse(result.stdout));
  expect(report).toMatchObject({
    expectedVersion: "6.0.0",
    baselineVersion: "5.0.0",
    missingNotes: [],
  });
  expect(report.commits).toContainEqual({
    sha: f.changedSha,
    subject: "fix(contracts)!: require absolute paths (#948)",
    breaking: true,
  });
});

it.each([
  { marker: "title", subject: "fix(contracts)!: require absolute paths" },
  {
    marker: "merge title",
    subject: "fix(contracts)!: require absolute paths",
    mergePullRequest: true,
  },
  {
    marker: "footer",
    subject: "fix(contracts): change path inputs (#948)",
    footer: "BREAKING CHANGE: relative MCP paths are rejected",
  },
])(
  "rejects a requested minor with a breaking $marker",
  async ({ subject, footer, mergePullRequest }) => {
    const f = await fixture(subject, footer, {
      mergePullRequest: mergePullRequest ?? false,
    });
    await expect(verify(f, "5.1.0", "prepare", "source")).rejects.toMatchObject(
      {
        code: 1,
        stderr: expect.stringContaining(
          `contains unreleased breaking markers since 5.0.0: ${f.changedSha}`,
        ),
      },
    );
  },
);

it.each([
  { subject: "fix(contracts)!: require absolute paths (#948)", footer: "" },
  {
    subject: "fix(contracts): change path inputs (#948)",
    footer: "BREAKING CHANGE: relative MCP paths are rejected",
  },
])(
  "accepts a breaking minor under always-bump-minor: $subject",
  async ({ subject, footer }) => {
    const f = await fixture(subject, footer, {
      versioning: "always-bump-minor",
    });
    const report = reportSchema.parse(
      JSON.parse((await verify(f, "5.1.0", "prepare", "source")).stdout),
    );
    expect(report).toMatchObject({
      expectedVersion: "5.1.0",
      sourceSha: f.sourceSha,
      missingNotes: [],
    });
    expect(report.commits).toContainEqual({
      sha: f.changedSha,
      subject,
      breaking: true,
    });
  },
);

it("still requires migration notes for breaking minor releases", async () => {
  const f = await fixture(undefined, "", { versioning: "always-bump-minor" });
  await candidate(f, "5.1.0", "### Bug Fixes\n\nSee #948.");
  await expect(verify(f, "5.1.0")).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      "migration notes omit unreleased breaking changes",
    ),
  });
});

it.each([
  {
    notes:
      "### ⚠ BREAKING CHANGES\n\n* **contracts:** Use absolute MCP paths. Relative paths are rejected.",
    accepted: true,
  },
  {
    notes:
      "### ⚠ BREAKING CHANGES\n\n* **contracts:** Use absolute MCP paths.\n  Relative paths are rejected.",
    accepted: true,
  },
  {
    notes: "### ⚠ BREAKING CHANGES\n\n* Use absolute MCP paths.",
    accepted: false,
  },
  {
    notes:
      "### Bug Fixes\n\n* Use absolute MCP paths. Relative paths are rejected.",
    accepted: false,
  },
  {
    notes:
      "### ⚠ BREAKING CHANGES\n\n* Use absolute MCP paths. Relative paths are rejected.",
    footer:
      "BREAKING CHANGE: Use absolute MCP paths. Relative paths are rejected.\n\nBREAKING CHANGE: Rename the old CLI option.",
    accepted: false,
  },
  {
    notes:
      "### ⚠ BREAKING CHANGES\n\n* Use absolute MCP paths. Relative paths are rejected.\n* Rename the old CLI option.",
    footer:
      "BREAKING CHANGE: Use absolute MCP paths.\r\nRelative paths are rejected.\r\n\r\nBREAKING CHANGE: Rename the old CLI option.",
    accepted: true,
  },
])(
  "validates generated migration text on a main release merge ($accepted): $notes",
  async ({ notes, accepted, footer }) => {
    const f = await fixture(
      "fix(contracts)!: change path inputs",
      footer ??
        "BREAKING CHANGE: Use absolute MCP paths.\nRelative paths are rejected.",
      { versioning: "always-bump-minor" },
    );
    const sourceSha = await candidate(f, "5.1.0", notes);
    const result = verify({ ...f, sourceSha }, "main", "publish", "source");
    if (!accepted) {
      await expect(result).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "migration notes omit unreleased breaking changes",
        ),
      });
      return;
    }
    expect(reportSchema.parse(JSON.parse((await result).stdout))).toMatchObject(
      {
        expectedVersion: "5.1.0",
        baselineVersion: "5.0.0",
        applicationSha: f.sourceSha,
      },
    );
  },
);

it.each([
  { spacing: "adjacent", separator: "\n", includeRestart: true },
  { spacing: "separated", separator: "\n\n", includeRestart: true },
  { spacing: "separated", separator: "\n\n", includeRestart: false },
])(
  "validates $spacing list migration with restart step $includeRestart",
  async ({ separator, includeRestart }) => {
    const steps =
      "- Set `--new-path` to an absolute path.\n- Restart the client.";
    const f = await fixture(
      "fix(contracts)!: change path inputs",
      "BREAKING CHANGE: Migrate configuration:" +
        separator +
        steps +
        "\n\nReviewed-by: Fixture Reviewer",
    );
    const notes = includeRestart ? steps : steps.split("\n")[0];
    await candidate(
      f,
      "6.0.0",
      "### ⚠ BREAKING CHANGES\n\nMigrate configuration:\n\n" + notes,
    );
    const result = verify(f);
    if (includeRestart) {
      await expect(result).resolves.toMatchObject({
        stdout: expect.stringContaining('"expectedVersion": "6.0.0"'),
      });
    } else {
      await expect(result).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "migration notes omit unreleased breaking changes",
        ),
      });
    }
  },
);

it.each([
  {
    subject: "fix(contracts)!: require absolute paths",
    version: "6.0.0",
    breaking: true,
  },
  { subject: "fix: improve diagnostics", version: "5.0.1", breaking: false },
])(
  "recognizes GitHub merge titles and PR note references for $version",
  async ({ subject, version, breaking }) => {
    const f = await fixture(subject, "", { mergePullRequest: true });
    await candidate(
      f,
      version,
      `${breaking ? "### ⚠ BREAKING CHANGES" : "### Bug Fixes"}\n\nSee #948 for the change and migration.`,
    );
    const report = reportSchema.parse(
      JSON.parse((await verify(f, version)).stdout),
    );
    expect(report.missingNotes).toEqual([]);
    expect(report.commits).toContainEqual({
      sha: f.changedSha,
      subject: "Merge pull request #948 from fixture/absolute-paths",
      conventionalTitle: subject,
      breaking,
    });
  },
);

it.each([
  {
    label: "local descriptive PR link with a different candidate repository",
    candidateRepository: "https://github.com/elsewhere/other.git",
    reference: () => "[paths](https://github.com/fixture/rea/pull/948)",
    accepted: true,
  },
  {
    label: "local descriptive issue link",
    reference: () => "[paths](https://github.com/fixture/rea/issues/948)",
    accepted: true,
  },
  {
    label: "foreign PR with the same displayed number",
    reference: () => "[#948](https://github.com/elsewhere/other/pull/948)",
    accepted: false,
  },
  {
    label: "foreign commit with the same displayed SHA",
    reference: (sha: string) =>
      `[${sha}](https://github.com/elsewhere/other/commit/${sha})`,
    accepted: false,
  },
  {
    label: "unrelated hexadecimal token",
    reference: (sha: string) => `ffff${sha.slice(0, 7)}ffff`,
    accepted: false,
  },
  {
    label: "standalone uppercase URL to a foreign commit",
    reference: (sha: string) =>
      `HTTPS://github.com/elsewhere/other/commit/${sha}`,
    accepted: false,
  },
  {
    label: "local descriptive commit link",
    reference: (sha: string) =>
      `[paths](HTTPS://GitHub.COM/fixture/rea/commit/${sha})`,
    accepted: true,
  },
  {
    label: "standalone full SHA in a source with no repository field",
    legacySource: true,
    reference: (sha: string) => sha,
    accepted: true,
  },
])(
  "validates breaking note identity using $label",
  async ({ reference, accepted, candidateRepository, legacySource }) => {
    const f = await fixture();
    let source = f;
    if (legacySource === true) {
      await writeFile(
        join(f.directory, "package.json"),
        '{"name":"rea-agents","version":"5.0.0"}',
      );
      await git(f.directory, ["add", "package.json"]);
      await git(f.directory, [
        "commit",
        "-m",
        "chore: record historical package metadata",
      ]);
      source = {
        ...f,
        sourceSha: await git(f.directory, ["rev-parse", "HEAD"]),
      };
    }
    await candidate(
      f,
      "6.0.0",
      `### ⚠ BREAKING CHANGES\n\n* Changes to path inputs ${reference(f.changedSha)}.`,
      candidateRepository === undefined
        ? {}
        : {
            "package.json": JSON.stringify({
              name: "rea-agents",
              version: "6.0.0",
              repository: { url: candidateRepository },
            }),
          },
    );
    const result = verify(source);
    if (accepted)
      expect(
        reportSchema.parse(JSON.parse((await result).stdout)).missingNotes,
      ).toEqual([]);
    else
      await expect(result).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          `migration notes omit unreleased breaking changes: ${f.changedSha}`,
        ),
      });
  },
);

it.each([
  { peer: "reportable", secondSubject: "fix!: require a selected target" },
  { peer: "hidden", secondSubject: "chore: adjust internal details" },
])(
  "refuses a breaking SHA abbreviation shared by a $peer commit",
  async ({ peer, secondSubject }) => {
    const f = await fixture();
    const prefix = "9a310de";
    const first = prefix + "1".repeat(33);
    const second = prefix + "2".repeat(33);
    const firstSubject = "fix!: require an absolute path";
    await candidate(
      f,
      "6.0.0",
      `### ⚠ BREAKING CHANGES\n\n* Migration ${prefix}.`,
    );
    await expect(
      inspectReleaseCheckpoint(
        async (args: string[]) =>
          args[0] === "log"
            ? [
                first,
                firstSubject,
                firstSubject,
                second,
                secondSubject,
                secondSubject,
                "",
              ].join("\0")
            : git(f.directory, args),
        {
          phase: "prepare",
          stage: "candidate",
          releaseBranch: "release/6.0.0",
          sourceSha: f.sourceSha,
          candidateSha: await git(f.directory, ["rev-parse", "HEAD"]),
        },
      ),
    ).rejects.toThrow(
      `migration notes omit unreleased breaking changes: ${first} ${firstSubject}` +
        (peer === "reportable" ? `; ${second} ${secondSubject}` : ""),
    );
  },
);

it("does not treat an ordinary body example as a merge title or breaking declaration", async () => {
  const f = await fixture(
    "fix: improve diagnostics",
    "Example subject:\n\nfix(contracts)!: example only\n\n~~~text\nBREAKING CHANGE: example only\n~~~",
  );
  await candidate(f, "5.0.1", `### Bug Fixes\n\n${f.changedSha}`);
  await expect(verify(f, "5.0.1")).resolves.toMatchObject({ stderr: "" });
});

it("cannot satisfy migration references with notes retained from an older release", async () => {
  const f = await fixture();
  await candidate(
    f,
    "6.0.0",
    "### Features\n\nNew tool\n\n## [5.0.0]\n\n### ⚠ BREAKING CHANGES\n\nSee #948.",
  );
  await expect(verify(f)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      "migration notes omit unreleased breaking changes",
    ),
  });
});

it("allows release examples with a release heading before genuine migration notes", async () => {
  const f = await fixture();
  await candidate(
    f,
    "6.0.0",
    "- ~~~markdown\n  ## [5.0.0]\n  ~~~\n\n### ⚠ BREAKING CHANGES\n\nSee #948.",
  );
  await expect(verify(f)).resolves.toMatchObject({ stderr: "" });
});

it.each([
  {
    form: "a fenced example",
    notes:
      "### Features\n\n~~~markdown\n### ⚠ BREAKING CHANGES\n\nSee #948.\n~~~",
  },
  {
    form: "a wrapped inline code example",
    notes: "### ⚠ BREAKING CHANGES\n\n- Syntax: `See #948\n  for details.`",
  },
])("requires genuine migration notes outside $form", async ({ notes }) => {
  const f = await fixture();
  await candidate(f, "6.0.0", notes);
  await expect(verify(f)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      "migration notes omit unreleased breaking changes",
    ),
  });
});

it.each([
  {
    form: "the entire footer quoted as wrapped code",
    footer: "Use absolute MCP paths. Relative paths are rejected.",
    notes: "Example: `Use absolute MCP paths.\n  Relative paths are rejected.`",
    accepted: false,
  },
  {
    form: "a migration instruction with the exact inline options",
    footer: "Replace `--old-path` with `--mcp-path`.",
    notes: "**Replace** `--old-path` with\n  `--mcp-path`.",
    accepted: true,
  },
  {
    form: "the same instruction with a different inline option",
    footer: "Replace `--old-path` with `--mcp-path`.",
    notes: "**Replace** `--old-path` with\n  `--mcp-paths`.",
    accepted: false,
  },
  {
    form: "a different value inside an inline command",
    footer:
      'Run `rea capture --name "two  spaces"` before collecting Evidence.',
    notes: 'Run `rea capture --name "two spaces"` before collecting Evidence.',
    accepted: false,
  },
  {
    form: "a migration link with the same destination and formatted label",
    footer: "Download [the replacement](https://example.com/v2).",
    notes: "Download [**the replacement**](https://example.com/v2).",
    accepted: true,
  },
  {
    form: "plain migration prose with a hyperlink added in the notes",
    footer: "Download the replacement.",
    notes: "Download [the replacement](https://example.com/v2).",
    accepted: true,
  },
  {
    form: "a migration link with a different destination",
    footer: "Download [the replacement](https://example.com/v2).",
    notes: "Download [the replacement](https://example.com/v1).",
    accepted: false,
  },
  {
    form: "a migration link reduced to its label",
    footer: "Download [the replacement](https://example.com/v2).",
    notes: "Download the replacement.",
    accepted: false,
  },
  {
    form: "the same destination linked from different words",
    footer: "Download [the replacement](https://example.com/v2) now.",
    notes: "Download [the replacement now](https://example.com/v2).",
    accepted: false,
  },
  {
    form: "a required Markdown link alongside an added link with the same destination",
    footer:
      "Download [the replacement](https://example.com/v2) and restart the client.",
    notes:
      "Download [the replacement](https://example.com/v2) and restart [the client](https://example.com/v2).",
    accepted: true,
  },
  {
    form: "a required Markdown link whose destination appears on an added link instead",
    footer:
      "Download [the replacement](https://example.com/v2) and restart the client.",
    notes:
      "Download [the replacement](https://example.com/v1) and restart [the client](https://example.com/v2).",
    accepted: false,
  },
  {
    form: "the same inline HTML link",
    footer: 'Download <a href="https://example.com/v2">the replacement</a>.',
    notes: 'Download <a href="https://example.com/v2">the replacement</a>.',
    accepted: true,
  },
  {
    form: "an inline HTML link with a changed destination",
    footer: 'Download <a href="https://example.com/v2">the replacement</a>.',
    notes: 'Download <a href="https://example.com/v1">the replacement</a>.',
    accepted: false,
  },
  {
    form: "an inline HTML link reduced to its label",
    footer: 'Download <a href="https://example.com/v2">the replacement</a>.',
    notes: "Download the replacement.",
    accepted: false,
  },
])(
  "validates migration wording from $form",
  async ({ footer, notes, accepted }) => {
    const f = await fixture(
      "fix(contracts)!: change path inputs",
      `BREAKING CHANGE: ${footer}`,
    );
    await candidate(f, "6.0.0", `### ⚠ BREAKING CHANGES\n\n- ${notes}`);
    const result = verify(f);
    if (accepted) {
      await expect(result).resolves.toHaveProperty("stdout");
    } else {
      await expect(result).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "migration notes omit unreleased breaking changes",
        ),
      });
    }
  },
);

const migrationCommand = 'mv "old config.json" "new config.json"';
const fencedMigrationCommand = `~~~sh\n${migrationCommand}\n~~~`;

it.each([
  { form: "missing command", command: "", accepted: false },
  {
    form: "different command",
    command: fencedMigrationCommand.replace("new config", "other config"),
    accepted: false,
  },
  { form: "inline code", command: `\`${migrationCommand}\``, accepted: false },
  {
    form: "exact fenced command",
    command: fencedMigrationCommand,
    accepted: true,
  },
  {
    form: "exact indented command",
    command: `    ${migrationCommand}`,
    accepted: true,
  },
])(
  "requires a literal migration block: $form",
  async ({ command, accepted }) => {
    const f = await fixture(
      "fix(contracts)!: rename the configuration file",
      `BREAKING CHANGE: Rename the configuration file.\n\n${fencedMigrationCommand}\n\nReviewed-by: Fixture Reviewer`,
    );
    await candidate(
      f,
      "6.0.0",
      `### ⚠ BREAKING CHANGES\n\nRename the configuration file.\n\n${command}`,
    );
    const result = verify(f);
    if (accepted) {
      await expect(result).resolves.toHaveProperty("stdout");
    } else {
      await expect(result).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "migration notes omit unreleased breaking changes",
        ),
      });
    }
  },
);

const htmlMigrationBlock = "<pre>\nHeader: exact value\n</pre>";

it.each([
  { form: "preserved", block: htmlMigrationBlock, accepted: true },
  { form: "omitted", block: "", accepted: false },
])("keeps raw HTML migration blocks: $form", async ({ block, accepted }) => {
  const f = await fixture(
    "fix(contracts)!: migrate configuration",
    `BREAKING CHANGE: Write the new configuration.\n\n${htmlMigrationBlock}\n\nReviewed-by: Fixture Reviewer`,
  );
  await candidate(
    f,
    "6.0.0",
    `### ⚠ BREAKING CHANGES\n\nWrite the new configuration.\n\n${block}`,
  );
  const result = verify(f);
  if (accepted) {
    await expect(result).resolves.toHaveProperty("stdout");
  } else {
    await expect(result).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "migration notes omit unreleased breaking changes",
      ),
    });
  }
});

it.each([
  { form: "preserved", command: "Header: exact value", accepted: true },
  { form: "changed", command: "Header: another value", accepted: false },
])(
  "keeps trailer-shaped text in code blocks: $form",
  async ({ command, accepted }) => {
    const f = await fixture(
      "fix(contracts)!: migrate configuration",
      "BREAKING CHANGE: Write the new configuration.\n\n~~~text\nHeader: exact value\n~~~\n\nReviewed-by: Fixture Reviewer",
    );
    await candidate(
      f,
      "6.0.0",
      `### ⚠ BREAKING CHANGES\n\nWrite the new configuration.\n\n~~~text\n${command}\n~~~`,
    );
    const result = verify(f);
    if (accepted) {
      await expect(result).resolves.toHaveProperty("stdout");
    } else {
      await expect(result).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          "migration notes omit unreleased breaking changes",
        ),
      });
    }
  },
);

it("accepts a code-only migration when its fence starts on the footer line", async () => {
  const f = await fixture(
    "fix(contracts): rename configuration",
    `BREAKING CHANGE: ${fencedMigrationCommand}\n\nReviewed-by: Fixture Reviewer`,
  );
  await candidate(
    f,
    "6.0.0",
    `### ⚠ BREAKING CHANGES\n\n${fencedMigrationCommand}`,
  );
  const report = reportSchema.parse(JSON.parse((await verify(f)).stdout));
  expect(report.commits).toMatchObject([{ sha: f.changedSha, breaking: true }]);
});

it.each([
  { subject: "fix: correct supported output", version: "5.0.1" },
  { subject: "feat: add an optional inspection", version: "5.1.0" },
])(
  "accepts compatible $version without a major increment",
  async ({ subject, version }) => {
    const f = await fixture(subject);
    await candidate(f, version, `### Changes\n\n${f.changedSha} ${subject}`);
    const report = reportSchema.parse(
      JSON.parse((await verify(f, version)).stdout),
    );
    expect(report).toMatchObject({
      expectedVersion: version,
      commits: [{ sha: f.changedSha, subject, breaking: false }],
      missingNotes: [],
    });
  },
);

it("accepts an exact prerelease version", async () => {
  const f = await fixture();
  await candidate(f, "6.0.0-rc.1");
  await expect(verify(f, "6.0.0-rc.1")).resolves.toMatchObject({ stderr: "" });
});

it.each(["6.01.0", "6.0", "not-a-version", "6.0.0+build"])(
  "rejects invalid release version %s",
  async (version) => {
    const directory = await createTestTempDirectory(
      "rea-release-invalid-version-",
    );
    await expect(
      verify(
        { directory, sourceSha: "1".repeat(40) },
        version,
        "prepare",
        version === "not-a-version" ? "candidate" : "source",
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("must contain an exact SemVer"),
    });
  },
);

it.each([
  {
    path: "package.json",
    content: JSON.stringify({ name: "rea-agents", version: "5.1.0" }),
    location: "package.json",
  },
  {
    path: "package-lock.json",
    content: JSON.stringify({
      version: "6.0.0",
      packages: { "": { version: "5.1.0" } },
    }),
    location: "package-lock.json packages.root",
  },
  {
    path: "server.json",
    content: JSON.stringify({
      version: "6.0.0",
      packages: [
        { registryType: "npm", identifier: "rea-agents", version: "5.1.0" },
      ],
    }),
    location: "server.json rea-agents package",
  },
  {
    path: "src/generatedPackageMetadata.ts",
    content: 'export const METADATA = {\n  version: "5.1.0",\n};\n',
    location: "src/generatedPackageMetadata.ts",
  },
])(
  "rejects inconsistent version metadata in $location",
  async ({ path, content, location }) => {
    const f = await fixture();
    const sha = await candidate(f, "6.0.0", undefined, { [path]: content });
    await expect(verify(f)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        `${location}@${sha} declares 5.1.0; release branch requires 6.0.0`,
      ),
    });
  },
);

it.each([
  {
    label: "non-npm",
    packages: [
      { registryType: "oci", identifier: "rea-agents", version: "6.0.0" },
    ],
  },
  {
    label: "ambiguous",
    packages: [
      { registryType: "npm", identifier: "rea-agents", version: "6.0.0" },
      { registryType: "npm", identifier: "rea-agents", version: "5.1.0" },
    ],
  },
])("refuses invalid MCP package entries: $label", async ({ packages }) => {
  const f = await fixture();
  const sha = await candidate(f, "6.0.0", undefined, {
    "server.json": JSON.stringify({ version: "6.0.0", packages }),
  });
  await expect(verify(f)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(`server.json@${sha} is malformed`),
  });
});

it.each([
  {
    path: ".claude-plugin/plugin.json",
    manifest: pluginManifest("5.1.0", "6.0.0"),
  },
  {
    path: ".codex-plugin/plugin.json",
    manifest: { version: "5.1.0", mcpServers: "./.codex-plugin/mcp.json" },
  },
  { path: ".cursor-plugin/plugin.json", manifest: { version: "5.1.0" } },
])("rejects a stale manifest version in $path", async ({ path, manifest }) => {
  const f = await fixture();
  const sha = await candidate(f, "6.0.0", undefined, {
    [path]: JSON.stringify(manifest),
  });
  await expect(verify(f)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      `${path}@${sha} declares 5.1.0; release branch requires 6.0.0`,
    ),
  });
});

it.each([
  {
    path: ".claude-plugin/plugin.json",
    manifest: pluginManifest("6.0.0", "5.1.0"),
    failure: "launches version 5.1.0; release branch requires 6.0.0",
  },
  {
    path: ".codex-plugin/mcp.json",
    manifest: codexServerConfig("6.0.0", "5.1.0"),
    failure: "launches version 5.1.0; release branch requires 6.0.0",
  },
  {
    path: "mcp.json",
    manifest: {
      mcpServers: {
        rea: { command: "npx", args: ["-y", "rea-agents@5.1.0", "mcp"] },
      },
    },
    failure:
      "launches rea-agents@5.1.0; release branch requires rea-agents@6.0.0",
  },
])(
  "rejects a stale release pin in $path",
  async ({ path, manifest, failure }) => {
    const f = await fixture();
    const sha = await candidate(f, "6.0.0", undefined, {
      [path]: JSON.stringify(manifest),
    });
    const location =
      path === ".codex-plugin/mcp.json" ? ".codex-plugin/plugin.json" : path;
    await expect(verify(f)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`${location}@${sha} ${failure}`),
    });
  },
);

it("uses the first parent of the frozen publish merge even after HEAD advances", async () => {
  const f = await fixture(undefined, "", { versioning: "always-bump-minor" });
  await git(f.directory, ["switch", "-c", "release/5.1.0"]);
  const candidateSha = await candidate(f, "5.1.0");
  await git(f.directory, ["switch", "main"]);
  await git(f.directory, [
    "merge",
    "--no-ff",
    "release/5.1.0",
    "-m",
    "chore: merge proposed release",
  ]);
  const sourceSha = await git(f.directory, ["rev-parse", "HEAD"]);
  expect(await git(f.directory, ["rev-parse", `${sourceSha}^2`])).toBe(
    candidateSha,
  );
  const release = { ...f, sourceSha };
  const original = JSON.parse(
    (await verify(release, "5.1.0", "publish", "source")).stdout,
  );
  expect(reportSchema.parse(original)).toMatchObject({
    sourceSha,
    applicationSha: f.sourceSha,
    baselineSha: f.releasedSha,
    baselineVersion: "5.0.0",
    expectedVersion: "5.1.0",
    missingNotes: [],
  });
  await writeFile(join(f.directory, "server.json"), '{"version":"0.0.0"}');
  await git(f.directory, ["add", "server.json"]);
  await git(f.directory, ["commit", "-m", "fix: unrelated later work"]);
  expect(
    JSON.parse((await verify(release, "main", "publish", "source")).stdout),
  ).toEqual(original);
  await expect(
    verify(
      { ...f, sourceSha: await git(f.directory, ["rev-parse", "HEAD"]) },
      "main",
      "publish",
      "source",
    ),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("must advance published baseline"),
  });
});

it("reports other omitted entries for review without inventing a breaking change", async () => {
  const f = await fixture("fix: improve diagnostics");
  await candidate(f, "5.0.1", "### Bug Fixes\n\nUpdated diagnostics");
  const result = await verify(f, "5.0.1");
  expect(reportSchema.parse(JSON.parse(result.stdout)).missingNotes).toEqual([
    {
      sha: f.changedSha,
      subject: "fix: improve diagnostics",
      type: "fix",
      breaking: false,
    },
  ]);
  expect(result.stderr).toContain("additional unreleased mainline entries");
});

it("reports a missing published tag with recovery advice", async () => {
  const f = await fixture();
  await git(f.directory, ["tag", "-d", "rea-agents-5.0.0"]);
  await expect(verify(f, "6.0.0", "prepare", "source")).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Fetch release tags"),
  });
});

it("rejects a published baseline outside the selected ancestry", async () => {
  const f = await fixture();
  const next = await candidate(f, "6.0.0");
  await git(f.directory, ["tag", "-f", "rea-agents-5.0.0", next]);
  await expect(verify(f, "6.0.0", "prepare", "source")).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      "Published baseline is outside the checkpoint ancestry",
    ),
  });
});

it("reports malformed candidate JSON with the exact metadata path", async () => {
  const f = await fixture();
  await candidate(f, "6.0.0");
  await writeFile(join(f.directory, "server.json"), "{");
  await git(f.directory, ["add", "."]);
  await git(f.directory, ["commit", "-m", "chore: invalid metadata"]);
  await expect(verify(f)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringMatching(/server\.json@.*contains invalid JSON/u),
  });
});

it("rejects a candidate from a different source even when versions and notes match", async () => {
  const f = await fixture();
  await git(f.directory, ["switch", "release/5.0.0"]);
  await candidate(f, "6.0.0");
  await expect(verify(f)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      "Candidate is outside the selected checkpoint ancestry",
    ),
  });
});

it.skipIf(process.platform === "win32").each([
  { job: "release-please", valid: true },
  { job: "release-please", valid: false },
  { job: "merged-release", valid: true },
  { job: "merged-release", valid: false },
])(
  "the actual $job preflight admits the next action only for valid metadata ($valid)",
  async ({ job, valid }) => {
    const f = await fixture();
    const sourceSha = await candidate(f, valid ? "6.0.0" : "5.1.0");
    const workflow = z
      .object({
        jobs: z.object({
          [job]: z.object({
            steps: z.array(
              z.object({
                name: z.string().optional(),
                run: z.string().optional(),
              }),
            ),
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
    const command = z
      .string()
      .parse(
        workflow.jobs[job]?.steps.find(
          (step) =>
            step.name ===
            (job === "merged-release"
              ? "Validate reviewed merge before release creation"
              : "Validate checkpoint version and ancestry before release creation"),
        )?.run,
      );
    const marker = join(f.directory, "next-release-action");
    const execution = execFileAsync(
      "bash",
      [
        "-e",
        "-o",
        "pipefail",
        "-c",
        `${command}\ntouch "$NEXT_RELEASE_ACTION_MARKER"`,
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: {
          ...process.env,
          GIT_DIR: join(f.directory, ".git"),
          GIT_WORK_TREE: f.directory,
          RELEASE_PHASE: "publish",
          RELEASE_BRANCH: "release/6.0.0",
          SOURCE_SHA: sourceSha,
          GITHUB_SHA: sourceSha,
          NEXT_RELEASE_ACTION_MARKER: marker,
        },
      },
    );
    if (valid) {
      await expect(execution).resolves.toMatchObject({ stderr: "" });
      expect(await readFile(marker, "utf8")).toBe("");
    } else {
      await expect(execution).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          job === "merged-release"
            ? "contains unreleased breaking markers"
            : "release branch requires 6.0.0",
        ),
      });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);
