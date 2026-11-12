import { spawn } from "node:child_process";
import { access, chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
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

const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

const installPrefix = (version: string) =>
  join(
    tmpdir(),
    uid === undefined ? "rea-plugin-mcp" : `rea-plugin-mcp-${uid}`,
    version,
  );

const seedPublishedRuntime = async (version: string, runtime: string) => {
  const prefix = installPrefix(version);
  const entry = join(
    prefix,
    "node_modules",
    "rea-agents",
    "scripts",
    "rea.mjs",
  );
  await mkdir(dirname(entry), { recursive: true, mode: 0o700 });
  if (uid !== undefined) {
    await chmod(join(tmpdir(), `rea-plugin-mcp-${uid}`), 0o700).catch(
      () => undefined,
    );
    await chmod(prefix, 0o700);
  }
  await writeFile(entry, runtime, { mode: 0o600 });
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

it("runs the published runtime in-process from the owner-private install prefix", async () => {
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

it("installs the pinned package under an owner-private temporary prefix when missing", async () => {
  const version = "6.8.0-published-install";
  const prefix = installPrefix(version);
  await rm(prefix, { recursive: true, force: true });
  onTestFinished(async () => {
    await rm(prefix, { recursive: true, force: true });
  });
  const bin = await createTestTempDirectory("rea-published-npm-");
  const npmEntry = join(bin, "npm-cli.cjs");
  const entry = join(
    prefix,
    "node_modules",
    "rea-agents",
    "scripts",
    "rea.mjs",
  );
  await writeFile(
    npmEntry,
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
process.stdout.write("added 1 package in 12ms\\n");
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(
  entry,
  "process.stdout.write(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), prefix: " + JSON.stringify(prefix) + " }));",
  { mode: 0o600 },
);
`,
  );
  const { child, closed } = start([version], {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  });
  child.stdin.end();
  const result = await closed;
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    JSON.stringify({
      cwd: tmpdir(),
      argv: ["mcp"],
      prefix,
    }),
  );
  expect(result.stderr).toContain("added 1 package in 12ms");
  await access(entry);
  if (uid !== undefined) {
    const root = join(tmpdir(), `rea-plugin-mcp-${uid}`);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(prefix)).mode & 0o777).toBe(0o700);
  }
});

it.skipIf(uid === undefined)(
  "refuses a group/other-writable executable cache entry",
  async () => {
    const version = "6.8.0-published-world-writable";
    const entry = await seedPublishedRuntime(
      version,
      `process.stdout.write("should-not-run");`,
    );
    await chmod(entry, 0o666);
    const missingBin = await createTestTempDirectory(
      "rea-published-missing-bin-",
    );
    const { child, closed } = start([version], {
      ...process.env,
      PATH: missingBin,
    });
    child.stdin.end();
    const result = await closed;
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /refused an untrusted executable cache: executable cache entry is writable by others/u,
    );
  },
);

it("preserves a temporary install prefix that contains spaces as one npm argument", async () => {
  const version = "6.8.0-published-space-prefix";
  const spacedParent = await createTestTempDirectory(
    "rea-published-space-tmp-",
  );
  const spacedTmp = join(spacedParent, "user temp dir");
  await mkdir(spacedTmp, { recursive: true, mode: 0o700 });
  const spacedPrefix = join(
    spacedTmp,
    uid === undefined ? "rea-plugin-mcp" : `rea-plugin-mcp-${uid}`,
    version,
  );
  onTestFinished(async () => {
    await rm(spacedPrefix, { recursive: true, force: true });
  });
  const bin = await createTestTempDirectory("rea-published-npm-spaces-");
  const npmEntry = join(bin, "selected-npm-entry.cjs");
  await writeFile(
    npmEntry,
    `process.stdout.write("install summary\\n");
process.stderr.write(JSON.stringify({
  argv: process.argv.slice(2),
}));
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(entry, "process.exitCode = 0;", { mode: 0o600 });
`,
  );
  const { child, closed } = start([version], {
    ...process.env,
    PATH: bin,
    TEMP: spacedTmp,
    TMP: spacedTmp,
    TMPDIR: spacedTmp,
    npm_execpath: npmEntry,
  });
  child.stdin.end();
  const result = await closed;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("install summary");
  const reported = JSON.parse(
    result.stderr.slice(result.stderr.indexOf("{")),
  ) as { argv: string[] };
  expect(reported.argv[reported.argv.indexOf("--prefix") + 1]).toBe(
    spacedPrefix,
  );
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
