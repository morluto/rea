import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const launcher = fileURLToPath(
  new URL(
    "../../../scripts/plugin-published-mcp-launcher.mjs",
    import.meta.url,
  ),
);

const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
const READY_MARKER = ".rea-plugin-ready";
const CLEANUP_OWNER = ".rea-plugin-cleanup-owner";

const cacheRootFor = (temporaryRoot: string) =>
  join(
    temporaryRoot,
    uid === undefined ? "rea-plugin-mcp" : `rea-plugin-mcp-${uid}`,
  );

const installKeyFor = (version: string) => `${version}-${process.arch}`;

const installPrefix = (version: string, temporaryRoot: string) =>
  join(cacheRootFor(temporaryRoot), installKeyFor(version));

const lockPathFor = (version: string, temporaryRoot: string) =>
  join(cacheRootFor(temporaryRoot), `${installKeyFor(version)}.lock`);

const stagingNamePattern = (version: string) =>
  new RegExp(`^${installKeyFor(version)}\\.staging-\\d+$`, "u");

/**
 * Own the launcher cache under a createTestTempDirectory scope so
 * verify:test-temp-hygiene never sees a leftover rea-plugin-mcp-* root.
 */
const createLauncherTemp = async () => {
  const temporaryRoot = await createTestTempDirectory(
    "rea-published-mcp-cache-",
  );
  return {
    temporaryRoot,
    cacheRoot: cacheRootFor(temporaryRoot),
    env: {
      TMPDIR: temporaryRoot,
      TEMP: temporaryRoot,
      TMP: temporaryRoot,
    } satisfies NodeJS.ProcessEnv,
  };
};

const seedPublishedRuntime = async (
  version: string,
  runtime: string,
  temporaryRoot: string,
) => {
  const prefix = installPrefix(version, temporaryRoot);
  const entry = join(
    prefix,
    "node_modules",
    "rea-agents",
    "scripts",
    "rea.mjs",
  );
  await mkdir(dirname(entry), { recursive: true, mode: 0o700 });
  await mkdir(cacheRootFor(temporaryRoot), { recursive: true, mode: 0o700 });
  if (uid !== undefined) {
    await chmod(cacheRootFor(temporaryRoot), 0o700).catch(() => undefined);
    await chmod(prefix, 0o700);
  }
  await writeFile(entry, runtime, { mode: 0o600 });
  await writeFile(join(prefix, READY_MARKER), version, { mode: 0o600 });
  return entry;
};

const start = (
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string = env.TMPDIR ?? tmpdir(),
) => {
  const child = spawn(process.execPath, [launcher, ...args], {
    cwd,
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
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
  });
  return { child, closed };
};

const awaitStdoutChunk = (child: ChildProcess, label: string) =>
  new Promise<void>((resolve, reject) => {
    const stdout = child.stdout;
    if (stdout === null) {
      reject(new Error(`${label} has no stdout pipe`));
      return;
    }
    stdout.once("data", () => resolve());
    child.once("exit", (code) =>
      reject(new Error(`${label} exited before stdout: ${String(code)}`)),
    );
  });

const waitForFile = async (path: string) => {
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch (cause) {
      if (
        cause === null ||
        typeof cause !== "object" ||
        !("code" in cause) ||
        cause.code !== "ENOENT"
      )
        throw cause;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
};

const waitForProcessExit = async (pid: number, label: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (cause) {
      if (
        cause !== null &&
        typeof cause === "object" &&
        "code" in cause &&
        cause.code === "ESRCH"
      )
        return;
      throw cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} ${String(pid)} remained running`);
};

it.each([["latest"], ["6.8.0&echo wrong"], ["6.8.0", "extra"], []])(
  "rejects a non-exact or extra version argument: %j",
  async (...versionArgs) => {
    const temp = await createLauncherTemp();
    const { child, closed } = start(versionArgs, {
      ...process.env,
      ...temp.env,
    });
    child.stdin.end();
    expect(await closed).toEqual({
      code: 1,
      signal: null,
      stdout: "",
      stderr: "REA plugin requires one exact rea-agents@VERSION pin.\n",
    });
  },
);

it("runs the published runtime in-process from the owner-private install prefix", async () => {
  const version = "6.8.0-published-inprocess";
  const temp = await createLauncherTemp();
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
    temp.temporaryRoot,
  );
  const caller = await createTestTempDirectory("rea-published-caller-");
  const missingBin = await createTestTempDirectory(
    "rea-published-missing-npm-",
  );
  const child = spawn(process.execPath, [launcher, version], {
    cwd: caller,
    env: {
      ...process.env,
      ...temp.env,
      PATH: missingBin,
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
  const reported = JSON.parse(result.stderr) as {
    pid: number;
    args: string[];
    cwd: string;
    entry: string;
  };
  expect(reported.pid).toBe(child.pid);
  expect(reported.args).toEqual(["mcp"]);
  expect(reported.cwd).toBe(caller);
  expect(reported.entry).toBe(
    join(
      installPrefix(version, temp.temporaryRoot),
      "node_modules",
      "rea-agents",
      "scripts",
      "rea.mjs",
    ),
  );
  expect(installKeyFor(version)).toContain(process.arch);
});

it("does not import an install prefix that lacks the ready marker", async () => {
  const version = "6.8.0-published-incomplete";
  const temp = await createLauncherTemp();
  const prefix = installPrefix(version, temp.temporaryRoot);
  const entry = join(
    prefix,
    "node_modules",
    "rea-agents",
    "scripts",
    "rea.mjs",
  );
  await mkdir(dirname(entry), { recursive: true, mode: 0o700 });
  await mkdir(temp.cacheRoot, { recursive: true, mode: 0o700 });
  if (uid !== undefined) {
    await chmod(temp.cacheRoot, 0o700).catch(() => undefined);
    await chmod(prefix, 0o700);
  }
  await writeFile(entry, `process.stdout.write("should-not-run");`, {
    mode: 0o600,
  });
  const missingBin = await createTestTempDirectory(
    "rea-published-incomplete-bin-",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...temp.env,
    PATH: missingBin,
  };
  delete env.npm_execpath;
  const { child, closed } = start([version], env);
  child.stdin.end();
  const result = await closed;
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("should-not-run");
});

it("installs the pinned package under an owner-private temporary prefix when missing", async () => {
  const version = "6.8.0-published-install";
  const temp = await createLauncherTemp();
  const prefix = installPrefix(version, temp.temporaryRoot);
  await rm(prefix, { recursive: true, force: true });
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
  "process.stdout.write(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), prefix: " + JSON.stringify(prefix) + " })); process.exit(0);",
  { mode: 0o600 },
);
`,
  );
  const { child, closed } = start([version], {
    ...process.env,
    ...temp.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  });
  const result = await closed;
  expect(result.code).toBe(0);
  const reported = JSON.parse(result.stdout) as {
    cwd: string;
    argv: string[];
    prefix: string;
  };
  expect(reported.cwd).toBe(temp.temporaryRoot);
  expect(reported.argv).toEqual(["mcp"]);
  expect(basename(reported.prefix)).toMatch(stagingNamePattern(version));
  expect(dirname(reported.prefix)).toBe(temp.cacheRoot);
  expect(result.stderr).toContain("added 1 package in 12ms");
  await access(entry);
  await access(join(prefix, READY_MARKER));
  expect(await readFile(join(prefix, READY_MARKER), "utf8")).toBe(version);
  if (uid !== undefined) {
    expect((await lstat(temp.cacheRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(prefix)).mode & 0o777).toBe(0o700);
  }
});

it("does not reuse a ready cache keyed for a different CPU architecture", async () => {
  const version = "6.8.0-published-arch-mismatch";
  const temp = await createLauncherTemp();
  const wrongArch = process.arch === "arm64" ? "x64" : "arm64";
  const wrongKey = `${version}-${wrongArch}`;
  const wrongPrefix = join(temp.cacheRoot, wrongKey);
  const wrongEntry = join(
    wrongPrefix,
    "node_modules",
    "rea-agents",
    "scripts",
    "rea.mjs",
  );
  await mkdir(dirname(wrongEntry), { recursive: true, mode: 0o700 });
  await mkdir(temp.cacheRoot, { recursive: true, mode: 0o700 });
  if (uid !== undefined) {
    await chmod(temp.cacheRoot, 0o700).catch(() => undefined);
    await chmod(wrongPrefix, 0o700);
  }
  await writeFile(wrongEntry, `process.stdout.write("wrong-arch");`, {
    mode: 0o600,
  });
  await writeFile(join(wrongPrefix, READY_MARKER), version, { mode: 0o600 });

  const bin = await createTestTempDirectory("rea-published-arch-npm-");
  const npmEntry = join(bin, "npm-cli.cjs");
  await writeFile(
    npmEntry,
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(entry, "process.stdout.write('current-arch'); process.exit(0);", { mode: 0o600 });
`,
  );
  const { child, closed } = start([version], {
    ...process.env,
    ...temp.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  });
  const result = await closed;
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("current-arch");
  const currentPrefix = installPrefix(version, temp.temporaryRoot);
  await access(join(currentPrefix, READY_MARKER));
  expect(basename(currentPrefix)).toBe(installKeyFor(version));
});

it("recovers an install lock abandoned before its owner record and an abandoned recovery directory", async () => {
  const version = "6.8.0-published-abandoned-lock";
  const temp = await createLauncherTemp();
  const prefix = installPrefix(version, temp.temporaryRoot);
  const lockPath = lockPathFor(version, temp.temporaryRoot);
  const recoveryPath = `${lockPath}.recovery`;
  await rm(prefix, { recursive: true, force: true });
  await mkdir(temp.cacheRoot, { recursive: true, mode: 0o700 });
  if (uid !== undefined) await chmod(temp.cacheRoot, 0o700);
  const abandonedAt = new Date(Date.now() - 60_000);
  for (const path of [lockPath, recoveryPath]) {
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { mode: 0o700 });
    await utimes(path, abandonedAt, abandonedAt);
  }
  const bin = await createTestTempDirectory("rea-published-npm-");
  const npmEntry = join(bin, "npm-cli.cjs");
  await writeFile(
    npmEntry,
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(entry, "process.stdout.write('recovered'); process.exit(0);", { mode: 0o600 });
`,
  );
  const { child, closed } = start([version], {
    ...process.env,
    ...temp.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  });
  const result = await closed;
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("recovered");
  expect(await readFile(join(prefix, READY_MARKER), "utf8")).toBe(version);
});

it.skipIf(process.platform === "win32")(
  "does not treat a lock as held when the pid file matches this process but no live lease is listening",
  async () => {
    const version = "6.8.0-published-fake-pid-lease";
    const temp = await createLauncherTemp();
    const prefix = installPrefix(version, temp.temporaryRoot);
    const lockPath = lockPathFor(version, temp.temporaryRoot);
    await rm(prefix, { recursive: true, force: true });
    await mkdir(temp.cacheRoot, { recursive: true, mode: 0o700 });
    if (uid !== undefined) await chmod(temp.cacheRoot, 0o700);
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(join(lockPath, "pid"), `${String(process.pid)}\n`, {
      mode: 0o600,
    });
    const bin = await createTestTempDirectory("rea-published-fake-lease-npm-");
    const npmEntry = join(bin, "npm-cli.cjs");
    await writeFile(
      npmEntry,
      `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(entry, "process.stdout.write('lease-recovered'); process.exit(0);", { mode: 0o600 });
`,
    );
    const { child, closed } = start([version], {
      ...process.env,
      ...temp.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      npm_execpath: npmEntry,
    });
    const result = await closed;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("lease-recovered");
    await access(join(prefix, READY_MARKER));
  },
);

it("coordinates concurrent cold starts through one installer publication", async () => {
  const version = "6.8.0-published-concurrent";
  const temp = await createLauncherTemp();
  const prefix = installPrefix(version, temp.temporaryRoot);
  const lockPath = lockPathFor(version, temp.temporaryRoot);
  await rm(prefix, { recursive: true, force: true });
  await rm(lockPath, { recursive: true, force: true });
  const workspace = await createTestTempDirectory("rea-published-concurrent-");
  const bin = join(workspace, "bin");
  await mkdir(bin);
  const npmEntry = join(bin, "npm-cli.cjs");
  const counterPath = join(workspace, "install-count");
  const releasePath = join(workspace, "release");
  const startedPath = join(workspace, "started");
  await writeFile(counterPath, "0", { mode: 0o600 });
  await writeFile(
    npmEntry,
    `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const counterPath = ${JSON.stringify(counterPath)};
const startedPath = ${JSON.stringify(startedPath)};
const releasePath = ${JSON.stringify(releasePath)};
const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const count = Number(readFileSync(counterPath, "utf8")) + 1;
writeFileSync(counterPath, String(count));
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(entry, "process.stdout.write('imported-too-early');", { mode: 0o600 });
writeFileSync(startedPath, prefix);
for (;;) {
  try {
    readFileSync(releasePath);
    break;
  } catch {
    sleep(20);
  }
}
writeFileSync(
  entry,
  "process.stdout.write(JSON.stringify({ installs: " + count + " })); process.exit(0);",
  { mode: 0o600 },
);
`,
  );
  const launchEnv = {
    ...process.env,
    ...temp.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  };
  const first = start([version], launchEnv);
  const stagingPrefix = (await waitForFile(startedPath)).trim();
  expect(basename(stagingPrefix)).toMatch(stagingNamePattern(version));
  const second = start([version], launchEnv);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(second.child.exitCode).toBeNull();
  expect(await readFile(counterPath, "utf8")).toBe("1");
  await writeFile(releasePath, "go", { mode: 0o600 });
  const [firstResult, secondResult] = await Promise.all([
    first.closed,
    second.closed,
  ]);
  expect(firstResult.code).toBe(0);
  expect(secondResult.code).toBe(0);
  expect(firstResult.stdout).toBe(JSON.stringify({ installs: 1 }));
  expect(secondResult.stdout).toBe(JSON.stringify({ installs: 1 }));
  expect(firstResult.stdout).not.toContain("imported-too-early");
  expect(secondResult.stdout).not.toContain("imported-too-early");
  expect(await readFile(counterPath, "utf8")).toBe("1");
  await access(join(prefix, READY_MARKER));
});

it("leaves a stale install lock unchanged while another process reserves recovery", async () => {
  const version = "6.8.0-published-recovery-busy";
  const temp = await createLauncherTemp();
  const prefix = installPrefix(version, temp.temporaryRoot);
  const lockPath = lockPathFor(version, temp.temporaryRoot);
  const recoveryPath = `${lockPath}.recovery`;
  await rm(prefix, { recursive: true, force: true });
  await rm(lockPath, { recursive: true, force: true });
  await rm(recoveryPath, { recursive: true, force: true });
  await mkdir(temp.cacheRoot, { recursive: true, mode: 0o700 });
  if (uid !== undefined)
    await chmod(temp.cacheRoot, 0o700).catch(() => undefined);
  await mkdir(lockPath, { mode: 0o700 });
  if (uid !== undefined) await chmod(lockPath, 0o700);
  await writeFile(join(lockPath, "pid"), "2147483647\n", { mode: 0o600 });
  await mkdir(recoveryPath, { mode: 0o700 });
  const workspace = await createTestTempDirectory(
    "rea-published-recovery-busy-",
  );
  const bin = join(workspace, "bin");
  await mkdir(bin);
  const npmEntry = join(bin, "npm-cli.cjs");
  const counterPath = join(workspace, "install-count");
  await writeFile(counterPath, "0", { mode: 0o600 });
  await writeFile(
    npmEntry,
    `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const counterPath = ${JSON.stringify(counterPath)};
writeFileSync(counterPath, String(Number(readFileSync(counterPath, "utf8")) + 1));
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(entry, "process.exit(0);", { mode: 0o600 });
`,
  );
  const stale = await lstat(lockPath);
  const { child, closed } = start([version], {
    ...process.env,
    ...temp.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(child.exitCode).toBeNull();
  expect(await readFile(counterPath, "utf8")).toBe("0");
  expect((await lstat(lockPath)).ino).toBe(stale.ino);
  expect(await readFile(join(lockPath, "pid"), "utf8")).toBe("2147483647\n");
  await rm(recoveryPath, { recursive: true, force: true });
  const result = await closed;
  expect(result.code).toBe(0);
  expect(await readFile(counterPath, "utf8")).toBe("1");
  await access(join(prefix, READY_MARKER));
});

it("serializes stale install-lock recovery so concurrent recoverers share one publication", async () => {
  const version = "6.8.0-published-stale-recovery";
  const temp = await createLauncherTemp();
  const prefix = installPrefix(version, temp.temporaryRoot);
  const lockPath = lockPathFor(version, temp.temporaryRoot);
  const recoveryPath = `${lockPath}.recovery`;
  await rm(prefix, { recursive: true, force: true });
  await rm(lockPath, { recursive: true, force: true });
  await rm(recoveryPath, { recursive: true, force: true });
  await mkdir(temp.cacheRoot, { recursive: true, mode: 0o700 });
  if (uid !== undefined)
    await chmod(temp.cacheRoot, 0o700).catch(() => undefined);
  await mkdir(lockPath, { mode: 0o700 });
  if (uid !== undefined) await chmod(lockPath, 0o700);
  await writeFile(join(lockPath, "pid"), "2147483647\n", { mode: 0o600 });
  const workspace = await createTestTempDirectory(
    "rea-published-stale-recovery-",
  );
  const bin = join(workspace, "bin");
  await mkdir(bin);
  const npmEntry = join(bin, "npm-cli.cjs");
  const counterPath = join(workspace, "install-count");
  const releasePath = join(workspace, "release");
  const startedPath = join(workspace, "started");
  const runtimeHoldPath = join(workspace, "runtime-hold");
  await writeFile(counterPath, "0", { mode: 0o600 });
  await writeFile(
    npmEntry,
    `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const counterPath = ${JSON.stringify(counterPath)};
const startedPath = ${JSON.stringify(startedPath)};
const releasePath = ${JSON.stringify(releasePath)};
const runtimeHoldPath = ${JSON.stringify(runtimeHoldPath)};
const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const count = Number(readFileSync(counterPath, "utf8")) + 1;
writeFileSync(counterPath, String(count));
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(entry, "process.stdout.write('imported-too-early');", { mode: 0o600 });
writeFileSync(startedPath, prefix);
for (;;) {
  try {
    readFileSync(releasePath);
    break;
  } catch {
    sleep(20);
  }
}
writeFileSync(
  entry,
  [
    'import { readFileSync } from "node:fs";',
    "const hold = " + JSON.stringify(runtimeHoldPath) + ";",
    "const sleep = (ms) =>",
    "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);",
    "process.stdout.write(JSON.stringify({ installs: " + count + " }));",
    "for (;;) {",
    "  try {",
    "    readFileSync(hold);",
    "    break;",
    "  } catch {",
    "    sleep(20);",
    "  }",
    "}",
    "process.exit(0);",
  ].join("\\n"),
  { mode: 0o600 },
);
`,
  );
  const launchEnv = {
    ...process.env,
    ...temp.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  };
  const first = start([version], launchEnv);
  const second = start([version], launchEnv);
  const sawImport = Promise.all([
    awaitStdoutChunk(first.child, "first"),
    awaitStdoutChunk(second.child, "second"),
  ]);
  const stagingPrefix = (await waitForFile(startedPath)).trim();
  expect(basename(stagingPrefix)).toMatch(stagingNamePattern(version));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(first.child.exitCode).toBeNull();
  expect(second.child.exitCode).toBeNull();
  expect(await readFile(counterPath, "utf8")).toBe("1");
  await writeFile(releasePath, "go", { mode: 0o600 });
  await sawImport;
  expect(await readFile(counterPath, "utf8")).toBe("1");
  await access(join(prefix, READY_MARKER));
  await writeFile(runtimeHoldPath, "done", { mode: 0o600 });
  const [firstResult, secondResult] = await Promise.all([
    first.closed,
    second.closed,
  ]);
  expect(firstResult.code).toBe(0);
  expect(secondResult.code).toBe(0);
  expect(firstResult.stdout).toBe(JSON.stringify({ installs: 1 }));
  expect(secondResult.stdout).toBe(JSON.stringify({ installs: 1 }));
  expect(firstResult.stdout).not.toContain("imported-too-early");
  expect(secondResult.stdout).not.toContain("imported-too-early");
  expect(await readFile(counterPath, "utf8")).toBe("1");
});

it("retries retained staging cleanup on a later successful launch", async () => {
  const version = "6.8.0-published-staging-retry";
  const temp = await createLauncherTemp();
  const staging = join(temp.cacheRoot, `${installKeyFor(version)}.staging-123`);
  await mkdir(temp.cacheRoot, { recursive: true, mode: 0o700 });
  if (uid !== undefined) await chmod(temp.cacheRoot, 0o700);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await writeFile(join(staging, "leftover.txt"), "stale", { mode: 0o600 });
  await writeFile(join(staging, CLEANUP_OWNER), `999999\n${staging}\n`, {
    mode: 0o600,
  });
  const bin = await createTestTempDirectory("rea-published-staging-retry-npm-");
  const npmEntry = join(bin, "npm-cli.cjs");
  await writeFile(
    npmEntry,
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(entry, "process.stdout.write('after-retry-cleanup'); process.exit(0);", { mode: 0o600 });
`,
  );
  const { child, closed } = start([version], {
    ...process.env,
    ...temp.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  });
  const result = await closed;
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("after-retry-cleanup");
  await expect(access(staging)).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(uid === undefined || process.platform === "win32")(
  "releases the install lock after retained staging cleanup and publishes on the next launch",
  async () => {
    const version = "6.8.0-published-staging-blocked";
    const temp = await createLauncherTemp();
    const staging = join(
      temp.cacheRoot,
      `${installKeyFor(version)}.staging-456`,
    );
    const lockPath = lockPathFor(version, temp.temporaryRoot);
    await mkdir(temp.cacheRoot, { recursive: true, mode: 0o700 });
    await chmod(temp.cacheRoot, 0o700);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await writeFile(join(staging, CLEANUP_OWNER), `999999\n${staging}\n`, {
      mode: 0o600,
    });
    const bin = await createTestTempDirectory(
      "rea-published-staging-blocked-npm-",
    );
    const npmEntry = join(bin, "npm-cli.cjs");
    await writeFile(
      npmEntry,
      `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(entry, "process.stdout.write('launch-ok'); process.exit(0);", { mode: 0o600 });
`,
    );
    const env = {
      ...process.env,
      ...temp.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      npm_execpath: npmEntry,
    };
    const first = start([version], env);
    const firstResult = await first.closed;
    expect(firstResult.code).toBe(0);
    expect(firstResult.stdout).toBe("launch-ok");
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    const prefix = installPrefix(version, temp.temporaryRoot);
    await access(join(prefix, READY_MARKER));
    await expect(access(staging)).rejects.toMatchObject({ code: "ENOENT" });
    const second = start([version], env);
    second.child.stdin.end();
    const secondResult = await second.closed;
    expect(secondResult.code).toBe(0);
    expect(secondResult.stdout).toBe("launch-ok");
  },
);

it.skipIf(uid === undefined)(
  "refuses a group/other-writable executable cache entry",
  async () => {
    const version = "6.8.0-published-world-writable";
    const temp = await createLauncherTemp();
    const entry = await seedPublishedRuntime(
      version,
      `process.stdout.write("should-not-run");`,
      temp.temporaryRoot,
    );
    await chmod(entry, 0o666);
    const missingBin = await createTestTempDirectory(
      "rea-published-missing-bin-",
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...temp.env,
      PATH: missingBin,
    };
    delete env.npm_execpath;
    const { child, closed } = start([version], env);
    child.stdin.end();
    const result = await closed;
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /refused an untrusted executable cache: executable cache entry is writable by others/u,
    );
  },
);

it.skipIf(uid === undefined)(
  "refuses a symlinked cache root without changing the target mode",
  async () => {
    const version = "6.8.0-published-symlink-root";
    const workspace = await createTestTempDirectory(
      "rea-published-symlink-root-",
    );
    const target = join(workspace, "served");
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755);
    const temporaryRoot = join(workspace, "tmp");
    await mkdir(temporaryRoot, { mode: 0o700 });
    const linkedRoot = cacheRootFor(temporaryRoot);
    await symlink(target, linkedRoot);
    onTestFinished(async () => {
      await rm(linkedRoot, { force: true });
      await chmod(target, 0o700).catch(() => undefined);
    });
    const missingBin = await createTestTempDirectory(
      "rea-published-symlink-root-bin-",
    );
    const { child, closed } = start([version], {
      ...process.env,
      PATH: missingBin,
      TEMP: temporaryRoot,
      TMP: temporaryRoot,
      TMPDIR: temporaryRoot,
    });
    child.stdin.end();
    const result = await closed;
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /refused an untrusted executable cache: executable cache root must not be a symlink/u,
    );
    expect((await lstat(target)).mode & 0o777).toBe(0o755);
  },
);

it("preserves a temporary install prefix that contains spaces as one npm argument", async () => {
  const version = `6.8.0-space-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
  const spacedParent = await createTestTempDirectory(
    "rea-published-space-tmp-",
  );
  const spacedTmp = join(spacedParent, "user temp dir");
  await mkdir(spacedTmp, { recursive: true, mode: 0o700 });
  const spacedRoot = cacheRootFor(spacedTmp);
  const spacedPrefix = installPrefix(version, spacedTmp);
  const bin = await createTestTempDirectory("rea-published-npm-spaces-");
  const npmEntry = join(bin, "selected-npm-entry.cjs");
  await writeFile(
    npmEntry,
    `process.stderr.write("install summary\\n");
process.stderr.write(JSON.stringify({
  argv: process.argv.slice(2),
}));
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(entry, "process.exit(0);", { mode: 0o600 });
`,
  );
  const { child, closed } = start([version], {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    TEMP: spacedTmp,
    TMP: spacedTmp,
    TMPDIR: spacedTmp,
    npm_execpath: npmEntry,
  });
  const result = await closed;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("install summary");
  const reported = JSON.parse(
    result.stderr.slice(result.stderr.indexOf("{")),
  ) as { argv: string[] };
  const prefixArg = reported.argv[reported.argv.indexOf("--prefix") + 1];
  expect(prefixArg).toEqual(
    expect.stringMatching(
      new RegExp(`${installKeyFor(version)}\\.staging-\\d+$`, "u"),
    ),
  );
  expect(dirname(prefixArg ?? "")).toBe(spacedRoot);
  await access(join(spacedPrefix, READY_MARKER));
});

it.skipIf(process.platform === "win32")(
  "delivers SIGTERM to the in-process runtime shutdown handler",
  async () => {
    const version = "6.8.0-published-sigterm";
    const temp = await createLauncherTemp();
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
      temp.temporaryRoot,
    );
    const missingBin = await createTestTempDirectory(
      "rea-published-missing-bin-",
    );
    const { child, closed } = start([version], {
      ...process.env,
      ...temp.env,
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
      signal: null,
      stdout: "ready",
      stderr: "cleaned",
    });
  },
);

it("cancels a cold-start lock wait when MCP stdin closes", async () => {
  const version = "6.8.0-published-stdin-cancel";
  const temp = await createLauncherTemp();
  const prefix = installPrefix(version, temp.temporaryRoot);
  const lockPath = lockPathFor(version, temp.temporaryRoot);
  await rm(prefix, { recursive: true, force: true });
  await rm(lockPath, { recursive: true, force: true });
  const workspace = await createTestTempDirectory(
    "rea-published-stdin-cancel-",
  );
  const bin = join(workspace, "bin");
  await mkdir(bin);
  const npmEntry = join(bin, "npm-cli.cjs");
  const startedPath = join(workspace, "started");
  const releasePath = join(workspace, "release");
  await writeFile(
    npmEntry,
    `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const startedPath = ${JSON.stringify(startedPath)};
const releasePath = ${JSON.stringify(releasePath)};
const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
writeFileSync(startedPath, "go");
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(entry, "process.exitCode = 0;", { mode: 0o600 });
for (;;) {
  try {
    readFileSync(releasePath);
    break;
  } catch {
    sleep(50);
  }
}
`,
  );
  const launchEnv = {
    ...process.env,
    ...temp.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  };
  const holder = start([version], launchEnv);
  onTestFinished(async () => {
    await writeFile(releasePath, "go", { mode: 0o600 }).catch(() => undefined);
    holder.child.kill("SIGKILL");
    await holder.closed.catch(() => undefined);
  });
  await waitForFile(startedPath);
  const waiter = start([version], launchEnv);
  await new Promise((resolve) => setTimeout(resolve, 150));
  // Handshake bytes must survive acquisition handoff; EOF alone cancels.
  waiter.child.stdin.write('{"jsonrpc":"2.0","id":"cancel-wait"}\n');
  waiter.child.stdin.end();
  if (waiter.child.pid !== undefined)
    await waitForProcessExit(waiter.child.pid, "cancelled waiter");
  const waiterResult = await waiter.closed;
  expect(waiterResult.code).toBe(0);
  expect(waiterResult.stdout).toBe("");
  // Holder is still installing; stdin-close must not wait on that work.
  expect(holder.child.exitCode).toBeNull();
  await writeFile(releasePath, "go", { mode: 0o600 });
  holder.child.stdin.end();
  const holderResult = await holder.closed;
  expect(holderResult.code).toBe(0);
});

it("replays buffered MCP stdin to the in-process runtime after acquisition", async () => {
  const version = "6.8.0-published-stdin-handoff";
  const temp = await createLauncherTemp();
  const prefix = installPrefix(version, temp.temporaryRoot);
  await rm(prefix, { recursive: true, force: true });
  const workspace = await createTestTempDirectory(
    "rea-published-stdin-handoff-",
  );
  const bin = join(workspace, "bin");
  await mkdir(bin);
  const npmEntry = join(bin, "npm-cli.cjs");
  const startedPath = join(workspace, "started");
  const releasePath = join(workspace, "release");
  await writeFile(
    npmEntry,
    `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const startedPath = ${JSON.stringify(startedPath)};
const releasePath = ${JSON.stringify(releasePath)};
const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
writeFileSync(startedPath, "go");
for (;;) {
  try {
    readFileSync(releasePath);
    break;
  } catch {
    sleep(20);
  }
}
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(
  entry,
  \`process.stdin.pipe(process.stdout);
process.stdin.on("end", () => { process.exitCode = 0; });
\`,
  { mode: 0o600 },
);
`,
  );
  const { child, closed } = start([version], {
    ...process.env,
    ...temp.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  });
  await waitForFile(startedPath);
  const handshake = '{"jsonrpc":"2.0","id":"handoff"}\n';
  child.stdin.write(handshake);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await writeFile(releasePath, "go", { mode: 0o600 });
  // Unshifted acquisition bytes should reach the runtime without waiting on EOF.
  await awaitStdoutChunk(child, "stdin handoff runtime");
  child.stdin.end();
  const result = await closed;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(handshake);
});

it("owns Windows installer cancellation through taskkill process trees", async () => {
  const source = await readFile(launcher, "utf8");
  expect(source).toMatch(/taskkill[\s\S]*?\/PID[\s\S]*?\/T[\s\S]*?\/F/u);
  expect(source).toMatch(/spawnSync\s*\(\s*["']taskkill["']/u);
});

describe.skipIf(process.platform === "win32")("installer cancellation", () => {
  it.each([
    ["terminates an in-flight npm install and its child on SIGTERM", false],
    ["force-stops an npm install and its child that ignore SIGTERM", true],
  ] as const)("%s", async (_name, ignoreTerm) => {
    const version = `6.8.0-published-install-sigterm-${ignoreTerm ? "forced" : "graceful"}`;
    const temp = await createLauncherTemp();
    const prefix = installPrefix(version, temp.temporaryRoot);
    const lockPath = lockPathFor(version, temp.temporaryRoot);
    await rm(prefix, { recursive: true, force: true });
    const workspace = await createTestTempDirectory(
      "rea-published-install-sigterm-",
    );
    const bin = join(workspace, "bin");
    await mkdir(bin);
    const npmEntry = join(bin, "npm-cli.cjs");
    const pidPath = join(workspace, "npm.pid");
    const childPidPath = join(workspace, "npm-child.pid");
    const holdOpen = `${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}setInterval(() => {}, 1000);`;
    await writeFile(
      npmEntry,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const lifecycle = spawn(
  process.execPath,
  ["-e", ${JSON.stringify(holdOpen)}],
  { stdio: "ignore" },
);
writeFileSync(${JSON.stringify(childPidPath)}, String(lifecycle.pid));
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
${holdOpen}
`,
    );
    const { child, closed } = start([version], {
      ...process.env,
      ...temp.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      npm_execpath: npmEntry,
    });
    const npmPid = Number.parseInt((await waitForFile(pidPath)).trim(), 10);
    const lifecyclePid = Number.parseInt(
      (await waitForFile(childPidPath)).trim(),
      10,
    );
    expect(npmPid).toBeGreaterThan(0);
    expect(lifecyclePid).toBeGreaterThan(0);
    // Lease sockets live under a short hashed path so long TMPDIR lock
    // directories still fit Linux's ~107-byte sun_path limit. The same
    // digest keys Windows pipe names so long TEMP prefixes cannot collide.
    const lockKey = createHash("sha256")
      .update(lockPath)
      .digest("hex")
      .slice(0, 32);
    const siblingLockPath = `${lockPath}-sibling`;
    const siblingKey = createHash("sha256")
      .update(siblingLockPath)
      .digest("hex")
      .slice(0, 32);
    expect(lockKey).not.toBe(siblingKey);
    expect(Buffer.from(lockPath).toString("base64url").slice(0, 80)).toBe(
      Buffer.from(siblingLockPath).toString("base64url").slice(0, 80),
    );
    const leaseSocket = join(
      temp.temporaryRoot,
      uid === undefined ? "rea-mcp-l" : `rea-mcp-l-${uid}`,
      `${lockKey}.sock`,
    );
    expect(join(lockPath, "lease.sock").length).toBeGreaterThan(107);
    expect(leaseSocket.length).toBeLessThanOrEqual(107);
    await access(leaseSocket);
    child.kill("SIGTERM");
    const result = await closed;
    expect(result.code).toBe(143);
    expect(result.stdout).toBe("");
    await waitForProcessExit(npmPid, "npm installer");
    await waitForProcessExit(lifecyclePid, "npm lifecycle child");
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  });
});

describe.skipIf(process.platform !== "win32")(
  "Windows installer cancellation",
  () => {
    it("terminates an in-flight npm install tree before releasing the lock", async () => {
      const version = "6.8.0-published-install-taskkill";
      const temp = await createLauncherTemp();
      const prefix = installPrefix(version, temp.temporaryRoot);
      const lockPath = lockPathFor(version, temp.temporaryRoot);
      await rm(prefix, { recursive: true, force: true });
      const workspace = await createTestTempDirectory(
        "rea-published-install-taskkill-",
      );
      const bin = join(workspace, "bin");
      await mkdir(bin);
      const npmEntry = join(bin, "npm-cli.cjs");
      const pidPath = join(workspace, "npm.pid");
      const childPidPath = join(workspace, "npm-child.pid");
      await writeFile(
        npmEntry,
        `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const lifecycle = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000);"],
  { stdio: "ignore", detached: true, windowsHide: true },
);
lifecycle.unref();
writeFileSync(${JSON.stringify(childPidPath)}, String(lifecycle.pid));
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      const { child, closed } = start([version], {
        ...process.env,
        ...temp.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        npm_execpath: npmEntry,
      });
      const npmPid = Number.parseInt((await waitForFile(pidPath)).trim(), 10);
      const lifecyclePid = Number.parseInt(
        (await waitForFile(childPidPath)).trim(),
        10,
      );
      expect(npmPid).toBeGreaterThan(0);
      expect(lifecyclePid).toBeGreaterThan(0);
      child.kill("SIGTERM");
      const result = await closed;
      expect(result.code).toBe(143);
      expect(result.stdout).toBe("");
      await waitForProcessExit(npmPid, "npm installer");
      await waitForProcessExit(lifecyclePid, "npm lifecycle child");
      await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
