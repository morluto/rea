import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { describe, expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processHasStopped } from "../../support/process/observePosixProcess.js";
import { removeTestWorkspace } from "../../support/workspace/workspaceFixture.js";

/** Bound for launcher teardown to cancel an owned installer before force-kill. */
const LAUNCHER_TEARDOWN_GRACE_MS = 2_000;

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

/** sockaddr_un.sun_path usable bytes; matches the launcher platform split. */
const posixLeaseSocketPathLimit = process.platform === "darwin" ? 103 : 107;

/**
 * Own the launcher cache under a createTestTempDirectory scope so
 * verify:test-temp-hygiene never sees a leftover rea-plugin-mcp-* root.
 * Windows admits LOCALAPPDATA (not shared TEMP) as the cache parent.
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
      LOCALAPPDATA: temporaryRoot,
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

const waitForClosed = (
  closed: Promise<unknown>,
  graceMs: number,
): Promise<boolean> =>
  Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), graceMs),
    ),
  ]);

/**
 * Force-stop a launcher and any detached installer tree it still parents.
 * stdin-EOF / SIGTERM normally cancel through runOwnedInstaller; this path is
 * only the bounded fallback when that ownership path does not finish.
 */
const forceStopLauncherTree = (child: ChildProcess) => {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  // Detached npm leads its own process group; signal still-parented children
  // before SIGKILL so their groups do not outlive the launcher pipe.
  const listed = spawnSync("pgrep", ["-P", String(child.pid)], {
    encoding: "utf8",
  });
  if (listed.status === 0) {
    for (const line of listed.stdout.split("\n")) {
      const pid = Number.parseInt(line.trim(), 10);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Child already exited.
        }
      }
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Launcher already exited.
  }
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
    if (child.exitCode === null && child.signalCode === null) {
      // Close stdin first so observeAcquisitionCancel stops a detached
      // installer before any forced kill can orphan it on the stderr pipe.
      try {
        if (child.stdin !== null && !child.stdin.destroyed) child.stdin.end();
      } catch {
        // Case may already have closed stdin.
      }
      if (await waitForClosed(closed, LAUNCHER_TEARDOWN_GRACE_MS)) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // Launcher already exited.
      }
      if (await waitForClosed(closed, LAUNCHER_TEARDOWN_GRACE_MS)) return;
      forceStopLauncherTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
    }
    await closed.catch(() => undefined);
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
    // Signal 0 still succeeds for zombies; use the shared observer so Linux
    // containers without a reaping init do not treat a stopped fixture as live.
    if (await processHasStopped(pid)) return;
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
  // Pin a failing npm entry so a missed ready marker cannot hit the registry.
  const bin = await createTestTempDirectory("rea-published-missing-npm-");
  const npmEntry = join(bin, "npm-cli.cjs");
  await writeFile(
    npmEntry,
    `#!/usr/bin/env node
process.stderr.write("controlled npm install failure\\n");
process.exit(1);
`,
  );
  const child = spawn(process.execPath, [launcher, version], {
    cwd: caller,
    env: {
      ...process.env,
      ...temp.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      npm_execpath: npmEntry,
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
  const bin = await createTestTempDirectory("rea-published-incomplete-npm-");
  const npmEntry = join(bin, "npm-cli.cjs");
  await writeFile(
    npmEntry,
    `#!/usr/bin/env node
process.stderr.write("controlled npm install failure\\n");
process.exit(1);
`,
  );
  // Keep stdin open until the install failure settles so this path is not
  // confused with acquisition EOF cancellation (exit 0).
  const { closed } = start([version], {
    ...process.env,
    ...temp.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  });
  const result = await closed;
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(
    `REA plugin failed to install rea-agents@${version}.`,
  );
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

it.skipIf(process.platform === "win32")(
  "shares one install lease across symlink-equivalent TMPDIR spellings",
  async () => {
    const version = "6.8.0-published-alias-tmpdir";
    const physicalRoot = await createTestTempDirectory(
      "rea-published-alias-physical-",
    );
    const aliasParent = await createTestTempDirectory(
      "rea-published-alias-link-",
    );
    const aliasRoot = join(aliasParent, "tmpdir-alias");
    await symlink(physicalRoot, aliasRoot);
    expect(await realpath(aliasRoot)).toBe(await realpath(physicalRoot));

    const physicalLock = lockPathFor(version, physicalRoot);
    const aliasLock = lockPathFor(version, aliasRoot);
    expect(physicalLock).not.toBe(aliasLock);
    expect(
      createHash("sha256").update(physicalLock).digest("hex").slice(0, 32),
    ).not.toBe(
      createHash("sha256").update(aliasLock).digest("hex").slice(0, 32),
    );

    const prefix = installPrefix(version, physicalRoot);
    await rm(prefix, { recursive: true, force: true });
    await rm(physicalLock, { recursive: true, force: true }).catch(
      () => undefined,
    );

    const workspace = await createTestTempDirectory(
      "rea-published-alias-tmpdir-",
    );
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

    const sharedPath = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    const physicalEnv = {
      ...process.env,
      TMPDIR: physicalRoot,
      TEMP: physicalRoot,
      TMP: physicalRoot,
      PATH: sharedPath,
      npm_execpath: npmEntry,
    };
    const aliasEnv = {
      ...process.env,
      TMPDIR: aliasRoot,
      TEMP: aliasRoot,
      TMP: aliasRoot,
      PATH: sharedPath,
      npm_execpath: npmEntry,
    };

    const first = start([version], physicalEnv);
    const stagingPrefix = (await waitForFile(startedPath)).trim();
    expect(dirname(stagingPrefix)).toBe(cacheRootFor(physicalRoot));
    const second = start([version], aliasEnv);
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
    expect(await readFile(counterPath, "utf8")).toBe("1");
    await access(join(prefix, READY_MARKER));
  },
);

it.skipIf(process.platform === "win32")(
  "selects one lease socket root for short and long TMPDIR aliases",
  async () => {
    const version = "6.8.0-published-alias-socket-root";
    const leaseDirectoryName =
      uid === undefined ? "rea-mcp-l" : `rea-mcp-l-${uid}`;
    const sampleSocketName = `${"0".repeat(32)}.sock`;
    const leaseSocketFits = (root: string) =>
      Buffer.byteLength(
        join(root, leaseDirectoryName, sampleSocketName),
        "utf8",
      ) <= posixLeaseSocketPathLimit;

    // Short physical root under /tmp so the preferred lease socket fits; a long
    // symlink spelling of the same directory sits past the sun_path budget and
    // would fall back to /tmp if length were checked before realpath.
    const physicalRoot = await realpath(
      await mkdtemp(join(await realpath("/tmp"), "rea-pub-sock-")),
    );
    onTestFinished(async () => {
      await removeTestWorkspace(physicalRoot);
    });
    expect(leaseSocketFits(physicalRoot)).toBe(true);

    let longParent = await createTestTempDirectory(
      "rea-published-alias-socket-long-",
    );
    while (leaseSocketFits(join(longParent, "tmpdir-alias"))) {
      longParent = join(longParent, "n".repeat(24));
      await mkdir(longParent, { recursive: true, mode: 0o700 });
    }
    const aliasRoot = join(longParent, "tmpdir-alias");
    await symlink(physicalRoot, aliasRoot);
    expect(await realpath(aliasRoot)).toBe(physicalRoot);
    expect(leaseSocketFits(aliasRoot)).toBe(false);

    const expectedSocketRoot = join(physicalRoot, leaseDirectoryName);
    const rawAliasSocketRoot = join("/tmp", leaseDirectoryName);
    expect(expectedSocketRoot).not.toBe(rawAliasSocketRoot);

    const physicalLock = lockPathFor(version, physicalRoot);
    const lockKey = createHash("sha256")
      .update(physicalLock)
      .digest("hex")
      .slice(0, 32);
    const expectedLeaseSocket = join(expectedSocketRoot, `${lockKey}.sock`);
    const rawAliasLeaseSocket = join(rawAliasSocketRoot, `${lockKey}.sock`);

    const prefix = installPrefix(version, physicalRoot);
    await rm(prefix, { recursive: true, force: true });
    await rm(physicalLock, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await rm(expectedLeaseSocket, { force: true }).catch(() => undefined);
    await rm(rawAliasLeaseSocket, { force: true }).catch(() => undefined);

    const workspace = await createTestTempDirectory(
      "rea-published-alias-socket-",
    );
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

    const sharedPath = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    const physicalEnv = {
      ...process.env,
      TMPDIR: physicalRoot,
      TEMP: physicalRoot,
      TMP: physicalRoot,
      PATH: sharedPath,
      npm_execpath: npmEntry,
    };
    const aliasEnv = {
      ...process.env,
      TMPDIR: aliasRoot,
      TEMP: aliasRoot,
      TMP: aliasRoot,
      PATH: sharedPath,
      npm_execpath: npmEntry,
    };

    const first = start([version], physicalEnv);
    await waitForFile(startedPath);
    await access(expectedLeaseSocket);
    await expect(access(rawAliasLeaseSocket)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const second = start([version], aliasEnv);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(second.child.exitCode).toBeNull();
    expect(await readFile(counterPath, "utf8")).toBe("1");
    await access(expectedLeaseSocket);
    await expect(access(rawAliasLeaseSocket)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeFile(releasePath, "go", { mode: 0o600 });
    const [firstResult, secondResult] = await Promise.all([
      first.closed,
      second.closed,
    ]);
    expect(firstResult.code).toBe(0);
    expect(secondResult.code).toBe(0);
    expect(firstResult.stdout).toBe(JSON.stringify({ installs: 1 }));
    expect(secondResult.stdout).toBe(JSON.stringify({ installs: 1 }));
    expect(await readFile(counterPath, "utf8")).toBe("1");
  },
);

it.skipIf(process.platform === "win32")(
  "applies the host sun_path budget when selecting a preferred lease socket root",
  async () => {
    const version = "6.8.0-published-sun-path-budget";
    const leaseDirectoryName =
      uid === undefined ? "rea-mcp-l" : `rea-mcp-l-${uid}`;
    const sampleSocketName = `${"0".repeat(32)}.sock`;
    const socketBytes = (root: string) =>
      Buffer.byteLength(
        join(root, leaseDirectoryName, sampleSocketName),
        "utf8",
      );

    // A 105-byte preferred socket fits Linux's 107-byte budget but exceeds
    // Darwin's 103-byte sun_path; the launcher must choose accordingly.
    const targetBytes = 105;
    expect(targetBytes).toBeGreaterThan(103);
    expect(targetBytes).toBeLessThanOrEqual(107);

    const baseRoot = await realpath(
      await mkdtemp(join(await realpath("/tmp"), "rea-pub-sun-")),
    );
    onTestFinished(async () => {
      await removeTestWorkspace(baseRoot);
    });
    const pad = targetBytes - socketBytes(baseRoot) - 1; // -1 for path separator
    expect(pad).toBeGreaterThan(0);
    const physicalRoot = join(baseRoot, "p".repeat(pad));
    await mkdir(physicalRoot, { recursive: true, mode: 0o700 });
    expect(socketBytes(physicalRoot)).toBe(targetBytes);

    const preferredSocketRoot = join(physicalRoot, leaseDirectoryName);
    const fallbackSocketRoot = join("/tmp", leaseDirectoryName);
    const expectsPreferred = targetBytes <= posixLeaseSocketPathLimit;
    expect(expectsPreferred).toBe(process.platform !== "darwin");

    const physicalLock = lockPathFor(version, physicalRoot);
    const lockKey = createHash("sha256")
      .update(physicalLock)
      .digest("hex")
      .slice(0, 32);
    const preferredLeaseSocket = join(preferredSocketRoot, `${lockKey}.sock`);
    const fallbackLeaseSocket = join(fallbackSocketRoot, `${lockKey}.sock`);

    const prefix = installPrefix(version, physicalRoot);
    await rm(prefix, { recursive: true, force: true });
    await rm(physicalLock, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await rm(preferredLeaseSocket, { force: true }).catch(() => undefined);
    await rm(fallbackLeaseSocket, { force: true }).catch(() => undefined);

    const workspace = await createTestTempDirectory("rea-published-sun-path-");
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
  "process.stdout.write('ok'); process.exit(0);",
  { mode: 0o600 },
);
`,
    );

    const { child, closed } = start([version], {
      ...process.env,
      TMPDIR: physicalRoot,
      TEMP: physicalRoot,
      TMP: physicalRoot,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      npm_execpath: npmEntry,
    });
    await waitForFile(startedPath);
    if (expectsPreferred) {
      await access(preferredLeaseSocket);
      await expect(access(fallbackLeaseSocket)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } else {
      await access(fallbackLeaseSocket);
      await expect(access(preferredLeaseSocket)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    await writeFile(releasePath, "go", { mode: 0o600 });
    const result = await closed;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok");
  },
);

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

it("preserves a freshly claimed install lock during recovery recheck", async () => {
  // Outer age check can pass on an abandoned lock; a third client may then
  // claim the pathname before the recoverer's inner recheck. Without a grace
  // check under the recovery barrier, that unbound fresh lock is deleted.
  const version = "6.8.0-published-recovery-fresh-claim";
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
  const abandonedAt = new Date(Date.now() - 60_000);
  await utimes(lockPath, abandonedAt, abandonedAt);

  const workspace = await createTestTempDirectory(
    "rea-published-recovery-fresh-claim-",
  );
  const bin = join(workspace, "bin");
  await mkdir(bin);
  const npmEntry = join(bin, "npm-cli.cjs");
  const counterPath = join(workspace, "install-count");
  const plantedPid = "123456789\n";
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
writeFileSync(entry, "process.stdout.write('after-fresh-claim'); process.exit(0);", { mode: 0o600 });
`,
  );

  // Widen only the inner recovery recheck window so the plant can land after
  // claimInstallLock fails and before the grace/delete decision. Production
  // lockOwnerAlive is unchanged; this copy still runs the real grace check.
  // Keep the fixture beside the real launcher so ./lib/npm-invocation.mjs resolves.
  const fixtureLauncher = join(
    dirname(launcher),
    `.fixture-recovery-fresh-claim-${String(process.pid)}.mjs`,
  );
  const launcherSource = await readFile(launcher, "utf8");
  const delayedAlive = launcherSource.replace(
    "const lockOwnerAlive = (lockPath) =>\n  new Promise((resolve) => {",
    "const lockOwnerAlive = (lockPath) =>\n  new Promise((resolve) => {\n    const settle = resolve;\n    resolve = (alive) => setTimeout(() => settle(alive), 200);",
  );
  expect(delayedAlive).not.toBe(launcherSource);
  await writeFile(fixtureLauncher, delayedAlive, { mode: 0o600 });
  onTestFinished(async () => {
    await rm(fixtureLauncher, { force: true });
  });

  const plantFreshClaim = (async () => {
    for (;;) {
      try {
        await access(recoveryPath);
        break;
      } catch (cause) {
        if (
          cause === null ||
          typeof cause !== "object" ||
          !("code" in cause) ||
          cause.code !== "ENOENT"
        )
          throw cause;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    // Simulate a failed install releasing the abandoned lock and a third
    // client claiming the pathname before the recoverer's lease recheck.
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath, { mode: 0o700 });
    if (uid !== undefined) chmodSync(lockPath, 0o700);
    writeFileSync(join(lockPath, "pid"), plantedPid, { mode: 0o600 });
  })();

  const child = spawn(process.execPath, [fixtureLauncher, version], {
    cwd: temp.env.TMPDIR ?? tmpdir(),
    env: {
      ...process.env,
      ...temp.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      npm_execpath: npmEntry,
    },
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  child.stderr?.on("data", (bytes: Buffer) => {
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
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (child.stdin !== null && !child.stdin.destroyed) child.stdin.end();
      } catch {
        // Already closed.
      }
      if (await waitForClosed(closed, LAUNCHER_TEARDOWN_GRACE_MS)) return;
      forceStopLauncherTree(child);
    }
    await closed.catch(() => undefined);
  });

  await plantFreshClaim;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(child.exitCode).toBeNull();
  expect(await readFile(counterPath, "utf8")).toBe("0");
  expect(await readFile(join(lockPath, "pid"), "utf8")).toBe(plantedPid);

  const aged = new Date(Date.now() - 60_000);
  await utimes(lockPath, aged, aged);
  const result = await closed;
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("after-fresh-claim");
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

it("verifies Windows cache privacy by SID rather than account display names", async () => {
  const source = await readFile(launcher, "utf8");
  const inspect = source.match(
    /const inspectWindowsPrivateAcl =[\s\S]*?\n\};\n\nconst verifyWindowsOwnedCachePath/u,
  )?.[0];
  expect(inspect).toBeDefined();
  // Mirrors native verifyPrivate / privateRuntimeAclObserver: owner and every
  // ACE trustee are compared as SecurityIdentifier values, including SYSTEM.
  expect(source).toMatch(/const WINDOWS_SYSTEM_SID = "S-1-5-18";/u);
  expect(inspect).toMatch(/SecurityIdentifier/u);
  expect(inspect).toMatch(/GetOwner\(\$sid\)/u);
  expect(inspect).toMatch(/GetAccessRules\(\$true, \$true, \$sid\)/u);
  expect(inspect).toMatch(/WINDOWS_SYSTEM_SID/u);
  expect(inspect).toMatch(/WindowsIdentity\]::GetCurrent\(\)\.User/u);
  // verifyPrivate requires SE_DACL_PROTECTED only for the private root, not
  // for files that inherit safe ACEs from that root.
  expect(inspect).toMatch(
    /REA_PLUGIN_CACHE_ACL_FILE -ne '1' -and -not \$security\.AreAccessRulesProtected/u,
  );
  expect(inspect).not.toMatch(
    /if \(-not \$security\.AreAccessRulesProtected\) \{ throw 'private DACL must be protected' \}/u,
  );
  expect(inspect).not.toMatch(/Get-Acl|\.Access\b|NTAccount|\.Translate\b/u);
  // Display-name Everyone/Users matching and USERNAME substring checks do not
  // prove ownership or exclude a foreign named writer.
  expect(inspect).not.toMatch(/Everyone\|Users\|Authenticated Users/u);
  expect(inspect).not.toMatch(/icacls/u);
  expect(inspect).not.toMatch(/windowsCacheUser|USERNAME/u);
});

it("establishes Windows cache ownership when elevated defaults use Administrators", async () => {
  const source = await readFile(launcher, "utf8");
  const establish = source.match(
    /const establishWindowsPrivateOwner =[\s\S]*?\n\};\n\n\/\*\*/u,
  )?.[0];
  const apply = source.match(
    /const applyWindowsPrivateAcl =[\s\S]*?\n\};\n\n\/\*\*/u,
  )?.[0];
  const publish = source.match(
    /const publishInstalledPrefix =[\s\S]*?\n\};\n\n\/\*\*/u,
  )?.[0];
  expect(establish).toBeDefined();
  expect(apply).toBeDefined();
  expect(publish).toBeDefined();
  // Elevated tokens default new-object owners to Administrators; repair must
  // set the account owner (icacls /setowner) rather than weaken verification.
  expect(establish).toMatch(/\/setowner/u);
  expect(establish).toMatch(/windowsCacheUser\(\)/u);
  expect(apply).toMatch(/establishWindowsPrivateOwner\(path, kind\)/u);
  // Installer outputs (npm entry + ready marker) get ownership without a file
  // DACL rewrite that would clear inheritance.
  expect(publish).toMatch(
    /establishWindowsPrivateOwner\(cacheEntry\(staging\), "entry"\)/u,
  );
  expect(publish).toMatch(
    /establishWindowsPrivateOwner\(readyMarkerPath\(staging\), "ready"\)/u,
  );
  expect(publish).toMatch(
    /verifyOwnedCachePath\(cacheEntry\(staging\), "entry"\)/u,
  );
  expect(publish).toMatch(
    /verifyOwnedCachePath\(readyMarkerPath\(staging\), "ready"\)/u,
  );
});

it.skipIf(process.platform !== "win32")(
  "accepts a Windows cold install whose files inherit the private directory DACL",
  async () => {
    const version = "6.8.0-published-inherited-file-acl";
    const temp = await createLauncherTemp();
    const prefix = installPrefix(version, temp.temporaryRoot);
    await rm(prefix, { recursive: true, force: true });
    const bin = await createTestTempDirectory(
      "rea-published-inherited-file-acl-npm-",
    );
    const npmEntry = join(bin, "npm-cli.cjs");
    const entry = join(
      prefix,
      "node_modules",
      "rea-agents",
      "scripts",
      "rea.mjs",
    );
    // npm/writeFileSync create the entry without icacls; the ready marker is
    // also written without an explicit protected DACL. Publication must accept
    // those inherited file ACLs once the staging directory is private.
    await writeFile(
      npmEntry,
      `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
const entry = join(prefix, "node_modules", "rea-agents", "scripts", "rea.mjs");
mkdirSync(dirname(entry), { recursive: true, mode: 0o700 });
writeFileSync(entry, "process.stdout.write('inherited-ok'); process.exit(0);", { mode: 0o600 });
`,
    );
    const { closed } = start([version], {
      ...process.env,
      ...temp.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      npm_execpath: npmEntry,
    });
    const result = await closed;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("inherited-ok");
    await access(entry);
    await access(join(prefix, READY_MARKER));
    // Confirm the published files were never given an explicit protected DACL
    // (inheritance remains enabled), matching a real npm cold install.
    for (const target of [entry, join(prefix, READY_MARKER)]) {
      const observed = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$s = [Security.AccessControl.FileSecurity]::new($env:REA_PLUGIN_CACHE_ACL_PATH, 'Access, Owner'); if ($s.AreAccessRulesProtected) { exit 2 }; exit 0`,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, REA_PLUGIN_CACHE_ACL_PATH: target },
        },
      );
      expect(observed.status, observed.stderr || observed.stdout).toBe(0);
    }
  },
);

it.skipIf(process.platform !== "win32")(
  "refuses a Windows warm cache whose entry grants a foreign SID write access",
  async () => {
    const version = "6.8.0-published-foreign-sid";
    const temp = await createLauncherTemp();
    const entry = await seedPublishedRuntime(
      version,
      `process.stdout.write("should-not-run");`,
      temp.temporaryRoot,
    );
    const user = process.env.USERNAME?.trim();
    expect(user).toBeTruthy();
    // Establish the same user+SYSTEM private DACL applyWindowsPrivateAcl uses,
    // then add LOCAL SERVICE (S-1-5-19) — a named foreign writer the old
    // Everyone/Users display-name check would still accept.
    for (const target of [
      cacheRootFor(temp.temporaryRoot),
      installPrefix(version, temp.temporaryRoot),
      entry,
      join(installPrefix(version, temp.temporaryRoot), READY_MARKER),
    ]) {
      const isFile = target === entry || target.endsWith(READY_MARKER);
      const grant = isFile
        ? [`${user}:F`, "SYSTEM:F"]
        : [`${user}:(OI)(CI)F`, "SYSTEM:(OI)(CI)F"];
      const applied = spawnSync(
        "icacls",
        [
          target,
          "/inheritance:r",
          "/grant:r",
          grant[0]!,
          "/grant:r",
          grant[1]!,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      expect(applied.status, applied.stderr || applied.stdout).toBe(0);
    }
    const foreign = spawnSync(
      "icacls",
      [entry, "/grant", "NT AUTHORITY\\LOCAL SERVICE:F"],
      { encoding: "utf8", windowsHide: true },
    );
    expect(foreign.status, foreign.stderr || foreign.stdout).toBe(0);
    // Pin a failing npm entry so a missed refusal cannot hit the registry.
    const bin = await createTestTempDirectory("rea-published-foreign-sid-bin-");
    const npmEntry = join(bin, "npm-cli.cjs");
    await writeFile(
      npmEntry,
      `#!/usr/bin/env node
process.stderr.write("controlled npm install failure\\n");
process.exit(1);
`,
    );
    const { child, closed } = start([version], {
      ...process.env,
      ...temp.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      npm_execpath: npmEntry,
    });
    child.stdin.end();
    const result = await closed;
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /refused an untrusted executable cache: executable cache entry is not private to this user/u,
    );
  },
);

it("refuses a symlinked cache root without changing the target mode", async () => {
  const version = "6.8.0-published-symlink-root";
  const workspace = await createTestTempDirectory(
    "rea-published-symlink-root-",
  );
  const target = join(workspace, "served");
  await mkdir(target, { mode: 0o755 });
  if (uid !== undefined) await chmod(target, 0o755);
  const temporaryRoot = join(workspace, "tmp");
  await mkdir(temporaryRoot, { mode: 0o700 });
  const linkedRoot = cacheRootFor(temporaryRoot);
  // Windows junctions need no symlink privilege; POSIX ignores the type.
  await symlink(
    target,
    linkedRoot,
    process.platform === "win32" ? "junction" : undefined,
  );
  onTestFinished(async () => {
    await rm(linkedRoot, { force: true });
    if (uid !== undefined) await chmod(target, 0o700).catch(() => undefined);
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
    LOCALAPPDATA: temporaryRoot,
  });
  child.stdin.end();
  const result = await closed;
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(
    /refused an untrusted executable cache: executable cache root must not be a symlink/u,
  );
  if (uid !== undefined) expect((await lstat(target)).mode & 0o777).toBe(0o755);
});

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
    LOCALAPPDATA: spacedTmp,
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
    // Release the fixture installer; start()'s teardown owns cancellation.
    await writeFile(releasePath, "go", { mode: 0o600 }).catch(() => undefined);
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

it("cancels a cold-start lock wait when MCP stdin exceeds the stdio buffer capacity", async () => {
  // Keep the launcher's bootstrap copy aligned with ownStdioStartupInput,
  // including coalesced 64 KiB retained blocks so one-byte data events cannot
  // exhaust the heap before the capacity guard fires.
  expect(STDIO_DEFAULT_MAX_BUFFER_SIZE).toBe(10 * 1024 * 1024);
  const launcherSource = await readFile(launcher, "utf8");
  expect(launcherSource).toMatch(
    /STDIO_DEFAULT_MAX_BUFFER_SIZE\s*=\s*10\s*\*\s*1024\s*\*\s*1024/u,
  );
  expect(launcherSource).toMatch(
    /Buffer\.allocUnsafe\(\s*Math\.min\(64\s*\*\s*1024,\s*STDIO_DEFAULT_MAX_BUFFER_SIZE\s*-\s*retainedBytes\)/u,
  );
  expect(launcherSource).toMatch(
    /if\s*\(\s*tail\s*!==\s*undefined\s*&&\s*tailBytes\s*>\s*0\s*\)\s*chunks\.push\(tail\.subarray\(0,\s*tailBytes\)\)/u,
  );
  const version = "6.8.0-published-stdin-capacity";
  const temp = await createLauncherTemp();
  const prefix = installPrefix(version, temp.temporaryRoot);
  const lockPath = lockPathFor(version, temp.temporaryRoot);
  await rm(prefix, { recursive: true, force: true });
  await rm(lockPath, { recursive: true, force: true });
  const workspace = await createTestTempDirectory(
    "rea-published-stdin-capacity-",
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
    // Release the fixture installer; start()'s teardown owns cancellation.
    await writeFile(releasePath, "go", { mode: 0o600 }).catch(() => undefined);
  });
  await waitForFile(startedPath);
  const waiter = start([version], launchEnv);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const oversized = Buffer.alloc(STDIO_DEFAULT_MAX_BUFFER_SIZE + 1, 0x61);
  for (let offset = 0; offset < oversized.byteLength;) {
    const chunk = oversized.subarray(offset, offset + 64 * 1024);
    offset += chunk.byteLength;
    const stdin = waiter.child.stdin;
    if (!stdin.write(chunk))
      await new Promise<void>((resolve) => stdin.once("drain", resolve));
  }
  if (waiter.child.pid !== undefined)
    await waitForProcessExit(waiter.child.pid, "capacity-limited waiter");
  const waiterResult = await waiter.closed;
  expect(waiterResult.code).toBe(1);
  expect(waiterResult.stdout).toBe("");
  expect(waiterResult.stderr).toContain(
    "MCP input exceeded the stdio buffer capacity before startup completed.",
  );
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
  // data listener (not pipe): pipe() resumes stdin and would mask a paused
  // handoff. Do not resume here — the launcher must resume once this
  // transport owns the stream, matching deferred serveStdio.
  \`process.stdout.write("stdin handoff runtime\\\\n");
process.stdin.on("data", (chunk) => {
  process.stdout.write(chunk);
});
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
  let stdout = "";
  child.stdout.on("data", (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  await waitForFile(startedPath);
  const handshake = '{"jsonrpc":"2.0","id":"handoff"}\n';
  const followUp = '{"jsonrpc":"2.0","id":"follow-up"}\n';
  // Fragmented writes exercise the coalescing tail flush on handoff; pipe
  // delivery may coalesce, but the retained partial block must still replay.
  for (const byte of Buffer.from(handshake)) {
    const stdin = child.stdin;
    if (!stdin.write(Buffer.from([byte])))
      await new Promise<void>((resolve) => stdin.once("drain", resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  await writeFile(releasePath, "go", { mode: 0o600 });
  // Runtime banner proves the entry started while stdin may still be paused.
  await expect
    .poll(() => stdout.includes("stdin handoff runtime\n"))
    .toBe(true);
  // Unshifted acquisition bytes must reach the data listener without pipe().
  await expect.poll(() => stdout.includes(handshake)).toBe(true);
  child.stdin.write(followUp);
  await expect.poll(() => stdout.includes(followUp)).toBe(true);
  child.stdin.end();
  const result = await closed;
  expect(result.code, result.stderr).toBe(0);
  expect(stdout).toBe(`stdin handoff runtime\n${handshake}${followUp}`);
});

it("owns Windows installer cancellation through taskkill process trees", async () => {
  const source = await readFile(launcher, "utf8");
  expect(source).toMatch(
    /windowsTaskkill\(\)[\s\S]*?\/PID[\s\S]*?\/T[\s\S]*?\/F/u,
  );
  expect(source).toMatch(/spawnSync\(windowsTaskkill\(\)/u);
});

it("resolves Windows helpers to absolute System32 paths with a neutral cwd", async () => {
  const source = await readFile(launcher, "utf8");
  // Bare-name CreateProcess would search the caller's CWD first; pin helpers
  // under %SystemRoot%\System32 (WindowsExecutable / WindowsBatchCommand policy)
  // and inherit the same neutral tmpdir cwd npm already receives.
  expect(source).toMatch(
    /process\.env\.SystemRoot\?\.trim\(\)\s*\|\|\s*process\.env\.windir\?\.trim\(\)\s*\|\|\s*"C:\\\\Windows"/u,
  );
  expect(source).toMatch(
    /win32\.join\(windowsSystemRoot\(\), "System32", \.\.\.segments\)/u,
  );
  expect(source).toMatch(
    /windowsSystem32Helper\("WindowsPowerShell", "v1\.0", "powershell\.exe"\)/u,
  );
  expect(source).toMatch(/windowsSystem32Helper\("icacls\.exe"\)/u);
  expect(source).toMatch(/windowsSystem32Helper\("taskkill\.exe"\)/u);
  expect(source).not.toMatch(
    /spawnSync\(\s*["'](?:powershell\.exe|icacls|taskkill)["']/u,
  );
  const helperSpawns = [
    source.match(
      /const establishWindowsPrivateOwner =[\s\S]*?\n\};\n\n\/\*\*/u,
    )?.[0],
    source.match(/const applyWindowsPrivateAcl =[\s\S]*?\n\};\n\n\/\*\*/u)?.[0],
    source.match(
      /const inspectWindowsPrivateAcl =[\s\S]*?\n\};\n\nconst verifyWindowsOwnedCachePath/u,
    )?.[0],
    source.match(/const signalInstaller =[\s\S]*?\n\};\n\n\/\*\*/u)?.[0],
  ];
  for (const fragment of helperSpawns) {
    expect(fragment).toBeDefined();
    expect(fragment).toMatch(/cwd:\s*tmpdir\(\)/u);
  }
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
    // Lease sockets use a length-checked owner-private root so long TMPDIR
    // lock directories still fit the host sun_path budget (Darwin 103 / Linux
    // 107). The same digest keys Windows pipe names so long TEMP prefixes
    // cannot collide.
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
    const leaseDirectoryName =
      uid === undefined ? "rea-mcp-l" : `rea-mcp-l-${uid}`;
    const preferredLeaseSocket = join(
      temp.temporaryRoot,
      leaseDirectoryName,
      `${lockKey}.sock`,
    );
    const leaseSocket =
      Buffer.byteLength(preferredLeaseSocket, "utf8") <=
      posixLeaseSocketPathLimit
        ? preferredLeaseSocket
        : join("/tmp", leaseDirectoryName, `${lockKey}.sock`);
    expect(join(lockPath, "lease.sock").length).toBeGreaterThan(
      posixLeaseSocketPathLimit,
    );
    expect(Buffer.byteLength(leaseSocket, "utf8")).toBeLessThanOrEqual(
      posixLeaseSocketPathLimit,
    );
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
      // Windows child.kill("SIGTERM") force-terminates Node and skips the
      // launcher’s taskkill handler (see mcpHttpShutdown). Cancel through the
      // supported stdin-EOF path instead; expect its zero status while the
      // launcher still owns installer-tree cleanup.
      child.stdin.end();
      const result = await closed;
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      await waitForProcessExit(npmPid, "npm installer");
      await waitForProcessExit(lifecyclePid, "npm lifecycle child");
      await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
