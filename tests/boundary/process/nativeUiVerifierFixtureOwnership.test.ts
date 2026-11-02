import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import {
  createNativeUiFixtureOwner,
  NativeUiFixtureCleanupFailure,
  type NativeUiFixtureOwner,
} from "../../../scripts/lib/native-ui-fixture-lifecycle.mjs";
import { systemProcessOwnershipHost } from "../../../src/process/ProcessOwnershipObservation.js";
import { liveProcesses } from "../../../src/process/ProcessOwnershipProcessTree.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

// The launcher and fixture are authored stand-ins for /usr/bin/open and the
// Swift fixture app. The owner, process spawn, token sweep, signals and root
// removal are real. Nothing here establishes LaunchServices behavior; that
// is verified by running the real lane on an interactive macOS session.
const launcherSource = `
import { spawn } from "node:child_process";
import { appendFileSync, openSync, readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
appendFileSync(config.events, JSON.stringify({ kind: "launcher", pid: process.pid, args }) + "\\n");
setTimeout(() => process.exit(0), 25000);
if (config.launcher === "fails") {
  process.stderr.write("authored launch refusal\\n");
  process.exit(3);
}
if (config.launcher === "ignores-term") process.on("SIGTERM", () => undefined);
// The launched app starts outside this process tree and inherits this environment.
const environment = { ...process.env };
// A launch service holds no run token; only the app it starts receives one.
const inFlight = config.launcher === "in-flight";
if (inFlight) delete environment.REA_PROCESS_RUN_ID;
const entry = new URL(inFlight ? "./launch-service.mjs" : "./fixture.mjs", import.meta.url).pathname;
const coordinates = args[args.indexOf("--stdout") + 1];
spawn(process.execPath, [entry, args.at(-1), coordinates], {
  detached: true,
  stdio: ["ignore", openSync(coordinates, "a"), "ignore"],
  env: environment,
}).unref();
if (config.launcher === "exits") process.exit(0);
`;

// Stands in for the launch service that keeps working after the launcher dies.
const launchServiceSource = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const [application, coordinates] = process.argv.slice(2);
appendFileSync(config.events, JSON.stringify({ kind: "launch-service", pid: process.pid }) + "\\n");
setTimeout(() => process.exit(0), 25000);
setInterval(() => {
  if (existsSync(application)) return;
  appendFileSync(config.events, JSON.stringify({ kind: "launch-refused", rootPresent: existsSync(coordinates) }) + "\\n");
  process.exit(0);
}, 2);
`;

const fixtureSource = `
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const coordinates = process.argv[3];
const record = (event) => appendFileSync(config.events, JSON.stringify(event) + "\\n");
const ready = (pid = process.pid) => writeSync(1, JSON.stringify({ pid, window_id: 7 }) + "\\n");
let member;
if (config.untokenedMember) {
  const environment = { ...process.env };
  delete environment.REA_PROCESS_RUN_ID;
  // Same process group as this fixture, without proof of this run.
  member = spawn(process.execPath, [
    "-e",
    "const { existsSync } = require('node:fs'); setInterval(() => { if (existsSync(process.argv[1])) process.exit(0); }, 10); setTimeout(() => process.exit(0), 25000);",
    config.memberRelease,
  ], { stdio: "ignore", env: environment }).pid;
}
record({ kind: "fixture", pid: process.pid, parentPid: process.ppid, runId: process.env.REA_PROCESS_RUN_ID, member });
if (config.ready === "immediate") ready();
if (config.ready === "foreign") ready(config.foreignPid);
if (config.ready === "malformed") writeSync(1, "not a record\\n");
if (config.ready === "incomplete") writeSync(1, JSON.stringify({ pid: String(process.pid) }) + "\\n");
let answered = false;
let outlived = false;
setInterval(() => {
  if (existsSync(config.release)) process.exit(0);
  if (!outlived && !existsSync(coordinates)) {
    outlived = true;
    record({ kind: "outlived-root", pid: process.pid });
  }
  if (config.ready === "gated" && !answered && existsSync(config.readyGate)) {
    answered = true;
    ready();
  }
}, 5);
setTimeout(() => process.exit(0), 25000);
`;

// Injects the compiler, launcher and, once the fixture runs, a clock jump into
// the actual verifier. A one-time offset leaves later cleanup budgets unchanged.
const preloadSource = `
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const childProcess = createRequire(import.meta.url)("node:child_process");
const { execFile, spawn } = childProcess;
const compile = (args) => {
  const output = args[args.indexOf("-o") + 1];
  writeFileSync(output, "#!/bin/sh\\nprintf '%s\\\\n' '{\\"a\\":\\"b\\"}' '{\\"n\\":1.0}'\\n");
  chmodSync(output, 0o755);
};
const patchedExecFile = (file, args, ...rest) => {
  if (file !== "/usr/bin/xcrun") return execFile(file, args, ...rest);
  compile(args);
  rest.at(-1)(null, "", "");
};
patchedExecFile[promisify.custom] = (file, args, ...rest) => {
  if (file !== "/usr/bin/xcrun") return execFile[promisify.custom](file, args, ...rest);
  compile(args);
  return Promise.resolve({ stdout: "", stderr: "" });
};
childProcess.execFile = patchedExecFile;
childProcess.spawn = (file, args, options) =>
  file === "/usr/bin/open"
    ? spawn(process.execPath, [config.launcherEntry, ...args], options)
    : spawn(file, args, options);
syncBuiltinESMExports();
if (config.clockJump) {
  let jumped = false;
  const offset = () => {
    jumped ||= readFileSync(config.events, "utf8").includes('"kind":"fixture"');
    return jumped ? 60000 : 0;
  };
  const now = Date.now.bind(Date);
  Date.now = () => now() + offset();
  const monotonic = performance.now.bind(performance);
  performance.now = () => monotonic() + offset();
}
`;

const eventSchema = z.looseObject({ kind: z.string() });
const fixtureEventSchema = z.object({
  kind: z.literal("fixture"),
  pid: z.number().int().positive(),
  parentPid: z.number().int().positive(),
  runId: z.string().min(1),
  member: z.number().int().positive().optional(),
});

interface ScenarioConfig {
  readonly launcher?:
    | "waits"
    | "exits"
    | "fails"
    | "ignores-term"
    | "in-flight";
  readonly ready?:
    | "never"
    | "immediate"
    | "gated"
    | "foreign"
    | "malformed"
    | "incomplete";
  readonly untokenedMember?: boolean;
  readonly foreignPid?: number;
  readonly clockJump?: boolean;
}

const isLive = async (pid: number): Promise<boolean> =>
  liveProcesses(await systemProcessOwnershipHost.listProcesses()).some(
    (process) => process.pid === pid,
  );

const waitUntil = async (
  condition: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> => {
  const deadline = performance.now() + 15_000;
  while (!(await condition())) {
    if (performance.now() >= deadline)
      throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
};

const createScenario = async (config: ScenarioConfig = {}) => {
  const workspace = await createTestTempDirectory("rea-native-ui-owner-");
  const paths = {
    events: join(workspace, "events.jsonl"),
    release: join(workspace, "release"),
    memberRelease: join(workspace, "member-release"),
    readyGate: join(workspace, "ready-gate"),
    launcherEntry: join(workspace, "launcher.mjs"),
  };
  await writeFile(paths.events, "");
  await writeFile(
    paths.launcherEntry,
    `#!${process.execPath}\n${launcherSource}`,
  );
  await chmod(paths.launcherEntry, 0o755);
  await writeFile(join(workspace, "fixture.mjs"), fixtureSource);
  await writeFile(join(workspace, "launch-service.mjs"), launchServiceSource);
  await writeFile(join(workspace, "preload.mjs"), preloadSource);
  await writeFile(
    join(workspace, "config.json"),
    JSON.stringify({ launcher: "waits", ready: "never", ...config, ...paths }),
  );
  const events = async () =>
    (await readFile(paths.events, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => eventSchema.parse(JSON.parse(line)));
  const started = async () => {
    await waitUntil(
      async () => (await events()).some(({ kind }) => kind === "fixture"),
      "the fixture to start",
    );
    return fixtureEventSchema.parse(
      (await events()).find(({ kind }) => kind === "fixture"),
    );
  };
  // A failed regression must not leave its authored processes behind.
  onTestFinished(async () => {
    await writeFile(paths.release, "");
    await writeFile(paths.memberRelease, "");
    for (const event of await events()) {
      const parsed = fixtureEventSchema.safeParse(event);
      if (!parsed.success) continue;
      await waitUntil(
        async () => !(await isLive(parsed.data.pid)),
        "the authored fixture to consume its release",
      );
    }
  });
  return { workspace, paths, events, started };
};

const launchedOwner = async (
  scenario: Awaited<ReturnType<typeof createScenario>>,
  readyTimeoutMs: number,
) => {
  const owner = await createNativeUiFixtureOwner({
    launcherCommand: scenario.paths.launcherEntry,
    readyTimeoutMs,
  });
  onTestFinished(async () => {
    await owner.close().catch(() => undefined);
  });
  const application = join(owner.root, "Fixture.app");
  await mkdir(application);
  return { owner, launch: owner.launch(application) };
};

const expectReleased = async (
  owner: NativeUiFixtureOwner,
  scenario: Awaited<ReturnType<typeof createScenario>>,
  pid: number,
) => {
  await owner.close();
  expect(await isLive(pid)).toBe(false);
  expect(existsSync(owner.root)).toBe(false);
  expect(
    (await scenario.events()).filter(({ kind }) => kind === "outlived-root"),
  ).toEqual([]);
};

const posixIt = it.skipIf(process.platform === "win32");

posixIt(
  "launches with the run token in the environment and binds the ready PID to it",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({ ready: "immediate" });
    const { owner, launch } = await launchedOwner(scenario, 15_000);
    const scope = await launch;
    const fixture = await scenario.started();
    expect(scope).toEqual({ pid: fixture.pid, window_id: 7 });
    const launcher = (await scenario.events()).find(
      ({ kind }) => kind === "launcher",
    );
    // The run token stays out of argv: another run's sweep cannot prove an argv
    // entry with its prefix and would fail closed while this launcher is alive.
    expect(launcher?.args).toEqual([
      "-W",
      "-n",
      "-g",
      "--stdout",
      join(owner.root, "scope.json"),
      join(owner.root, "Fixture.app"),
    ]);
    await expectReleased(owner, scenario, fixture.pid);
    // A released owner stays released and cannot launch a second fixture.
    await owner.close();
    await expect(owner.launch(join(owner.root, "again"))).rejects.toThrow(
      "launches one fixture",
    );
    expect(existsSync(owner.root)).toBe(false);
  },
);

posixIt(
  "stops a separately launched fixture that never hands off, before removing its root",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario();
    const { owner, launch } = await launchedOwner(scenario, 300);
    await expect(launch).rejects.toThrow("failed to expose one window");
    const fixture = await scenario.started();
    expect(await isLive(fixture.pid)).toBe(true);
    await expectReleased(owner, scenario, fixture.pid);
  },
);

posixIt(
  "accepts a handshake that is late but inside its budget",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({ ready: "gated" });
    const { owner, launch } = await launchedOwner(scenario, 15_000);
    const fixture = await scenario.started();
    await delay(150);
    await writeFile(scenario.paths.readyGate, "");
    await expect(launch).resolves.toEqual({ pid: fixture.pid, window_id: 7 });
    await expectReleased(owner, scenario, fixture.pid);
  },
);

posixIt(
  "still stops a fixture whose handshake arrives after the deadline",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({ ready: "gated" });
    const { owner, launch } = await launchedOwner(scenario, 300);
    await expect(launch).rejects.toThrow("failed to expose one window");
    const fixture = await scenario.started();
    await writeFile(scenario.paths.readyGate, "");
    await waitUntil(
      async () =>
        (await readFile(join(owner.root, "scope.json"), "utf8")).includes("\n"),
      "the late record",
    );
    await expectReleased(owner, scenario, fixture.pid);
  },
);

posixIt(
  "ends a launch still in flight when its launcher is stopped, before removing the root",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({ launcher: "in-flight" });
    const { owner, launch } = await launchedOwner(scenario, 300);
    await expect(launch).rejects.toThrow("failed to expose one window");
    await waitUntil(
      async () =>
        (await scenario.events()).some(({ kind }) => kind === "launch-service"),
      "the launch to be admitted",
    );
    await owner.close();
    await waitUntil(
      async () =>
        (await scenario.events()).some(({ kind }) => kind === "launch-refused"),
      "the in-flight launch to lose its application",
    );
    // The application path was gone while the root still existed.
    expect(
      (await scenario.events()).find(({ kind }) => kind === "launch-refused"),
    ).toMatchObject({ rootPresent: true });
    expect(existsSync(owner.root)).toBe(false);
  },
);

posixIt(
  "fails at once when the launcher refuses, with its reason",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({ launcher: "fails" });
    const started = performance.now();
    const { owner, launch } = await launchedOwner(scenario, 15_000);
    await expect(launch).rejects.toThrow(
      /launcher exited \(code 3, signal null\).*authored launch refusal/u,
    );
    expect(performance.now() - started).toBeLessThan(10_000);
    await owner.close();
    expect(existsSync(owner.root)).toBe(false);
  },
);

posixIt(
  "still stops a fixture whose launcher exited without a handshake",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({ launcher: "exits" });
    const { owner, launch } = await launchedOwner(scenario, 15_000);
    await expect(launch).rejects.toThrow("launcher exited (code 0");
    const fixture = await scenario.started();
    await expectReleased(owner, scenario, fixture.pid);
  },
);

posixIt(
  "removes only the root when the launcher could not be started",
  { timeout: 30_000 },
  async () => {
    const owner = await createNativeUiFixtureOwner({
      launcherCommand: "/nonexistent/rea-open",
    });
    await expect(owner.launch(join(owner.root, "Fixture.app"))).rejects.toThrow(
      "ENOENT",
    );
    await owner.close();
    expect(existsSync(owner.root)).toBe(false);
  },
);

// On macOS this launcher is a platform binary like /usr/bin/open: its token is
// withheld, so only its retained handle can stop it before the sweep.
posixIt(
  "stops a launcher whose token cannot be read before sweeping",
  { timeout: 30_000 },
  async () => {
    const workspace = await createTestTempDirectory("rea-native-ui-owner-");
    const launcherCommand = join(workspace, "withheld-launcher.sh");
    await writeFile(launcherCommand, "#!/bin/sh\nexec /bin/sleep 25\n");
    await chmod(launcherCommand, 0o755);
    const owner = await createNativeUiFixtureOwner({
      launcherCommand,
      readyTimeoutMs: 300,
    });
    onTestFinished(async () => {
      await owner.close().catch(() => undefined);
    });
    const application = join(owner.root, "Fixture.app");
    await mkdir(application);
    await expect(owner.launch(application)).rejects.toThrow(
      "failed to expose one window",
    );
    await owner.close();
    expect(existsSync(owner.root)).toBe(false);
  },
);

posixIt(
  "refuses a launch that follows close",
  { timeout: 30_000 },
  async () => {
    const owner = await createNativeUiFixtureOwner();
    await owner.close();
    await expect(owner.launch(join(owner.root, "Fixture.app"))).rejects.toThrow(
      "Native UI fixture owner closed",
    );
    expect(existsSync(owner.root)).toBe(false);
  },
);

posixIt(
  "escalates against a launcher that ignores termination",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({ launcher: "ignores-term" });
    const { owner, launch } = await launchedOwner(scenario, 300);
    await expect(launch).rejects.toThrow("failed to expose one window");
    const fixture = await scenario.started();
    const launcher = z
      .object({ pid: z.number() })
      .parse((await scenario.events()).find(({ kind }) => kind === "launcher"));
    await expectReleased(owner, scenario, fixture.pid);
    expect(await isLive(launcher.pid)).toBe(false);
  },
);

for (const [ready, message] of [
  ["malformed", "malformed ready record"],
  ["incomplete", "lacks a selected PID and window"],
] as const)
  posixIt(
    `stops the launched fixture when its ready record is ${ready}`,
    { timeout: 30_000 },
    async () => {
      const scenario = await createScenario({ ready });
      const { owner, launch } = await launchedOwner(scenario, 15_000);
      await expect(launch).rejects.toThrow(message);
      const fixture = await scenario.started();
      await expectReleased(owner, scenario, fixture.pid);
    },
  );

processTest.skipIf(process.platform === "win32")(
  "gives a ready record naming a foreign PID no authority over that process",
  { timeout: 30_000 },
  async ({ processes }) => {
    const environment = { ...process.env };
    delete environment.REA_PROCESS_RUN_ID;
    const foreign = processes.spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { env: environment },
    );
    const scenario = await createScenario({
      ready: "foreign",
      ...(foreign.pid === undefined ? {} : { foreignPid: foreign.pid }),
    });
    const { owner, launch } = await launchedOwner(scenario, 15_000);
    await expect(launch).rejects.toThrow("does not prove this run");
    const fixture = await scenario.started();
    await expectReleased(owner, scenario, fixture.pid);
    expect(foreign.exitCode).toBeNull();
    expect(foreign.signalCode).toBeNull();
  },
);

posixIt(
  "retains the root and run when cleanup refuses, then releases them on retry",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({ untokenedMember: true });
    const { owner, launch } = await launchedOwner(scenario, 300);
    await expect(launch).rejects.toThrow("failed to expose one window");
    const fixture = await scenario.started();
    const refusal = await owner.close().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(refusal).toBeInstanceOf(NativeUiFixtureCleanupFailure);
    const failure = refusal as NativeUiFixtureCleanupFailure;
    expect(failure.cleanupOwner).toBe(owner);
    expect(failure.root).toBe(owner.root);
    expect(failure.runId).toBe(fixture.runId);
    expect(failure.message).toContain(owner.root);
    // A group with an unproven member is not signaled, and its root survives.
    expect(await isLive(fixture.pid)).toBe(true);
    expect(fixture.member).toBeDefined();
    expect(await isLive(fixture.member ?? -1)).toBe(true);
    expect(existsSync(owner.root)).toBe(true);

    await writeFile(scenario.paths.memberRelease, "");
    await waitUntil(
      async () => !(await isLive(fixture.member ?? -1)),
      "the unproven member to exit",
    );
    await expectReleased(owner, scenario, fixture.pid);
  },
);

posixIt(
  "joins one release attempt across concurrent closes",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({ ready: "immediate" });
    const { owner, launch } = await launchedOwner(scenario, 15_000);
    await launch;
    const fixture = await scenario.started();
    await Promise.all([owner.close(), owner.close()]);
    expect(await isLive(fixture.pid)).toBe(false);
    expect(existsSync(owner.root)).toBe(false);
  },
);

posixIt(
  "keeps ownership through a close that races an admitted launch",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario();
    const { owner, launch } = await launchedOwner(scenario, 15_000);
    const fixture = await scenario.started();
    await owner.close();
    await expect(launch).rejects.toThrow("Native UI fixture owner closed");
    expect(await isLive(fixture.pid)).toBe(false);
    expect(existsSync(owner.root)).toBe(false);
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "retains the root after a removal denial and removes it on retry",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({ ready: "immediate" });
    const { owner, launch } = await launchedOwner(scenario, 15_000);
    await launch;
    const fixture = await scenario.started();
    // A read-only directory is an actual removal denial.
    const denied = join(owner.root, "denied");
    await mkdir(denied);
    await writeFile(join(denied, "held"), "");
    await chmod(denied, 0o500);
    onTestFinished(async () => {
      await chmod(denied, 0o700).catch(() => undefined);
    });
    await expect(owner.close()).rejects.toBeInstanceOf(
      NativeUiFixtureCleanupFailure,
    );
    expect(await isLive(fixture.pid)).toBe(false);
    expect(existsSync(owner.root)).toBe(true);
    await chmod(denied, 0o700);
    await owner.close();
    expect(existsSync(owner.root)).toBe(false);
  },
);

// The verifier refuses other hosts before any fixture is created. These drive
// the actual entrypoint; its compiler and launcher are injected, so they cover
// the entrypoint's ownership wiring and not native capture.
const macosIt = it.skipIf(process.platform !== "darwin");

const runVerifier = async (
  scenario: Awaited<ReturnType<typeof createScenario>>,
) => {
  const temporary = join(scenario.workspace, "tmp");
  await mkdir(temporary);
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(join(scenario.workspace, "preload.mjs")).href,
      resolve("scripts/verify-native-ui.mjs"),
    ],
    {
      env: { ...process.env, TMPDIR: temporary },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout.resume();
  const exit = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    child.once("exit", (code, signal) => {
      resolveExit({ code, signal });
    });
  });
  const roots = async () =>
    (await readdir(temporary)).filter((name) =>
      name.startsWith("rea-ui-fixture-"),
    );
  return { child, exit, roots, stderr: () => stderr };
};

macosIt(
  "the verifier leaves no fixture or root after a missing handshake",
  { timeout: 40_000 },
  async () => {
    const scenario = await createScenario({ clockJump: true });
    const verifier = await runVerifier(scenario);
    expect((await verifier.exit).code, verifier.stderr()).toBe(1);
    expect(verifier.stderr()).toContain("failed to expose one window");
    const fixture = await scenario.started();
    expect(await isLive(fixture.pid)).toBe(false);
    expect(await verifier.roots()).toEqual([]);
    expect(
      (await scenario.events()).filter(({ kind }) => kind === "outlived-root"),
    ).toEqual([]);
  },
);

macosIt(
  "the verifier reports both failures and keeps the root when cleanup refuses",
  { timeout: 40_000 },
  async () => {
    const scenario = await createScenario({
      clockJump: true,
      untokenedMember: true,
    });
    const verifier = await runVerifier(scenario);
    expect((await verifier.exit).code, verifier.stderr()).toBe(1);
    expect(verifier.stderr()).toContain("failed to expose one window");
    expect(verifier.stderr()).toContain("cleanup is incomplete");
    expect(verifier.stderr()).toContain("token mismatch");
    const fixture = await scenario.started();
    expect(await isLive(fixture.pid)).toBe(true);
    expect(await verifier.roots()).toHaveLength(1);
  },
);

for (const [signal, exitCode] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as const)
  macosIt(
    `the verifier releases its fixture when ${signal} interrupts the handshake`,
    { timeout: 40_000 },
    async () => {
      const scenario = await createScenario();
      const verifier = await runVerifier(scenario);
      const fixture = await scenario.started();
      verifier.child.kill(signal);
      expect((await verifier.exit).code, verifier.stderr()).toBe(exitCode);
      expect(await isLive(fixture.pid)).toBe(false);
      expect(await verifier.roots()).toEqual([]);
    },
  );
