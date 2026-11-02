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
setTimeout(() => process.exit(0), 60000);
if (config.launcher === "fails") {
  process.stderr.write("authored launch refusal\\n");
  process.exit(3);
}
if (config.launcher === "ignores-term") process.on("SIGTERM", () => undefined);
// The launched app starts outside this process tree and inherits this environment.
const environment = { ...process.env };
// A launch service holds no run token; only the app it starts receives one.
const inFlight = config.launcher === "in-flight";
if (inFlight) {
  environment.PENDING_RUN_TOKEN = environment.REA_PROCESS_RUN_ID;
  delete environment.REA_PROCESS_RUN_ID;
}
const entry = new URL(inFlight ? "./launch-service.mjs" : "./fixture.mjs", import.meta.url).pathname;
const coordinates = args[args.indexOf("--stdout") + 1];
spawn(process.execPath, [entry, args.at(-1), coordinates], {
  detached: true,
  stdio: ["ignore", openSync(coordinates, "a"), "ignore"],
  env: environment,
}).unref();
if (config.launcher === "exits") process.exit(0);
`;

// The lane around an authored operation: the verifier's real operation needs
// native capture, so its successful path cannot be reached with injected tools.
const laneSource = (lifecycle: string) => `
import { appendFileSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runNativeUiFixtureLane } from ${JSON.stringify(lifecycle)};
const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const report = await runNativeUiFixtureLane(async (fixture) => {
  const application = join(fixture.root, "Fixture.app");
  await mkdir(application);
  const launching = fixture.launch(application);
  if (config.launcher === "in-flight") {
    // Release must not start until the launch is admitted, or nothing is in flight.
    launching.catch(() => undefined);
    while (!readFileSync(config.events, "utf8").includes('"kind":"launch-service"'))
      await new Promise((wake) => setTimeout(wake, 5));
    throw new Error("authored failure with a launch in flight");
  }
  const scope = await launching;
  if (config.operation === "hangs") {
    appendFileSync(config.events, JSON.stringify({ kind: "operation-hanging" }) + "\\n");
    await new Promise(() => setInterval(() => undefined, 1000));
  }
  return { completed: true, pid: scope.pid };
}, { launcherCommand: config.launcherEntry });
process.stdout.write(JSON.stringify(report) + "\\n");
`;

// Stands in for the launch service that keeps working after the launcher dies. The
// launch can start only while its application path exists, once the gate opens.
const launchServiceSource = `
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const [application, coordinates] = process.argv.slice(2);
appendFileSync(config.events, JSON.stringify({ kind: "launch-service", pid: process.pid }) + "\\n");
setTimeout(() => process.exit(0), 60000);
setInterval(() => {
  if (!existsSync(application)) {
    appendFileSync(config.events, JSON.stringify({ kind: "launch-refused" }) + "\\n");
    process.exit(0);
  }
  if (!existsSync(config.launchGate)) return;
  const { PENDING_RUN_TOKEN, ...environment } = process.env;
  spawn(process.execPath, [new URL("./fixture.mjs", import.meta.url).pathname, application, coordinates], {
    detached: true,
    stdio: "ignore",
    env: { ...environment, REA_PROCESS_RUN_ID: PENDING_RUN_TOKEN },
  }).unref();
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
    "const { existsSync } = require('node:fs'); setInterval(() => { if (existsSync(process.argv[1])) process.exit(0); }, 10); setTimeout(() => process.exit(0), 60000);",
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
setTimeout(() => process.exit(0), 60000);
`;

// Injects the compiler, launcher and, once the fixture runs, a clock jump into
// the actual verifier. A one-time offset leaves later cleanup budgets unchanged.
// holdRelease parks the real release at its retire step until the test opens the
// gate: the launcher has stopped, the fixture and root remain, nothing is mocked.
// holdRemoval parks it the same way just before the root is removed.
const preloadSource = `
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { promisify } from "node:util";
const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const hold = async (kind, gate) => {
  appendFileSync(config.events, JSON.stringify({ kind }) + "\\n");
  while (!existsSync(gate)) await new Promise((wake) => setTimeout(wake, 5));
};
const fsPromises = require("node:fs/promises");
if (config.holdRelease) {
  const { rename } = fsPromises;
  fsPromises.rename = async (from, to) => {
    if (String(to).endsWith(".retired")) await hold("release-held", config.releaseGate);
    return rename(from, to);
  };
}
if (config.holdRemoval) {
  const { rm } = fsPromises;
  fsPromises.rm = async (path, options) => {
    if (basename(String(path)).startsWith("rea-ui-fixture-")) await hold("removal-held", config.removalGate);
    return rm(path, options);
  };
}
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
  readonly holdRelease?: boolean;
  readonly holdRemoval?: boolean;
  readonly operation?: "completes" | "hangs";
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
    releaseGate: join(workspace, "release-gate"),
    removalGate: join(workspace, "removal-gate"),
    launchGate: join(workspace, "launch-gate"),
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
    join(workspace, "lane.mjs"),
    laneSource(
      pathToFileURL(resolve("scripts/lib/native-ui-fixture-lifecycle.mjs"))
        .href,
    ),
  );
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
  "fails at once when the launcher refuses, with its reason",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({ launcher: "fails" });
    const { owner, launch } = await launchedOwner(scenario, 15_000);
    // The exit path, not the deadline path, produces this message.
    await expect(launch).rejects.toThrow(
      /launcher exited \(code 3, signal null\).*authored launch refusal/u,
    );
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

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "kills a fixture that starts after a refused retirement before retrying root removal",
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
    // A read-only root is an actual refusal of the rename that retires the path.
    await chmod(owner.root, 0o500);
    onTestFinished(async () => {
      await chmod(owner.root, 0o700).catch(() => undefined);
    });
    const refusal = await owner.close().then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(refusal).toBeInstanceOf(NativeUiFixtureCleanupFailure);
    expect((refusal as Error).message).toContain("EACCES");
    expect(existsSync(owner.root)).toBe(true);

    // The sweep in that attempt found nothing; only now does the launch start.
    await writeFile(scenario.paths.launchGate, "");
    const fixture = await scenario.started();
    expect(await isLive(fixture.pid)).toBe(true);
    expect(existsSync(owner.root)).toBe(true);

    await chmod(owner.root, 0o700);
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

const runEntry = async (
  scenario: Awaited<ReturnType<typeof createScenario>>,
  entry: string,
) => {
  const temporary = join(scenario.workspace, "tmp");
  await mkdir(temporary);
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(join(scenario.workspace, "preload.mjs")).href,
      entry,
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
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  const exit = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit) => {
    child.once("close", (code, signal) => {
      resolveExit({ code, signal });
    });
  });
  const roots = async () =>
    (await readdir(temporary)).filter((name) =>
      name.startsWith("rea-ui-fixture-"),
    );
  return {
    child,
    exit,
    roots,
    temporary,
    stderr: () => stderr,
    stdout: () => stdout,
  };
};

type RunningEntry = Awaited<ReturnType<typeof runEntry>>;
type Scenario = Awaited<ReturnType<typeof createScenario>>;

// Waits for the barrier inside the real release, then proves the signals neither
// ended the process nor released anything early. A pending signal would coalesce
// with the next, and a delay can only miss a defect here, never invent one.
const signalDuringHeldRelease = async (
  scenario: Scenario,
  entry: RunningEntry,
  signals: readonly NodeJS.Signals[],
) => {
  await waitUntil(
    async () =>
      (await scenario.events()).some(({ kind }) => kind === "release-held"),
    "the release to reach its barrier",
  );
  for (const signal of signals) {
    entry.child.kill(signal);
    await delay(150);
  }
  const fixture = await scenario.started();
  expect(entry.child.signalCode, entry.stderr()).toBeNull();
  expect(entry.child.exitCode, entry.stderr()).toBeNull();
  expect(await isLive(fixture.pid)).toBe(true);
  expect(await entry.roots()).toHaveLength(1);
  return fixture;
};

const lane = (scenario: Scenario) =>
  runEntry(scenario, join(scenario.workspace, "lane.mjs"));

// Root removal waits at its barrier until the test has seen the launch refused, so
// no scheduling of the stand-in launch service can decide this ordering.
posixIt(
  "ends a launch still in flight when its launcher is stopped, before removing the root",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({
      launcher: "in-flight",
      holdRemoval: true,
    });
    const running = await lane(scenario);
    await waitUntil(
      async () =>
        (await scenario.events()).some(({ kind }) => kind === "removal-held"),
      "the release to reach root removal",
    );
    await waitUntil(
      async () =>
        (await scenario.events()).some(({ kind }) => kind === "launch-refused"),
      "the in-flight launch to lose its application",
    );
    const [root] = await running.roots();
    expect(root).toBeDefined();
    const application = join(running.temporary, root ?? "", "Fixture.app");
    expect(existsSync(application)).toBe(false);
    expect(existsSync(`${application}.retired`)).toBe(true);
    await writeFile(scenario.paths.removalGate, "");
    expect(await running.exit, running.stderr()).toEqual({
      code: 1,
      signal: null,
    });
    expect(running.stderr()).toContain(
      "authored failure with a launch in flight",
    );
    expect(await running.roots()).toEqual([]);
  },
);

posixIt(
  "the lane reports a completed run with a held release and no signal",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({
      ready: "immediate",
      holdRelease: true,
    });
    const running = await lane(scenario);
    const fixture = await signalDuringHeldRelease(scenario, running, []);
    await writeFile(scenario.paths.releaseGate, "");
    expect(await running.exit, running.stderr()).toEqual({
      code: 0,
      signal: null,
    });
    expect(JSON.parse(running.stdout())).toEqual({
      completed: true,
      pid: fixture.pid,
    });
    expect(await isLive(fixture.pid)).toBe(false);
    expect(await running.roots()).toEqual([]);
  },
);

for (const [signal, exitCode] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as const)
  posixIt(
    `the lane keeps a completed report and exits ${String(exitCode)} when ${signal} arrives during a held release`,
    { timeout: 30_000 },
    async () => {
      const scenario = await createScenario({
        ready: "immediate",
        holdRelease: true,
      });
      const running = await lane(scenario);
      const fixture = await signalDuringHeldRelease(scenario, running, [
        signal,
        signal,
      ]);
      await writeFile(scenario.paths.releaseGate, "");
      expect(await running.exit, running.stderr()).toEqual({
        code: exitCode,
        signal: null,
      });
      expect(JSON.parse(running.stdout())).toEqual({
        completed: true,
        pid: fixture.pid,
      });
      expect(await isLive(fixture.pid)).toBe(false);
      expect(await running.roots()).toEqual([]);
    },
  );

posixIt(
  "the lane reports the retained root and exits interrupted when a held release fails after a completed run",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({
      ready: "immediate",
      holdRelease: true,
      untokenedMember: true,
    });
    const running = await lane(scenario);
    const fixture = await signalDuringHeldRelease(scenario, running, [
      "SIGTERM",
      "SIGTERM",
    ]);
    await writeFile(scenario.paths.releaseGate, "");
    expect(await running.exit, running.stderr()).toEqual({
      code: 143,
      signal: null,
    });
    const [root] = await running.roots();
    expect(root).toBeDefined();
    expect(running.stderr()).toContain(
      `retained ${join(running.temporary, root ?? "")} for run ${fixture.runId}`,
    );
    expect(running.stderr()).toContain("token mismatch");
    expect(await isLive(fixture.pid)).toBe(true);
  },
);

for (const [outcome, untokenedMember] of [
  ["released", false],
  ["retained", true],
] as const)
  posixIt(
    `the lane ends a hung operation on a signal once its release settles as ${outcome}`,
    { timeout: 30_000 },
    async () => {
      const scenario = await createScenario({
        ready: "immediate",
        operation: "hangs",
        untokenedMember,
      });
      const running = await lane(scenario);
      await waitUntil(
        async () =>
          (await scenario.events()).some(
            ({ kind }) => kind === "operation-hanging",
          ),
        "the operation to hang",
      );
      const fixture = await scenario.started();
      running.child.kill("SIGTERM");
      expect(await running.exit, running.stderr()).toEqual({
        code: 143,
        signal: null,
      });
      expect(running.stdout()).toBe("");
      expect(running.stderr()).toContain(
        untokenedMember ? "cleanup is incomplete" : "interrupted by SIGTERM",
      );
      expect(await isLive(fixture.pid)).toBe(untokenedMember);
      expect(await running.roots()).toHaveLength(untokenedMember ? 1 : 0);
    },
  );

posixIt(
  "the lane fails with the retained root when release fails after a completed run and no signal",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({
      ready: "immediate",
      untokenedMember: true,
    });
    const running = await lane(scenario);
    expect(await running.exit, running.stderr()).toEqual({
      code: 1,
      signal: null,
    });
    expect(running.stdout()).toBe("");
    expect(running.stderr()).toContain("cleanup is incomplete");
    expect(await running.roots()).toHaveLength(1);
  },
);

posixIt(
  "joined closes share one failed release, and a later close retries it",
  { timeout: 30_000 },
  async () => {
    const scenario = await createScenario({ untokenedMember: true });
    const { owner, launch } = await launchedOwner(scenario, 300);
    await expect(launch).rejects.toThrow("failed to expose one window");
    const fixture = await scenario.started();
    const first = owner.close();
    const joined = owner.close();
    expect(joined).toBe(first);
    await expect(first).rejects.toBeInstanceOf(NativeUiFixtureCleanupFailure);
    expect(existsSync(owner.root)).toBe(true);
    await writeFile(scenario.paths.memberRelease, "");
    await waitUntil(
      async () => !(await isLive(fixture.member ?? -1)),
      "the unproven member to exit",
    );
    await expectReleased(owner, scenario, fixture.pid);
  },
);

// The verifier refuses other hosts before any fixture is created. These drive
// the actual entrypoint; its compiler and launcher are injected, so they cover
// the entrypoint's ownership wiring and not native capture.
const macosIt = it.skipIf(process.platform !== "darwin");

const runVerifier = (scenario: Scenario) =>
  runEntry(scenario, resolve("scripts/verify-native-ui.mjs"));

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

for (const signals of [
  ["SIGTERM"],
  // npm forwards Ctrl-C, so one keypress can deliver the same signal twice.
  ["SIGINT", "SIGINT"],
  ["SIGTERM", "SIGTERM", "SIGINT"],
] as const)
  macosIt(
    `the verifier finishes a held release through ${signals.join(", ")} and keeps its primary failure`,
    { timeout: 40_000 },
    async () => {
      const scenario = await createScenario({
        clockJump: true,
        holdRelease: true,
      });
      const verifier = await runVerifier(scenario);
      const fixture = await signalDuringHeldRelease(
        scenario,
        verifier,
        signals,
      );
      await writeFile(scenario.paths.releaseGate, "");
      expect(await verifier.exit, verifier.stderr()).toEqual({
        code: 1,
        signal: null,
      });
      expect(verifier.stderr()).toContain("failed to expose one window");
      expect(await isLive(fixture.pid)).toBe(false);
      expect(await verifier.roots()).toEqual([]);
    },
  );

macosIt(
  "the verifier reports both failures and the retained root when a held release fails after a signal",
  { timeout: 40_000 },
  async () => {
    const scenario = await createScenario({
      clockJump: true,
      holdRelease: true,
      untokenedMember: true,
    });
    const verifier = await runVerifier(scenario);
    const fixture = await signalDuringHeldRelease(scenario, verifier, [
      "SIGTERM",
      "SIGTERM",
    ]);
    await writeFile(scenario.paths.releaseGate, "");
    expect(await verifier.exit, verifier.stderr()).toEqual({
      code: 1,
      signal: null,
    });
    expect(verifier.stderr()).toContain("failed to expose one window");
    const [root] = await verifier.roots();
    expect(root).toBeDefined();
    expect(verifier.stderr()).toContain(
      `retained ${join(verifier.temporary, root ?? "")} for run ${fixture.runId}`,
    );
    expect(verifier.stderr()).toContain("token mismatch");
    expect(await isLive(fixture.pid)).toBe(true);
  },
);
