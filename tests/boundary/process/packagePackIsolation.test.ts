import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execFileAsync = promisify(execFile);
const expectedFailure =
  "package did not retain its MCP Registry ownership marker";

it("keeps npm pack output in the owned workspace when package validation fails", async () => {
  const testRoot = await createTestTempDirectory("rea-pack-isolation-");
  const packageRoot = join(testRoot, "source");
  const workspace = join(testRoot, "workspace");
  const npmCache = join(testRoot, "npm-cache");
  const archiveName = "rea-agents-6.0.0.tgz";
  const archivePath = join(packageRoot, archiveName);
  const sentinel = Buffer.from("caller-owned archive\n");
  await Promise.all([mkdir(packageRoot), mkdir(workspace), mkdir(npmCache)]);
  await Promise.all([
    writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "rea-agents",
        version: "6.0.0",
        mcpName: "invalid-owner",
        bin: { rea: "scripts/rea.mjs", "rea-agents": "scripts/rea.mjs" },
        dependencies: { "@lydell/node-pty": "1.1.0" },
      }),
    ),
    writeFile(archivePath, sentinel),
  ]);
  const packageContentsBefore = (await readdir(packageRoot)).sort();
  const packerUrl = pathToFileURL(
    resolve("scripts/verify-package-pack.mjs"),
  ).href;
  const harness = `
import { rm } from "node:fs/promises";
const workspace = ${JSON.stringify(workspace)};
let failure;
try {
  const { verifyPackagePack } = await import(${JSON.stringify(packerUrl)});
  await verifyPackagePack({ root: ${JSON.stringify(packageRoot)}, workspace });
} catch (cause) {
  if (!(cause instanceof Error) || cause.message !== ${JSON.stringify(expectedFailure)}) throw cause;
  failure = cause.message;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
if (failure !== ${JSON.stringify(expectedFailure)}) throw new Error("Expected package metadata validation to fail after packing");
process.stdout.write(JSON.stringify({ failure }));
`;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", harness],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        npm_config_cache: npmCache,
        TEMP: npmCache,
        TMP: npmCache,
        TMPDIR: npmCache,
      },
      maxBuffer: 1_024 * 1_024,
    },
  );

  expect(JSON.parse(stdout)).toEqual({ failure: expectedFailure });
  expect((await readdir(packageRoot)).sort()).toEqual(packageContentsBefore);
  expect(await readFile(archivePath)).toEqual(sentinel);
  await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
});
