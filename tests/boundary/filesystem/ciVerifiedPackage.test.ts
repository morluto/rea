import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
};

it("validates a tarball against the exact checkout and current workflow attempt", async () => {
  const fixture = await createFixture();
  const result = await validate(fixture);

  expect(result.stdout.trim()).toBe(
    join(fixture.artifactDirectory, "package.tgz"),
  );
  expect(await readFile(fixture.output, "utf8")).toBe(
    `tarball=${join(fixture.artifactDirectory, "package.tgz")}\n`,
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
  ["manifest with missing fields", JSON.stringify({ schemaVersion: 1 })],
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
}: FixtureOptions = {}) {
  const directory = await createTestTempDirectory("rea-verified-package-");
  await workflowGit(directory, ["init", "--initial-branch=main"]);
  await writeFile(
    join(directory, "package.json"),
    '{"name":"fixture","version":"1.2.3"}\n',
  );
  await workflowGit(directory, ["add", "package.json"]);
  await workflowGit(directory, [
    "commit",
    "-m",
    "test: verified package fixture",
  ]);
  const sourceSha = await workflowGit(directory, ["rev-parse", "HEAD"]);
  const artifactDirectory = join(directory, "artifact");
  await mkdir(artifactDirectory);
  const archive = "verified tarball fixture";
  await writeFile(join(artifactDirectory, "package.tgz"), archive);
  const manifest = {
    schemaVersion: 1,
    sourceSha,
    runId: 123,
    runAttempt: 2,
    platform: "linux",
    architecture: "x64",
    packageVersion: "1.2.3",
    nodeVersion: process.version,
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
  return { directory, sourceSha, artifactDirectory, output };
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
