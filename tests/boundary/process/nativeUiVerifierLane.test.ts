import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { systemProcessOwnershipHost } from "../../../src/process/ProcessOwnershipObservation.js";
import { liveProcesses } from "../../../src/process/ProcessOwnershipProcessTree.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// Stands in for /usr/bin/open: starts a detached app that inherits its environment.
// Each stand-in records itself and leaves when the test releases it, or expires.
const standInPrelude = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const record = (kind) => appendFileSync(config.events, JSON.stringify({ kind, pid: process.pid }) + "\\n");
setInterval(() => {
  if (existsSync(config.release)) process.exit(0);
}, 10);
setTimeout(() => process.exit(0), 60000);
`;

const launcherSource = `
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
${standInPrelude}
record("launcher");
const args = process.argv.slice(2);
const coordinates = args[args.indexOf("--stdout") + 1];
spawn(process.execPath, [new URL("./fixture.mjs", import.meta.url).pathname], {
  detached: true,
  stdio: ["ignore", openSync(coordinates, "a"), "ignore"],
}).unref();
`;

const fixtureSource = `
import { writeSync } from "node:fs";
${standInPrelude}
record("fixture");
writeSync(1, JSON.stringify({ pid: process.pid, window_id: 7 }) + "\\n");
`;

// Runs the actual verifier and observation mapping. Only the compiler and launcher
// are replaced: the compiled helper is an authored script answering as the real
// helper does, so this covers the lane's assertions and not native capture.
const preloadSource = `
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { promisify } from "node:util";
const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const childProcess = createRequire(import.meta.url)("node:child_process");
const { execFile, spawn } = childProcess;
const script = (path, body) => {
  writeFileSync(path, "#!/bin/sh\\n" + body + "\\n");
  chmodSync(path, 0o755);
};
const compile = (args) => {
  const output = args[args.indexOf("-o") + 1];
  if (basename(output) === "fixture") copyFileSync("/usr/bin/true", output);
  else if (basename(output) === "child-retrieval-test")
    script(output, "printf '%s\\\\n' '{\\"a\\":\\"b\\"}' '{\\"n\\":1.0}'");
  else script(output, config.helper);
};
const compiled = (file, args) => file === "/usr/bin/xcrun" && args.includes("-o");
childProcess.execFile = (file, args, ...rest) => {
  if (!compiled(file, args)) return execFile(file, args, ...rest);
  compile(args);
  const done = rest.at(-1);
  queueMicrotask(() => done(null, "", ""));
  return spawn("/usr/bin/true", [], { stdio: "ignore" });
};
childProcess.execFile[promisify.custom] = (file, args, ...rest) => {
  if (!compiled(file, args)) return execFile[promisify.custom](file, args, ...rest);
  compile(args);
  return Promise.resolve({ stdout: "", stderr: "" });
};
childProcess.spawn = (file, args, options) => {
  if (compiled(file, args)) {
    compile(args);
    return spawn("/usr/bin/true", [], options);
  }
  return file === "/usr/bin/open"
    ? spawn(process.execPath, [config.launcherEntry, ...args], options)
    : spawn(file, args, options);
};
syncBuiltinESMExports();
`;

const denied = `printf '%s' '{"ok":false,"code":"screen-recording-denied","message":"authored permission denial"}'`;
const answersChangedBytes = `case "$1" in *'"sha256":"0000000000'*) printf '%s' '{"ok":false,"code":"target-mismatch","message":"authored digest refusal"}'; exit 0;; esac; ${denied}`;

const standInSchema = z.object({
  kind: z.enum(["launcher", "fixture"]),
  pid: z.number().int().positive(),
});

const runVerifier = async (helper: string, flags: readonly string[]) => {
  const workspace = await createTestTempDirectory("rea-native-ui-lane-");
  const paths = {
    events: join(workspace, "events.jsonl"),
    release: join(workspace, "release"),
    launcherEntry: join(workspace, "launcher.mjs"),
  };
  await writeFile(paths.events, "");
  await writeFile(paths.launcherEntry, launcherSource);
  await writeFile(join(workspace, "fixture.mjs"), fixtureSource);
  await writeFile(join(workspace, "preload.mjs"), preloadSource);
  await writeFile(
    join(workspace, "config.json"),
    JSON.stringify({ ...paths, helper }),
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(join(workspace, "preload.mjs")).href,
      resolve("scripts/verify-native-ui.mjs"),
      ...flags,
    ],
    {
      env: { ...process.env, TMPDIR: workspace },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const standIns = async () =>
    (await readFile(paths.events, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => standInSchema.parse(JSON.parse(line)));
  const isLive = async (pid: number) =>
    liveProcesses(await systemProcessOwnershipHost.listProcesses()).some(
      (process) => process.pid === pid,
    );
  const untilGone = async (pid: number) => {
    const deadline = performance.now() + 15_000;
    while ((await isLive(pid)) && performance.now() < deadline) await delay(25);
    return !(await isLive(pid));
  };
  // Runs on a timeout or failed assertion too: the verifier cannot release a stand-in
  // once killed, and its fixture would otherwise outlive the test until it expired.
  onTestFinished(async () => {
    child.kill("SIGKILL");
    await writeFile(paths.release, "");
    for (const { pid } of await standIns())
      expect(await untilGone(pid)).toBe(true);
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((settle) => {
    child.once("close", settle);
  });
  const fixture = (await standIns()).find(({ kind }) => kind === "fixture");
  expect(fixture, stderr).toBeDefined();
  return {
    code,
    stdout,
    stderr,
    fixtureLive: !(await untilGone(fixture?.pid ?? -1)),
    roots: (await readdir(workspace)).filter((name) =>
      name.startsWith("rea-ui-fixture-"),
    ),
  };
};

// The verifier refuses other hosts before any fixture is created.
const macosIt = it.skipIf(process.platform !== "darwin");

macosIt(
  "completes at the permission boundary when the helper refuses changed target bytes",
  { timeout: 30_000 },
  async () => {
    const result = await runVerifier(answersChangedBytes, [
      "--allow-permission-denial",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      verification_status: "permission-boundary-only",
      positive_e2e: false,
      mismatch_rejected: true,
    });
    expect(result.fixtureLive).toBe(false);
    expect(result.roots).toEqual([]);
  },
);

macosIt(
  "fails when the helper does not refuse changed target bytes",
  { timeout: 30_000 },
  async () => {
    const result = await runVerifier(denied, ["--allow-permission-denial"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Real helper did not reject changed target bytes",
    );
    expect(result.stdout).toBe("");
    expect(result.fixtureLive).toBe(false);
    expect(result.roots).toEqual([]);
  },
);

macosIt(
  "keeps a permission denial a failure in the positive lane",
  { timeout: 30_000 },
  async () => {
    const result = await runVerifier(answersChangedBytes, []);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("requires successful capture");
    expect(result.stdout).toBe("");
    expect(result.fixtureLive).toBe(false);
    expect(result.roots).toEqual([]);
  },
);
