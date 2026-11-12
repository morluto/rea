import { spawn } from "node:child_process";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const launcher = fileURLToPath(
  new URL(
    "../../../scripts/plugin-published-mcp-launcher.mjs",
    import.meta.url,
  ),
);

const installPrefix = (version: string) =>
  join(tmpdir(), "rea-plugin-mcp", version);

const seedPublishedRuntime = async (version: string, runtime: string) => {
  const entry = join(
    installPrefix(version),
    "node_modules",
    "rea-agents",
    "scripts",
    "rea.mjs",
  );
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, runtime);
  onTestFinished(async () => {
    await rm(installPrefix(version), { recursive: true, force: true });
  });
  return entry;
};

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

it("runs the published runtime in-process from the OS temporary install prefix", async () => {
  const version = "6.8.0-published-inprocess";
  await seedPublishedRuntime(
    version,
    `
      process.stderr.write(JSON.stringify({
        pid: process.pid,
        args: process.argv.slice(2),
        cwd: process.cwd(),
        entry: process.argv[1],
      }));
      process.stdin.pipe(process.stdout);
      process.stdin.on("end", () => { process.exitCode = 7; });
    `,
  );
  const caller = await createTestTempDirectory("rea-published-caller-");
  const child = spawn(process.execPath, [launcher, version], {
    cwd: caller,
    env: {
      ...process.env,
      // A missing npm proves the seeded install is reused without a shell child.
      PATH: caller,
    },
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
  child.stdin.end('{"jsonrpc":"2.0","id":1}\n');
  const result = await closed;
  expect(result).toMatchObject({
    code: 7,
    stdout: '{"jsonrpc":"2.0","id":1}\n',
  });
  expect(JSON.parse(result.stderr)).toEqual({
    pid: child.pid,
    args: ["mcp"],
    cwd: caller,
    entry: join(
      installPrefix(version),
      "node_modules",
      "rea-agents",
      "scripts",
      "rea.mjs",
    ),
  });
});

it("installs the pinned package under the OS temporary directory when missing", async () => {
  const version = "6.8.0-published-install";
  const prefix = installPrefix(version);
  await rm(prefix, { recursive: true, force: true });
  onTestFinished(async () => {
    await rm(prefix, { recursive: true, force: true });
  });
  const bin = await createTestTempDirectory("rea-published-npm-");
  const npm = join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
  const entry = join(
    prefix,
    "node_modules",
    "rea-agents",
    "scripts",
    "rea.mjs",
  );
  await writeFile(
    npm,
    process.platform === "win32"
      ? `@echo off\r\nnode -e "const {mkdirSync,writeFileSync}=require('node:fs');const {dirname,join}=require('node:path');const prefix=process.argv[process.argv.indexOf('--prefix')+1];const entry=join(prefix,'node_modules','rea-agents','scripts','rea.mjs');mkdirSync(dirname(entry),{recursive:true});writeFileSync(entry,'process.stdout.write(JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2)}));');" %*\r\n`
      : `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true });
writeFileSync(
  entry,
  "process.stdout.write(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));",
);
`,
  );
  if (process.platform !== "win32") await chmod(npm, 0o755);
  const { child, closed } = start([version], {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  });
  child.stdin.end();
  const result = await closed;
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toEqual({
    cwd: tmpdir(),
    argv: ["mcp"],
  });
  await access(entry);
});

it.skipIf(process.platform === "win32")(
  "delivers SIGTERM to the in-process runtime shutdown handler",
  async () => {
    const version = "6.8.0-published-sigterm";
    await seedPublishedRuntime(
      version,
      `
      process.on("SIGTERM", () => {
        process.stderr.write("cleaned");
        process.exit(0);
      });
      process.stdin.resume();
      process.stdout.write("ready");
    `,
    );
    const missingBin = await createTestTempDirectory(
      "rea-published-missing-bin-",
    );
    const { child, closed } = start([version], {
      ...process.env,
      PATH: missingBin,
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error("runtime exited before readiness")),
      );
    });
    child.kill("SIGTERM");
    expect(await closed).toEqual({
      code: 0,
      stdout: "ready",
      stderr: "cleaned",
    });
  },
);
