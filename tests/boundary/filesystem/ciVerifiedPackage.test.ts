import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  executeWorkflowFixture,
  workflowGit,
} from "../../support/workflowGit.js";

const validator = fileURLToPath(
  new URL("../../../scripts/ci/verified-package.mjs", import.meta.url),
);
type Fixture = Awaited<ReturnType<typeof createFixture>>;
type FixtureOptions = {
  override?: Record<string, string | number>;
  manifestContents?: string;
  writeManifest?: boolean;
  version?: string;
  tag?: string;
};

it("validates a tarball against the exact checkout and current workflow attempt", async () => {
  const fixture = await createFixture();
  const result = await validate(fixture);

  expect(result.stdout.trim()).toBe(
    join(fixture.artifactDirectory, "package.tgz"),
  );
  expect(await readFile(fixture.output, "utf8")).toBe(
    `tarball=${join(fixture.artifactDirectory, "package.tgz")}\nversion=1.2.3\n`,
  );
});

it("rejects a workflow SHA that differs from the checked out HEAD", async () => {
  const fixture = await createFixture();

  await expect(validate(fixture, "c".repeat(40))).rejects.toThrow();
});

it.each([
  ["wrong checkout SHA", { sourceSha: "c".repeat(40) }],
  ["wrong workflow run", { runId: 124 }],
  ["future workflow attempt", { runAttempt: 3 }],
  ["wrong verifier platform", { platform: "darwin" }],
  ["wrong verifier architecture", { architecture: "arm64" }],
  ["wrong package digest", { sha256: "c".repeat(64) }],
  ["old manifest schema", { schemaVersion: 1 }],
  ["wrong package version", { packageVersion: "1.2.4" }],
  ["wrong Node version", { nodeVersion: "v24.0.0" }],
  ["wrong release channel", { releaseTag: "next" }],
  ["invalid release channel", { releaseTag: "latest\noutput=injection" }],
  ["invalid package version", { packageVersion: "invalid\noutput=injection" }],
])("rejects %s", async (_label, override) => {
  const fixture = await createFixture({ override });

  await expect(validate(fixture)).rejects.toThrow();
});

it("accepts an earlier successful attempt from the same workflow run", async () => {
  const fixture = await createFixture({ override: { runAttempt: 1 } });

  await expect(validate(fixture)).resolves.toMatchObject({
    stdout: expect.any(String),
  });
});

it.each([
  ["malformed manifest", "{"],
  ["manifest with missing fields", JSON.stringify({ schemaVersion: 2 })],
])("rejects %s", async (_label, contents) => {
  const fixture = await createFixture({ manifestContents: contents });

  await expect(validate(fixture)).rejects.toThrow();
});

it("rejects an absent manifest", async () => {
  const fixture = await createFixture({ writeManifest: false });

  await expect(validate(fixture)).rejects.toThrow();
});

async function createFixture({
  override = {},
  manifestContents,
  writeManifest = true,
  version = "1.2.3",
  tag = "latest",
}: FixtureOptions = {}) {
  const directory = await createTestTempDirectory("rea-verified-package-");
  await workflowGit(directory, ["init", "--initial-branch=main"]);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "fixture", version }),
  );
  await workflowGit(directory, ["add", "package.json"]);
  await workflowGit(directory, [
    "commit",
    "-m",
    "test: verified package fixture",
  ]);
  const sourceSha = await workflowGit(directory, ["rev-parse", "HEAD"]);
  const artifactDirectory = join(directory, ".cache", "verified-package");
  await mkdir(artifactDirectory, { recursive: true });
  const archive = "verified tarball fixture";
  await writeFile(join(artifactDirectory, "package.tgz"), archive);
  const manifest = {
    schemaVersion: 2,
    sourceSha,
    runId: 123,
    runAttempt: 2,
    platform: "linux",
    architecture: "x64",
    packageVersion: version,
    nodeVersion: process.version,
    releaseTag: tag,
    sha256: createHash("sha256").update(archive).digest("hex"),
    ...override,
  };
  if (writeManifest)
    await writeFile(
      join(artifactDirectory, "manifest.json"),
      manifestContents ?? JSON.stringify(manifest),
    );
  const output = join(directory, "github-output");
  await writeFile(output, "");
  return {
    directory,
    sourceSha,
    artifactDirectory,
    output,
    version,
    tag,
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
  };
}

function validate(fixture: Fixture, sourceSha = fixture.sourceSha) {
  return executeWorkflowFixture(
    process.execPath,
    [validator, "validate", fixture.artifactDirectory],
    {
      cwd: fixture.directory,
      env: {
        ...process.env,
        GITHUB_SHA: sourceSha,
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_OUTPUT: fixture.output,
      },
    },
  );
}

// Run the actual issuer-side entrypoint outside the repository's node_modules tree.
// This catches an accidental transitive dependency import rather than mocking it away.
async function preparePublication(fixture: Fixture, published = "false") {
  const scripts = join(fixture.directory, "scripts", "ci");
  await mkdir(scripts, { recursive: true });
  for (const name of [
    "prepare-npm-publication.mjs",
    "qualified-package-envelope.mjs",
    "npm-release-state.mjs",
  ]) {
    await copyFile(
      new URL(`../../../scripts/ci/${name}`, import.meta.url),
      join(scripts, name),
    );
  }
  if (published !== "retain")
    await writeFile(
      join(fixture.directory, "registry-state.json"),
      JSON.stringify({
        status:
          published === "unknown" ? 503 : published === "false" ? 404 : 200,
        body: {
          name: "rea-agents",
          versions: {
            [fixture.version]: {
              name: "rea-agents",
              version: fixture.version,
              dist: { integrity: fixture.integrity },
            },
          },
          "dist-tags": { [fixture.tag]: fixture.version },
        },
      }),
    );
  await writeFile(
    join(scripts, "invoke.mjs"),
    `
import { readFile } from "node:fs/promises";
import { prepareNpmPublication } from "./prepare-npm-publication.mjs";
const state = JSON.parse(await readFile("registry-state.json", "utf8"));
await prepareNpmPublication(async (url) => {
  if (url !== "https://registry.npmjs.org/rea-agents") throw new Error("Unexpected registry origin");
  return Response.json(state.body, { status: state.status });
});
`,
  );
  return executeWorkflowFixture(
    process.execPath,
    [join(scripts, "invoke.mjs")],
    {
      cwd: fixture.directory,
      env: {
        ...process.env,
        GITHUB_SHA: fixture.sourceSha,
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_OUTPUT: fixture.output,
      },
    },
  );
}

it.each([
  { version: "1.2.3", tag: "latest", published: "false" },
  { version: "1.2.3-rc.1", tag: "next", published: "true" },
])(
  "prepares $tag publication without installed dependencies (already published: $published)",
  async ({ version, tag, published }) => {
    const fixture = await createFixture({ version, tag });
    await preparePublication(fixture, published);
    expect(await readFile(fixture.output, "utf8")).toBe(
      `tag=${tag}\npublished=${published}\n`,
    );
  },
);

it.each([
  ["old schema", { schemaVersion: 1 }],
  ["wrong source", { sourceSha: "c".repeat(40) }],
  ["wrong run", { runId: 124 }],
  ["future attempt", { runAttempt: 3 }],
  ["wrong Node", { nodeVersion: "v24.0.0" }],
  ["wrong version", { packageVersion: "1.2.4" }],
  ["wrong archive", { sha256: "c".repeat(64) }],
  ["unknown channel", { releaseTag: "beta\noutput=injection" }],
] as const)(
  "refuses issuer-side %s without installed dependencies",
  async (_label, override) => {
    const fixture = await createFixture({ override });
    await expect(preparePublication(fixture)).rejects.toThrow();
    expect(await readFile(fixture.output, "utf8")).toBe("");
  },
);

it("retains same-run reuse and rejects failed registry lookups", async () => {
  const fixture = await createFixture({ override: { runAttempt: 1 } });
  await expect(preparePublication(fixture, "unknown")).rejects.toThrow();
  expect(await readFile(fixture.output, "utf8")).toBe("");
  await preparePublication(fixture);
  expect(await readFile(fixture.output, "utf8")).toBe(
    "tag=latest\npublished=false\n",
  );
});

it("refreshes registry identity when an accepted upload reports a failed command", async () => {
  const fixture = await createFixture();
  await preparePublication(fixture, "false");
  expect(await readFile(fixture.output, "utf8")).toBe(
    "tag=latest\npublished=false\n",
  );
  // A fake npm producer accepts the archive, then fails before reporting success.
  // The next publisher attempt must discover the committed registry state.
  await expect(
    executeWorkflowFixture(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { readFile, writeFile } from "node:fs/promises";
const path = "registry-state.json";
const state = JSON.parse(await readFile(path, "utf8"));
state.status = 200;
await writeFile(path, JSON.stringify(state));
process.exitCode = 1;
`,
      ],
      { cwd: fixture.directory },
    ),
  ).rejects.toMatchObject({ code: 1 });
  await writeFile(fixture.output, "");
  await preparePublication(fixture, "retain");
  expect(await readFile(fixture.output, "utf8")).toBe(
    "tag=latest\npublished=true\n",
  );
});

it.each(["integrity", "channel"])(
  "refuses existing registry %s drift before returning publication intent",
  async (kind) => {
    const fixture = await createFixture();
    if (kind === "integrity") fixture.integrity = "sha512-wrong";
    else fixture.tag = "next";
    await expect(preparePublication(fixture, "true")).rejects.toThrow();
    expect(await readFile(fixture.output, "utf8")).toBe("");
  },
);
