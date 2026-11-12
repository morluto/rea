import { spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
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
const READY_MARKER = ".rea-plugin-ready";

const cacheRootFor = (temporaryRoot = tmpdir()) =>
  join(
    temporaryRoot,
    uid === undefined ? "rea-plugin-mcp" : `rea-plugin-mcp-${uid}`,
  );

const installPrefix = (version: string, temporaryRoot = tmpdir()) =>
  join(cacheRootFor(temporaryRoot), version);

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
    await chmod(cacheRootFor(), 0o700).catch(() => undefined);
    await chmod(prefix, 0o700);
  }
  await writeFile(entry, runtime, { mode: 0o600 });
  await writeFile(join(prefix, READY_MARKER), version, { mode: 0o600 });
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

it.each([["latest"], ["6.8.0&echo wrong"], ["6.8.0", "extra"], []])(
  "rejects a non-exact or extra version argument: %j",
  async (...args) => {
    const { child, closed } = start(args);
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

it("does not import an install prefix that lacks the ready marker", async () => {
  const version = "6.8.0-published-incomplete";
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
    await chmod(cacheRootFor(), 0o700).catch(() => undefined);
    await chmod(prefix, 0o700);
  }
  await writeFile(entry, `process.stdout.write("should-not-run");`, {
    mode: 0o600,
  });
  onTestFinished(async () => {
    await rm(prefix, { recursive: true, force: true });
  });
  const missingBin = await createTestTempDirectory(
    "rea-published-incomplete-bin-",
  );
  const { child, closed } = start([version], {
    ...process.env,
    PATH: missingBin,
  });
  child.stdin.end();
  const result = await closed;
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("should-not-run");
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
  const reported = JSON.parse(result.stdout) as {
    cwd: string;
    argv: string[];
    prefix: string;
  };
  expect(reported.cwd).toBe(tmpdir());
  expect(reported.argv).toEqual(["mcp"]);
  expect(basename(reported.prefix)).toMatch(
    new RegExp(`^${version}\\.staging-\\d+$`, "u"),
  );
  expect(dirname(reported.prefix)).toBe(cacheRootFor());
  expect(result.stderr).toContain("added 1 package in 12ms");
  await access(entry);
  await access(join(prefix, READY_MARKER));
  expect(await readFile(join(prefix, READY_MARKER), "utf8")).toBe(version);
  if (uid !== undefined) {
    const root = cacheRootFor();
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(prefix)).mode & 0o777).toBe(0o700);
  }
});

it("coordinates concurrent cold starts through one installer publication", async () => {
  const version = "6.8.0-published-concurrent";
  const prefix = installPrefix(version);
  await rm(prefix, { recursive: true, force: true });
  await rm(join(cacheRootFor(), `${version}.lock`), {
    recursive: true,
    force: true,
  });
  onTestFinished(async () => {
    await rm(prefix, { recursive: true, force: true });
    await rm(join(cacheRootFor(), `${version}.lock`), {
      recursive: true,
      force: true,
    });
  });
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
  "process.stdout.write(JSON.stringify({ installs: " + count + " }));",
  { mode: 0o600 },
);
`,
  );
  const first = start([version], {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  });
  const stagingPrefix = (await waitForFile(startedPath)).trim();
  expect(basename(stagingPrefix)).toMatch(
    new RegExp(`^${version}\\.staging-\\d+$`, "u"),
  );
  const second = start([version], {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(second.child.exitCode).toBeNull();
  expect(await readFile(counterPath, "utf8")).toBe("1");
  await writeFile(releasePath, "go", { mode: 0o600 });
  first.child.stdin.end();
  second.child.stdin.end();
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
  const prefix = installPrefix(version);
  const lockPath = join(cacheRootFor(), `${version}.lock`);
  const recoveryPath = `${lockPath}.recovery`;
  await rm(prefix, { recursive: true, force: true });
  await rm(lockPath, { recursive: true, force: true });
  await rm(recoveryPath, { recursive: true, force: true });
  await mkdir(cacheRootFor(), { recursive: true, mode: 0o700 });
  if (uid !== undefined)
    await chmod(cacheRootFor(), 0o700).catch(() => undefined);
  await mkdir(lockPath, { mode: 0o700 });
  if (uid !== undefined) await chmod(lockPath, 0o700);
  await writeFile(join(lockPath, "pid"), "2147483647\n", { mode: 0o600 });
  await mkdir(recoveryPath, { mode: 0o700 });
  onTestFinished(async () => {
    await rm(prefix, { recursive: true, force: true });
    await rm(lockPath, { recursive: true, force: true });
    await rm(recoveryPath, { recursive: true, force: true });
  });
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
writeFileSync(entry, "process.exitCode = 0;", { mode: 0o600 });
`,
  );
  const stale = await lstat(lockPath);
  const { child, closed } = start([version], {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(child.exitCode).toBeNull();
  expect(await readFile(counterPath, "utf8")).toBe("0");
  expect((await lstat(lockPath)).ino).toBe(stale.ino);
  expect(await readFile(join(lockPath, "pid"), "utf8")).toBe("2147483647\n");
  await rm(recoveryPath, { recursive: true, force: true });
  child.stdin.end();
  const result = await closed;
  expect(result.code).toBe(0);
  expect(await readFile(counterPath, "utf8")).toBe("1");
  await access(join(prefix, READY_MARKER));
});

it("serializes stale install-lock recovery so concurrent recoverers share one publication", async () => {
  const version = "6.8.0-published-stale-recovery";
  const prefix = installPrefix(version);
  const lockPath = join(cacheRootFor(), `${version}.lock`);
  const recoveryPath = `${lockPath}.recovery`;
  await rm(prefix, { recursive: true, force: true });
  await rm(lockPath, { recursive: true, force: true });
  await rm(recoveryPath, { recursive: true, force: true });
  await mkdir(cacheRootFor(), { recursive: true, mode: 0o700 });
  if (uid !== undefined)
    await chmod(cacheRootFor(), 0o700).catch(() => undefined);
  await mkdir(lockPath, { mode: 0o700 });
  if (uid !== undefined) await chmod(lockPath, 0o700);
  await writeFile(join(lockPath, "pid"), "2147483647\n", { mode: 0o600 });
  onTestFinished(async () => {
    await rm(prefix, { recursive: true, force: true });
    await rm(lockPath, { recursive: true, force: true });
    await rm(recoveryPath, { recursive: true, force: true });
  });
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
  ].join("\\n"),
  { mode: 0o600 },
);
`,
  );
  const first = start([version], {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  });
  const second = start([version], {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    npm_execpath: npmEntry,
  });
  // Keep the published runtime alive while both clients import it: a second
  // recoverer that deleted this lock would republish and remove the prefix.
  const sawImport = Promise.all([
    new Promise<void>((resolve, reject) => {
      first.child.stdout.once("data", () => resolve());
      first.child.once("exit", (code) =>
        reject(new Error(`first exited before import: ${String(code)}`)),
      );
    }),
    new Promise<void>((resolve, reject) => {
      second.child.stdout.once("data", () => resolve());
      second.child.once("exit", (code) =>
        reject(new Error(`second exited before import: ${String(code)}`)),
      );
    }),
  ]);
  const stagingPrefix = (await waitForFile(startedPath)).trim();
  expect(basename(stagingPrefix)).toMatch(
    new RegExp(`^${version}\\.staging-\\d+$`, "u"),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(first.child.exitCode).toBeNull();
  expect(second.child.exitCode).toBeNull();
  expect(await readFile(counterPath, "utf8")).toBe("1");
  first.child.stdin.end();
  second.child.stdin.end();
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
  const version = "6.8.0-published-space-prefix";
  const spacedParent = await createTestTempDirectory(
    "rea-published-space-tmp-",
  );
  const spacedTmp = join(spacedParent, "user temp dir");
  await mkdir(spacedTmp, { recursive: true, mode: 0o700 });
  const spacedRoot = cacheRootFor(spacedTmp);
  const spacedPrefix = installPrefix(version, spacedTmp);
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
  const prefixArg = reported.argv[reported.argv.indexOf("--prefix") + 1];
  expect(prefixArg).toEqual(
    expect.stringMatching(new RegExp(`${version}\\.staging-\\d+$`, "u")),
  );
  expect(dirname(prefixArg ?? "")).toBe(spacedRoot);
  await access(join(spacedPrefix, READY_MARKER));
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
      signal: null,
      stdout: "ready",
      stderr: "cleaned",
    });
  },
);

it.skipIf(process.platform === "win32")(
  "terminates an in-flight npm install on SIGTERM and awaits its exit",
  async () => {
    const version = "6.8.0-published-install-sigterm";
    const prefix = installPrefix(version);
    await rm(prefix, { recursive: true, force: true });
    onTestFinished(async () => {
      await rm(prefix, { recursive: true, force: true });
      await rm(join(cacheRootFor(), `${version}.lock`), {
        recursive: true,
        force: true,
      });
    });
    const workspace = await createTestTempDirectory(
      "rea-published-install-sigterm-",
    );
    const bin = join(workspace, "bin");
    await mkdir(bin);
    const npmEntry = join(bin, "npm-cli.cjs");
    const pidPath = join(workspace, "npm.pid");
    await writeFile(
      npmEntry,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`,
    );
    const { child, closed } = start([version], {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      npm_execpath: npmEntry,
    });
    const npmPid = Number.parseInt((await waitForFile(pidPath)).trim(), 10);
    expect(npmPid).toBeGreaterThan(0);
    child.kill("SIGTERM");
    const result = await closed;
    expect(result.code).toBe(143);
    expect(result.stdout).toBe("");
    await expect(
      (async () => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            process.kill(npmPid, 0);
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
        throw new Error(`npm installer ${String(npmPid)} remained running`);
      })(),
    ).resolves.toBeUndefined();
  },
);
