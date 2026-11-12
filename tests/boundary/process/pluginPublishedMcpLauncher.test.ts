import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const launcher = fileURLToPath(
  new URL(
    "../../../scripts/plugin-published-mcp-launcher.mjs",
    import.meta.url,
  ),
);

const start = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const child = spawn(process.execPath, [launcher, ...args], {
    cwd: tmpdir(),
    env,
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  child.stderr.on("data", (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  const closed = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
  });
  return { child, closed };
};

it.each([["latest"], ["6.8.0&echo wrong"], ["6.8.0", "extra"], []])(
  "rejects a non-exact or extra version argument: %j",
  async (...args) => {
    const { child, closed } = start(args);
    child.stdin.end();
    expect(await closed).toEqual({
      code: 1,
      stdout: "",
      stderr: "REA plugin requires one exact rea-agents@VERSION pin.\n",
    });
  },
);

it("launches npx for the pinned package from the OS temporary directory", async () => {
  const root = await createTestTempDirectory("rea-published-npx-");
  const log = join(root, "launch.json");
  const npx = join(root, process.platform === "win32" ? "npx.cmd" : "npx");
  await writeFile(
    npx,
    process.platform === "win32"
      ? `@echo off\r\nnode -e "require('node:fs').writeFileSync(process.env.REA_LAUNCH_LOG, JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd()}))" %*\r\n`
      : `#!/usr/bin/env node\nconst { writeFileSync } = require("node:fs");\nwriteFileSync(process.env.REA_LAUNCH_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`,
  );
  if (process.platform !== "win32") await chmod(npx, 0o755);
  const { child, closed } = start(["6.8.0"], {
    ...process.env,
    PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
    REA_LAUNCH_LOG: log,
  });
  child.stdin.end();
  expect(await closed).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(JSON.parse(await readFile(log, "utf8"))).toEqual({
    argv: ["-y", "rea-agents@6.8.0", "mcp"],
    cwd: tmpdir(),
  });
});
