import { execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { spawn } from "@lydell/node-pty";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import pino from "pino";
import { expect, it, onTestFinished } from "vitest";

import { registerReverseEngineeringCommands } from "../../../src/cli/reverseEngineeringCommands.js";
import type { CliInstance } from "../../../src/cli/types.js";
import { CLI_COMMANDS } from "../../../src/cliCommandNames.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import type { Result } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { RizinDebugSessionManager } from "../../../src/rizin/RizinDebugSessionManager.js";
import { registerRizinDebugTools } from "../../../src/server/registerRizinDebugTools.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { rizinTestTtyPathPattern } from "./RizinTestInferiorTty.js";

// Real Rizin is not exercised here. These launchers apply `-R` keys the way the
// #8642 report observed on Rizin 0.9.1, and the target is a real process, so the
// tests prove what REA asks for and what a real child then inherits and reads.

interface LauncherOptions {
  /** Shell commands the target runs before it waits to be resumed. */
  readonly prelude?: string;
  /** The real command the target becomes once resumed. */
  readonly target: string;
  /** Report a ptrace row, which sends close through the Linux detach path. */
  readonly reportsInferior: boolean;
  /** Keep the target on the debugger's own stdin despite `-R stdin=`. */
  readonly ignoresStdinProfile?: boolean;
}

interface Terminal {
  readonly path: string;
  readonly output: () => string;
  readonly write: (text: string) => void;
}

interface Fixture {
  readonly launcher: string;
  readonly terminal: Terminal;
  readonly targetPid: () => Promise<number>;
  readonly launcherPid: () => Promise<number>;
  readonly commands: () => Promise<readonly string[]>;
}

const openTerminal = async (): Promise<Terminal> => {
  const pty = spawn("sh", ["-c", "tty; exec sleep 600"], {
    name: "xterm",
    cols: 80,
    rows: 24,
    encoding: "utf8",
  });
  let output = "";
  pty.onData((chunk) => {
    output += chunk;
  });
  let exited = false;
  const ended = new Promise<void>((resolve) => {
    pty.onExit(() => {
      exited = true;
      resolve();
    });
  });
  onTestFinished(async () => {
    if (!exited) pty.kill();
    await ended;
  });
  await expect
    .poll(() => rizinTestTtyPathPattern.test(output), { timeout: 2_000 })
    .toBe(true);
  return {
    path: rizinTestTtyPathPattern.exec(output)![0],
    output: () => output,
    write: (text) => pty.write(text),
  };
};

const launcherSource = (
  config: LauncherOptions & Record<string, unknown>,
): string => `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const config = ${JSON.stringify(config)};
const argv = process.argv.slice(2);
const profile = new Map();
argv.forEach((value, index) => {
  if (argv[index - 1] !== "-R") return;
  const separator = value.indexOf("=");
  profile.set(value.slice(0, separator), value.slice(separator + 1));
});
// A stream without a profile key keeps the debugger's own descriptor.
const stream = (key, flags, inherited) => {
  const path = profile.get(key);
  return path === undefined || (key === "stdin" && config.ignoresStdinProfile)
    ? inherited
    : fs.openSync(path, flags | fs.constants.O_NOCTTY);
};
// Like a ptrace stop, the gate holds the target before it touches stdin. These
// commands carry no redirection: dash applies one to the shell itself until the
// command returns, and this shell's descriptors are the target's in /proc.
const script = (config.prelude ?? "") + ' touch "$1"; cat "$2"; exec ' + config.target;
const target = spawn("/bin/sh", ["-c", script, "sh", config.readyPath, config.gatePath], {
  detached: true,
  stdio: [
    stream("stdin", fs.constants.O_RDONLY, 0),
    stream("stdout", fs.constants.O_WRONLY, "ignore"),
    stream("stderr", fs.constants.O_WRONLY, "ignore"),
  ],
});
fs.writeFileSync(config.targetPidPath, String(target.pid));
fs.writeFileSync(config.launcherPidPath, String(process.pid));
const deadline = Date.now() + 5000;
while (!fs.existsSync(config.readyPath) && Date.now() < deadline)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
let attached = config.reportsInferior;
const resume = () => fs.closeSync(fs.openSync(config.gatePath, "w"));
const answer = (line) => {
  if (line === "olj")
    process.stdout.write(JSON.stringify(attached ? [{ raised: true, fd: 3, uri: "ptrace://" + target.pid }] : []) + "\\0");
  else if (line === "e dbg.exitkills") process.stdout.write("false\\0");
  else if (line === "dr") process.stdout.write("rax=0x1\\0");
  else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\n\\0");
  else if (line === "resume-target" || line === "o- 3") {
    attached = false;
    resume();
    process.stdout.write("\\0");
    return true;
  } else {
    // The marker that follows must not complete a command this model cannot describe.
    fs.writeFileSync(config.unmodeledPath, line);
    process.exit(70);
  }
  return false;
};
// A plain read keeps fd 0 blocking for the real child that may share it, and a
// worker-thread read leaves the event loop free to reap that child. A debugger
// busy after resuming a target leaves it the only reader of the shared stream.
const buffer = Buffer.alloc(64 * 1024);
let input = "";
const readCommands = () =>
  fs.read(0, buffer, 0, buffer.length, null, (error, bytes) => {
    if (error !== null || bytes === 0) process.exit(0);
    input += buffer.toString("utf8", 0, bytes);
    let resumed = false;
    for (let end = input.indexOf("\\n"); end >= 0; end = input.indexOf("\\n")) {
      const line = input.slice(0, end);
      input = input.slice(end + 1);
      fs.appendFileSync(config.commandLogPath, line + "\\n");
      resumed = answer(line) || resumed;
    }
    setTimeout(readCommands, resumed ? 100 : 0);
  });
process.stdout.write("\\0");
readCommands();
`;

/** Close reads target descriptors from Linux /proc. */
const linuxIt = it.skipIf(process.platform !== "linux");

/** Close inventories the target, detaches it, then reads the result back. */
const DETACH_COMMANDS = [
  "olj",
  "e dbg.exitkills",
  "o- 3",
  "olj",
  "e dbg.exitkills",
];
/** A refused close stops after the inventory and exit policy, before `o-`. */
const REFUSED_CLOSE_COMMANDS = ["olj", "e dbg.exitkills"];

/** A negative PID also covers the gate reader a detached target may be waiting on. */
const killIfRunning = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may already have ended.
  }
};

const successValue = <Value>(result: Result<Value, AnalysisError>): Value => {
  if (!result.ok) throw result.error;
  return result.value;
};

/** Finish hooks run in reverse order: manager, processes, terminal, directory. */
const createFixture = async (options: LauncherOptions): Promise<Fixture> => {
  const directory = await createTestTempDirectory("rea-rizin-stdin-");
  const paths = {
    readyPath: join(directory, "target.ready"),
    gatePath: join(directory, "target.gate"),
    targetPidPath: join(directory, "target.pid"),
    launcherPidPath: join(directory, "launcher.pid"),
    commandLogPath: join(directory, "commands.log"),
    unmodeledPath: join(directory, "unmodeled.txt"),
  };
  const terminal = await openTerminal();
  const readPid = async (path: string): Promise<number> =>
    Number(await readFile(path, "utf8"));
  onTestFinished(async () => {
    const targetPid = await readPid(paths.targetPidPath).catch(() => 0);
    const launcherPid = await readPid(paths.launcherPidPath).catch(() => 0);
    if (targetPid > 0) killIfRunning(-targetPid);
    if (launcherPid > 0) killIfRunning(launcherPid);
    expect(await readFile(paths.unmodeledPath, "utf8").catch(() => "")).toBe(
      "",
    );
  });
  execFileSync("mkfifo", [paths.gatePath]);
  const launcher = join(directory, "fake-rizin.cjs");
  await writeFile(launcher, launcherSource({ ...options, ...paths }));
  await chmod(launcher, 0o700);
  return {
    launcher,
    terminal,
    targetPid: () => readPid(paths.targetPidPath),
    launcherPid: () => readPid(paths.launcherPidPath),
    commands: async () =>
      (await readFile(paths.commandLogPath, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line.length > 0 && !line.startsWith("!echo ")),
  };
};

const createManager = (
  { launcher }: Fixture,
  options: NonNullable<
    ConstructorParameters<typeof RizinDebugSessionManager>[1]
  > = {},
  environment: Readonly<NodeJS.ProcessEnv> = {},
): RizinDebugSessionManager => {
  const manager = new RizinDebugSessionManager(
    { ...process.env, REA_RIZIN_COMMAND: launcher, ...environment },
    options,
  );
  onTestFinished(() => manager.closeAll().catch(() => undefined));
  return manager;
};

const startSession = async (
  manager: RizinDebugSessionManager,
  { terminal }: Fixture,
): Promise<string> => {
  const started = await manager.start({
    path: "/usr/bin/cat",
    inferior_tty: terminal.path,
  });
  return successValue(started).session_id;
};

const expectRefusedClose = async (
  manager: RizinDebugSessionManager,
  sessionId: string,
): Promise<void> => {
  const closed = await manager.close(sessionId);
  if (closed.ok)
    throw new Error("Close must refuse a target holding the command stream.");
  expect(closed.error.message).toContain("Rizin command stream");
  expect(closed.error.cleanupIncomplete).toBe(true);
  expect(closed.error.cleanupResources).toEqual([sessionId]);
  expect(manager.status(sessionId)?.state).toBe("closed");
};

const expectRunningOnTerminal = async (
  pid: number,
  terminal: Terminal,
): Promise<void> => {
  expect(() => process.kill(pid, 0)).not.toThrow();
  const [stdin, selected] = await Promise.all([
    stat(`/proc/${String(pid)}/fd/0`),
    stat(terminal.path),
  ]);
  expect([stdin.dev, stdin.ino]).toEqual([selected.dev, selected.ino]);
};

const registerCliCommand = (launcher: string) => {
  const commands = new Map<
    string,
    {
      run(input: {
        args: { path: string; command: string };
        options: { inferiorTty: string };
      }): Promise<unknown>;
    }
  >();
  const cli = {
    command: (name: string, definition: never) => {
      commands.set(name, definition);
      return cli;
    },
  } as unknown as CliInstance;
  registerReverseEngineeringCommands(cli, pino({ enabled: false }), {
    ...process.env,
    REA_RIZIN_COMMAND: launcher,
  });
  return commands.get(CLI_COMMANDS.debugWithRizin)!;
};

it.skipIf(process.platform === "win32")(
  "keeps debugger commands away from a running target that reads stdin",
  async () => {
    const current = await createFixture({
      target: "cat",
      reportsInferior: false,
    });
    const manager = createManager(
      current,
      {
        // The launcher reports no inferior, so close needs no Linux /proc readback.
        platform: "linux",
      },
      { REA_DEBUGGER_COMMAND_DEADLINE_MS: "3000" },
    );
    const sessionId = await startSession(manager, current);

    successValue(await manager.execute(sessionId, "resume-target"));
    const answered = successValue(await manager.execute(sessionId, "dr"));

    expect(answered.result).toMatchObject({
      output: "rax=0x1",
      completion_status: "complete",
    });
    expect(current.terminal.output()).not.toContain("__REA_");

    // Line-discipline echo shows the input once. A second copy needs `cat` to
    // read it from the selected TTY, so the caller's input channel really works.
    current.terminal.write("rea-input-probe\n");
    await expect
      .poll(
        () => current.terminal.output().split("rea-input-probe").length - 1,
        { timeout: 2_000 },
      )
      .toBe(2);
    successValue(await manager.close(sessionId));
    expect(await current.commands()).toEqual(["resume-target", "dr", "olj"]);
  },
);

linuxIt.each([
  { name: "reads stdin", target: "cat", staysRunning: true },
  { name: "ignores stdin", target: "sleep 30", staysRunning: true },
  { name: "exits on resume", target: "true", staysRunning: false },
])(
  "detaches a target that $name through MCP",
  async ({ target, staysRunning }) => {
    const current = await createFixture({ target, reportsInferior: true });
    const manager = createManager(current);
    const server = new McpServer({ name: "rizin-stdin", version: "1" });
    registerRizinDebugTools(
      server,
      manager,
      silentLogger,
      createToolResultDelivery(undefined),
    );
    const client = new Client({ name: "rizin-stdin", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const started = await client.callTool({
        name: "start_rizin_debug_session",
        arguments: {
          path: "/usr/bin/cat",
          inferior_tty: current.terminal.path,
        },
      });
      expect(started.isError, JSON.stringify(started)).not.toBe(true);
      const { session_id: sessionId } = toolContract(
        "start_rizin_debug_session",
      ).outputSchema.parse(started.structuredContent);

      const closed = await client.callTool({
        name: "close_rizin_debug_session",
        arguments: { session_id: sessionId },
      });

      expect(closed.isError, JSON.stringify(closed)).not.toBe(true);
      expect(closed.structuredContent).toEqual({ target_state: "unknown" });
      expect(manager.status(sessionId)).toBeUndefined();
      expect(await current.commands()).toEqual(DETACH_COMMANDS);
      expect(current.terminal.output()).not.toContain("__REA_");
      if (staysRunning)
        await expectRunningOnTerminal(
          await current.targetPid(),
          current.terminal,
        );
    } finally {
      await client.close();
      await server.close();
    }
  },
);

linuxIt.each([
  { name: "closed", prelude: "exec 0<&-;" },
  { name: "redirected", prelude: "exec </dev/null;" },
])(
  "detaches a target that already $name its own stdin",
  async ({ prelude }) => {
    const current = await createFixture({
      prelude,
      target: "sleep 30",
      reportsInferior: true,
    });
    const manager = createManager(current);
    const sessionId = await startSession(manager, current);

    successValue(await manager.close(sessionId));

    expect(await current.commands()).toEqual(DETACH_COMMANDS);
  },
);

linuxIt("completes the one-shot CLI on a target that reads stdin", async () => {
  const current = await createFixture({
    target: "cat",
    reportsInferior: true,
  });
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    const result = await registerCliCommand(current.launcher).run({
      args: { path: "/usr/bin/cat", command: "dr" },
      options: { inferiorTty: current.terminal.path },
    });

    expect(result).toMatchObject({
      operation: "rizin_debug_command",
      normalized_result: {
        output: "rax=0x1",
        completion_status: "complete",
      },
    });
    expect(process.exitCode).toBe(0);
    expect(await current.commands()).toEqual(["dr", ...DETACH_COMMANDS]);
    expect(current.terminal.output()).not.toContain("__REA_");
    await expectRunningOnTerminal(await current.targetPid(), current.terminal);
  } finally {
    process.exitCode = previousExitCode;
  }
});

linuxIt(
  "refuses to resume a target holding the command stream and retains ownership",
  async () => {
    const current = await createFixture({
      target: "cat",
      reportsInferior: true,
      ignoresStdinProfile: true,
    });
    let debuggerExited: Promise<unknown> | undefined;
    const manager = createManager(current, {
      spawnProcess: async (options) => {
        const launched = await spawnOwnedProviderProcess(options);
        debuggerExited = once(launched.process as ChildProcess, "exit");
        return launched;
      },
    });
    const sessionId = await startSession(manager, current);

    await expectRefusedClose(manager, sessionId);
    await expectRefusedClose(manager, sessionId);
    expect(await current.commands()).toEqual([
      ...REFUSED_CLOSE_COMMANDS,
      ...REFUSED_CLOSE_COMMANDS,
    ]);
    expect(current.terminal.output()).not.toContain("__REA_");
    await expect(manager.closeAll()).rejects.toThrow("did not stop cleanly");
    expect(manager.status(sessionId)).toBeDefined();

    // The retained owner settles once the identified target and debugger end.
    const targetPid = await current.targetPid();
    killIfRunning(-targetPid);
    await expect
      .poll(() =>
        readFile(`/proc/${String(targetPid)}/stat`, "utf8").then(
          () => "running",
          () => "ended",
        ),
      )
      .toBe("ended");
    killIfRunning(await current.launcherPid());
    await debuggerExited;
    await manager.closeAll();
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

linuxIt(
  "reports the refusal as cleanup_incomplete from the one-shot CLI",
  async () => {
    const current = await createFixture({
      target: "cat",
      reportsInferior: true,
      ignoresStdinProfile: true,
    });
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      const result = await registerCliCommand(current.launcher).run({
        args: { path: "/usr/bin/cat", command: "dr" },
        options: { inferiorTty: current.terminal.path },
      });

      expect(result).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          cleanup: "incomplete",
          partial_observation: { operation: "rizin_debug_command" },
        },
      });
      expect(JSON.stringify(result)).toContain("Rizin command stream");
      expect(process.exitCode).toBe(1);
      expect(await current.commands()).toEqual([
        "dr",
        ...REFUSED_CLOSE_COMMANDS,
        ...REFUSED_CLOSE_COMMANDS,
      ]);
    } finally {
      process.exitCode = previousExitCode;
    }
  },
);
