import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, expect, it } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../../../src/domain/analysisErrorCore.js";
import {
  commandMayChangeInferiorOutput,
  gdbErrorMessage,
  gdbOneShotCommandMayInvalidateDetachProof,
  gdbThreadGroupCount,
  GdbSessionManager,
  miStringField,
  waitForGdbCommandTurn,
} from "../../../src/gdb/GdbSessionManager.js";
import type {
  OwnedProviderProcessSpawnOptions,
  ProviderProcessHandle,
  SpawnedOwnedProviderProcess,
} from "../../../src/process/ProviderProcess.js";
import {
  DEBUGGER_COMMAND_DEADLINE_SETTING,
  DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_SETTING,
} from "../../../src/config/debuggerSessionLimits.js";
import { DEFAULT_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES } from "../../../src/domain/analysisResourceLimits.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { stopOwnedDebuggerProcess } from "../../../src/process/ownedDebuggerSession.js";
import { createProviderSpawnTracker } from "../../support/gdbProviderSpawnTracking.js";
import { parseLinuxProcessStat } from "../../../src/process/LinuxProcessStat.js";
import { expectGdbSessionStarted } from "./gdbTestHelpers.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

let directory: string | undefined;
const managers: GdbSessionManager[] = [];
const providerSpawns = createProviderSpawnTracker();

it.each([
  ["empty list", "1^done,groups=[]", 0],
  [
    "valid trailing extension fields",
    '1^done,groups=[],extension="retained",details=[{state="known"}]',
    0,
  ],
  [
    "valid leading and trailing extension fields",
    '1^done,before={state="retained"},groups=[],after=["known"]',
    0,
  ],
  ["one group", '1^done,groups=[{id="i1",pid="123"}]', 1],
  [
    "multiple groups",
    '1^done,groups=[{id="i1",pid="123"},{id="i2",pid="456"}]',
    2,
  ],
  ["group without a live pid", '1^done,groups=[{id="i1"}]', 0],
  [
    "nested group-like object",
    '1^done,groups=[{id="i1",pid="123",children=[{id="i2"}]}]',
    1,
  ],
  [
    "quoted brackets",
    '1^done,groups=[{id="i1",pid="123",description="[{}]"}]',
    1,
  ],
  [
    "escaped quote and backslash",
    '1^done,groups=[{id="i1",pid="123",description="\\\\\\\""}]',
    1,
  ],
  [
    "unquoted nested groups field",
    '1^done,groups=[{id="i1",children=[{id="i2",groups=[{id="i3"}]}]}]',
    undefined,
  ],
  [
    "unknown extension field ending in groups",
    '1^done,groups=[{id="i1",other_groups=[{id="i2"}]}]',
    0,
  ],
  [
    "quoted groups marker before the top-level inventory",
    '1^done,msg="fixture/groups=[",groups=[]',
    0,
  ],
  [
    "duplicate top-level groups fields",
    '1^done,groups=[],groups=[{id="i1",pid="123"}]',
    undefined,
  ],
  [
    "duplicate groups field with a non-list value",
    '1^done,groups=[],groups="unavailable"',
    undefined,
  ],
  ["trailing bytes after inventory", "1^done,groups=[]garbage", undefined],
  ["malformed trailing result value", "1^done,groups=[],extra=}", undefined],
  ["malformed prefix result", "1^done,extra=},groups=[]", undefined],
  ["groups list with a non-tuple value", '1^done,groups=["i1"]', undefined],
  ["group tuple without its required id", "1^done,groups=[{}]", undefined],
  ["negative object depth", "1^done,groups=[}]", undefined],
  ["unclosed list", '1^done,groups=[{id="i1"}', undefined],
  ["missing groups field", "1^done", undefined],
  [
    "unclosed trailing quoted field",
    '1^done,groups=[],extra="unterminated',
    undefined,
  ],
] as const)("parses recursive GDB MI groups: %s", (_label, mi, expected) => {
  expect(gdbThreadGroupCount(mi)).toBe(expected);
});

it("keeps GDB inventory unknown when MI nesting exceeds the parser frame budget", () => {
  const nestedValue = "[".repeat(257) + "]".repeat(257);
  expect(
    gdbThreadGroupCount("1^done,groups=[],extension=" + nestedValue),
  ).toBeUndefined();
});

it.each([
  ['1^done,inferior_tty_terminal="/dev/pts/2"', "/dev/pts/2"],
  ['1^done,inferior_tty_terminal="line\\nnext"', "line\nnext"],
  ['1^done,inferior_tty_terminal="\\x41\\101"', "AA"],
  ['1^done,inferior_tty_terminal="\\7"', "\u0007"],
  ['1^done,inferior_tty_terminal="emoji 🚀"', "emoji 🚀"],
  ['1^done,inferior_tty_terminal="\\xFF"', undefined],
  ['1^done,inferior_tty_terminal="\\x"', undefined],
  ['1^done,inferior_tty_terminal="\\q"', undefined],
  ['1^done,inferior_tty_terminal="/dev/pts/2"junk', undefined],
  ['1^done,inferior_tty_terminal="a",inferior_tty_terminal="a"', undefined],
  ['1^error,msg="not done"', undefined],
  ['1^done,inferior_tty_terminal="\ud800"', undefined],
] as const)("decodes GDB MI C-string fields: %s", (mi, expected) => {
  expect(miStringField(mi, "inferior_tty_terminal")).toBe(expected);
});

it.each([
  ["show version", false],
  ["show inferior-tty", false],
  ["help inferior-tty", false],
  ["show inferior-tty\nset inferior-tty /tmp/other", true],
  ["help inferior-tty; run > /tmp/other", true],
  ["set pagination off", false],
  ["set inferior-t /tmp/output", true],
  ["inferior-tty /tmp/output", true],
  ["tty /dev/pts/2", true],
  ["source commands.gdb", true],
  ["sour commands.gdb", true],
  ["sourc commands.gdb", true],
  ["python print(1)", true],
  ["define start\nrun", true],
  ["run < input.txt", false],
  ["run <input.txt", false],
  ["run <&-", false],
  ["run 0<&-", false],
  ["run <&- --mode fast", false],
  ["run 0<&- arg", false],
  ["run < first.txt < second.txt", false],
  ["run <&- < input.txt", false],
  ["run 0<input.txt", false],
  ["run arg<input.txt", false],
  ["run arg2<input.txt", false],
  ["run <input.txt --mode fast", false],
  ["run < input.txt --mode fast", false],
  ["run arg < input.txt", false],
  ["run '2'<input.txt", false],
  ["run \\2<input.txt", false],
  ['run <"input>name"', false],
  ["run <'input;|&>name'", false],
  ['run "arg>name" < input.txt', false],
  ["run <input\\>name", false],
  ["run <>input.txt", false],
  ["run 0<>input.txt", false],
  ["run 00<>input.txt", false],
  ["run 1<>output.txt", true],
  ["run 2<>error.txt", true],
  ['run <"input>name" > out', true],
  ['run <"unterminated', true],
  ["run 2<input.txt", true],
  ["run 2<&-", true],
  ["run 00<input.txt", false],
  ["run 0000<&-", false],
  ["run 01<input.txt", true],
  ["run 01<&-", true],
  ["run > /tmp/output", true],
  ["run < input.txt > /tmp/output", true],
  ["run < input.txt; echo done", true],
  ["run < input.txt\ncontinue", true],
  ["t 1", false],
  ["tt /dev/pts/2", true],
] as const)("classifies inferior output mutations: %s", (command, expected) => {
  expect(commandMayChangeInferiorOutput(command)).toBe(expected);
});

it("classifies malformed input-only close arguments without regex backtracking", () => {
  const command = `run <&- ${"arg ".repeat(28)}&`;
  expect(commandMayChangeInferiorOutput(command)).toBe(true);
});

it("classifies malformed input redirection arguments without regex backtracking", () => {
  const command = `run <input ${"arg ".repeat(28)}&`;
  expect(commandMayChangeInferiorOutput(command)).toBe(true);
});

// GDB's built-in aliases are full commands, not abbreviations of python,
// source or define (#5098); ambiguous and true abbreviations stay refused.
it.each([
  ["p 1", false],
  ["print 1", false],
  ["s", false],
  ["step", false],
  ["d 1", false],
  ["delete 1", false],
  ["t 1", false],
  ["py print(1)", true],
  ["pyt print(1)", true],
  ["so commands.gdb", true],
  ["de", true],
  ["p 1; python print(2)", true],
] as const)("classifies one-shot GDB commands: %s", (command, expected) => {
  expect(gdbOneShotCommandMayInvalidateDetachProof(command)).toBe(expected);
});

it.each([
  [new Error("provider failure"), "provider failure"],
  ["non-error provider failure", "non-error provider failure"],
] as const)("formats unknown GDB boundary failures", (cause, message) => {
  expect(gdbErrorMessage(cause)).toBe(message);
});

it("rejects an invalid caller TTY and platforms without safe GDB ownership", async () => {
  const invalid = await new GdbSessionManager().start(undefined, {
    inferiorTty: "bad\0tty",
  });
  expect(invalid).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });

  let macSpawned = false;
  const macos = new GdbSessionManager({
    platform: "darwin",
    spawnProcess: async () => {
      macSpawned = true;
      throw new Error("unsupported hosts must not spawn GDB");
    },
  });
  managers.push(macos);
  const macUnavailable = await macos.start();
  expect(macUnavailable).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  if (!macUnavailable.ok)
    expect(macUnavailable.error.message).toContain("available only on Linux");
  expect(macSpawned).toBe(false);

  const windows = new GdbSessionManager({ platform: "win32" });
  managers.push(windows);
  const unavailable = await windows.start();
  expect(unavailable).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
});

class FakeGdbProcess extends EventEmitter implements ProviderProcessHandle {
  readonly pid = process.pid + 1;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: PassThrough | null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: NodeJS.Signals[] = [];

  constructor(stdinEnabled = true) {
    super();
    this.stdin = stdinEnabled ? new PassThrough() : null;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout?.end();
    this.stderr.end();
    this.stdin?.destroy();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  exitLeader(code: number): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  closeInheritedOutput(): void {
    this.stdout.end();
    this.stderr.end();
    this.stdin?.destroy();
    this.emit("close", this.exitCode, this.signalCode);
  }
}

const createFakeSpawner = (
  respond: (process: FakeGdbProcess, token: string, command: string) => void = (
    child,
    token,
    command,
  ) =>
    child.stdout.write(
      command.includes("list-thread-groups")
        ? `${token}^done,groups=[]\n`
        : `${token}^done\n`,
    ),
  options: {
    readonly stdinEnabled?: boolean;
    readonly exitAfterPrompt?: boolean;
    readonly exitOnFirstStdoutData?: boolean;
    readonly startupExitCode?: number | null;
    readonly startupExitSignal?: NodeJS.Signals | null;
    readonly stdoutNull?: boolean;
    readonly deferPrompt?: boolean;
    readonly afterPrompt?: () => void;
    readonly afterSpawn?: () => void;
  } = {},
): {
  readonly spawnProcess: (
    spawnOptions: OwnedProviderProcessSpawnOptions,
  ) => Promise<SpawnedOwnedProviderProcess>;
  readonly children: FakeGdbProcess[];
} => {
  const children: FakeGdbProcess[] = [];
  return {
    children,
    spawnProcess: async (spawnOptions) => {
      const child = new FakeGdbProcess(options.stdinEnabled ?? true);
      children.push(child);
      if (options.stdoutNull)
        Object.defineProperty(child, "stdout", { value: null });
      if (options.deferPrompt) {
        setImmediate(() => {
          child.stdout.write("(gdb)\n");
          options.afterPrompt?.();
        });
      } else if (!options.stdoutNull) child.stdout.write("(gdb)\n");
      if (options.exitOnFirstStdoutData)
        child.stdout.once("data", () =>
          queueMicrotask(() =>
            child.exit(
              options.startupExitCode === undefined
                ? 0
                : options.startupExitCode,
              options.startupExitSignal === undefined
                ? null
                : options.startupExitSignal,
            ),
          ),
        );
      child.stdin?.setEncoding("utf8");
      child.stdin?.on("data", (chunk: string | Buffer) => {
        for (const line of String(chunk).split("\n")) {
          const match = /^(\d+)(.*)$/u.exec(line);
          if (match !== null) respond(child, match[1] ?? "", match[2] ?? "");
        }
      });
      if (options.exitAfterPrompt) queueMicrotask(() => child.exit(0, null));
      options.afterSpawn?.();
      return {
        process: child,
        ownership: {
          runId: spawnOptions.runId,
          leaderPid: child.pid,
          processGroupId: child.pid,
          expectedParentPid: process.pid,
        },
      };
    },
  };
};

const recordingInferiorListResponder = (groups: string) => {
  const commands: string[] = [];
  return {
    commands,
    respond: (child: FakeGdbProcess, token: string, command: string): void => {
      commands.push(command);
      child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,groups=${groups}\n`
          : `${token}^done\n`,
      );
    },
  };
};

it("returns cancellation when GDB startup is aborted after spawn", async () => {
  const controller = new AbortController();
  const reason = { source: "caller startup cancellation" };
  const fake = createFakeSpawner(undefined, {
    afterSpawn: () => controller.abort(reason),
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start(controller.signal);

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error._tag).toBe("AnalysisCancelledError");
    expect(started.error.cause).toBe(reason);
  }
  expect(fake.children[0]?.signalCode).toBe("SIGTERM");
});

it("cancels immediately after the startup prompt before sending configuration commands", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled after prompt");
  const commands: string[] = [];
  const fake = createFakeSpawner(
    (child, token, command) => {
      commands.push(command);
      child.stdout.write(`${token}^done\n`);
    },
    {
      deferPrompt: true,
      afterPrompt: () => controller.abort(reason),
    },
  );
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start(controller.signal);

  expect(started).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect(commands).toEqual([]);
  if (!started.ok) expect(started.error.cause).toBe(reason);
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
});

it("rejects a GDB exit queued with the final startup response", async () => {
  const fake = createFakeSpawner((child, token, command) => {
    child.stdout.write(`${token}^done\n`);
    if (command.includes("auto-load off"))
      setImmediate(() => child.exit(7, null));
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await manager.start();
  expect(started).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  expect(fake.children[0]?.exitCode).toBe(7);
});

it("keeps a consumed startup failure primary when caller abort arrives during cleanup", async () => {
  const controller = new AbortController();
  const reason = { source: "late caller cancellation" };
  const fake = createFakeSpawner((_child, token, command) => {
    if (command.includes("auto-load off"))
      _child.stdout.write(`${token}^error,msg="configuration rejected"\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => {
      controller.abort(reason);
      return { status: "stopped" };
    },
  });

  const started = await manager.start(controller.signal);

  expect(started).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  if (!started.ok)
    expect(started.error.cause).toMatchObject({
      _tag: "AnalysisCapabilityUnavailableError",
    });
});

it("retains failed startup ownership when stop rejects and resolves it on retry", async () => {
  const fake = createFakeSpawner((child, token) => {
    child.stdout.write(`${token}^error,msg="configuration rejected"\n`);
  });
  let recovered = false;
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async (session, name) => {
      if (!recovered) throw new Error("startup stop rejected");
      return stopOwnedDebuggerProcess(session, name);
    },
  });
  const started = await manager.start();
  expect(started).toMatchObject({
    ok: false,
    error: {
      cleanupIncomplete: true,
      cause: { _tag: "AnalysisCapabilityUnavailableError" },
      message: expect.stringContaining("configuration"),
    },
  });
  if (started.ok) return;
  expect(started.error.cleanupResources).toHaveLength(1);
  expect((await manager.retryCleanupFailures()).ok).toBe(false);
  recovered = true;
  expect((await manager.retryCleanupFailures()).ok).toBe(true);
  expect(started.error.cleanupIncomplete).toBe(false);
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
});

it("cancels startup when aborted during the final readiness drain", async () => {
  const controller = new AbortController();
  const reason = "caller cancelled during readiness drain";
  const commands: string[] = [];
  const fake = createFakeSpawner((child, token, command) => {
    commands.push(command);
    child.stdout.write(`${token}^done\n`);
    if (command.includes("auto-load off"))
      setImmediate(() => controller.abort(reason));
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start(controller.signal);

  expect(started).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect(commands).toEqual(["-gdb-set auto-load off"]);
  if (!started.ok) expect(started.error.cause).toBe(reason);
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
});

it("preserves cancellation and cleanup details when startup stop is uncertain", async () => {
  const controller = new AbortController();
  const reason = { source: "startup caller", token: 7 };
  let stopCalls = 0;
  const fake = createFakeSpawner(undefined, {
    deferPrompt: true,
    afterPrompt: () => controller.abort(reason),
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async (session, name) => {
      stopCalls += 1;
      return stopCalls === 1
        ? {
            status: "incomplete",
            reason: "simulated startup cancellation cleanup uncertainty",
          }
        : stopOwnedDebuggerProcess(session, name);
    },
  });

  const started = await manager.start(controller.signal);

  expect(started).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCancelledError",
      operation: "start_gdb_session",
      cleanup: { reason: "simulated startup cancellation cleanup uncertainty" },
    },
  });
  if (!started.ok) expect(started.error.cause).toBe(reason);
});

it("keeps manager-close cancellation primary when caller abort arrives during startup cleanup", async () => {
  const caller = new AbortController();
  const callerReason = { source: "late caller abort", token: Symbol("opaque") };
  let commandEntered!: () => void;
  const commandStarted = new Promise<void>((resolve) => {
    commandEntered = resolve;
  });
  let cleanupEntered!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    cleanupEntered = resolve;
  });
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let stopCalls = 0;
  const fake = createFakeSpawner((_child, _token, command) => {
    if (command.includes("auto-load off")) commandEntered();
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => {
      stopCalls += 1;
      if (stopCalls === 1) {
        cleanupEntered();
        await cleanupGate;
      }
      return {
        status: "incomplete",
        reason: "held fake cleanup remains uncertain",
      };
    },
  });

  const starting = manager.start(caller.signal);
  await commandStarted;
  const closing = manager.closeAll().catch(() => undefined);
  await cleanupStarted;
  caller.abort(callerReason);
  releaseCleanup();
  const started = await starting;

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error).toBeInstanceOf(AnalysisCancelledError);
    expect(started.error.cause).toBeInstanceOf(AnalysisCancelledError);
    expect(started.error.cause).not.toBe(callerReason);
    expect(started.error.cleanup).toEqual({
      reason: "held fake cleanup remains uncertain",
      resources: started.error.cleanupResources,
    });
    expect(started.error.cleanupIncomplete).toBe(true);
  }
  expect(stopCalls).toBeGreaterThanOrEqual(1);
  expect(fake.children[0]?.exitCode).toBeNull();
  await closing;
  expect(stopCalls).toBeGreaterThanOrEqual(2);
  expect(fake.children[0]?.exitCode).toBeNull();
});

it("classifies cancellation while asynchronous GDB ownership preparation is pending", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const spawnEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: {},
    spawnProcess: async (options) =>
      new Promise<never>((_resolve, reject) => {
        entered();
        options.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        );
      }),
  });
  const starting = manager.start(controller.signal);
  await spawnEntered;
  controller.abort();
  const started = await starting;
  expect(started).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
});

it("drains active GDB commands and rejects new commands before closeAll cleanup", async () => {
  let heldToken = "";
  let heldCommand = "";
  const fake = createFakeSpawner((_child, token, command) => {
    if (command.includes("held command")) {
      heldToken = token;
      heldCommand = command;
    } else
      _child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,groups=[]\n`
          : `${token}^done\n`,
      );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  const active = manager.execute(started.value.session_id, "held command");
  await expect.poll(() => heldToken).not.toBe("");
  const closing = manager.closeAll();
  const rejected = await manager.execute(
    started.value.session_id,
    "late command",
  );
  expect(rejected.ok).toBe(false);
  const duplicateClose = await manager.close(started.value.session_id);
  expect(duplicateClose).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError", operation: "close_gdb_session" },
  });
  expect(fake.children[0]?.killSignals).toEqual([]);
  fake.children[0]?.stdout.write(`${heldToken}^done\n`);
  expect((await active).ok).toBe(true);
  await closing;
  expect(heldCommand).toContain("held command");
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
});

it("rejects GDB commands queued before closeAll when their turn arrives", async () => {
  let heldToken = "";
  const commands: string[] = [];
  const fake = createFakeSpawner((child, token, command) => {
    commands.push(command);
    if (command.includes("held command")) heldToken = token;
    else
      child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,groups=[]\n`
          : `${token}^done\n`,
      );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => {
      fake.children[0]?.exit(null, "SIGTERM");
      return { status: "stopped" };
    },
  });
  const started = await expectGdbSessionStarted(manager);
  const active = manager.execute(started.value.session_id, "held command");
  await expect.poll(() => heldToken).not.toBe("");
  const queued = manager.execute(started.value.session_id, "run");
  const closing = manager.closeAll();
  fake.children[0]?.stdout.write(`${heldToken}^done\n`);
  expect((await active).ok).toBe(true);
  await expect(queued).resolves.toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      operation: "gdb_console",
      issues: [{ path: ["session_id"], reason: "invalid_value" }],
    },
  });
  await closing;
  expect(commands.some((command) => command.includes('"run"'))).toBe(false);
});

it("rejects GDB commands queued behind a session close", async () => {
  let heldToken = "";
  const commands: string[] = [];
  const fake = createFakeSpawner((child, token, command) => {
    commands.push(command);
    if (command.includes("held command")) heldToken = token;
    else
      child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,groups=[]\n`
          : `${token}^done\n`,
      );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    // The child exit event can arrive after stop reports success.
    stopProcess: async () => ({ status: "stopped" }),
  });
  const started = await expectGdbSessionStarted(manager);
  const active = manager.execute(started.value.session_id, "held command");
  await expect.poll(() => heldToken).not.toBe("");
  const closed = manager.close(started.value.session_id);
  const queued = manager.execute(started.value.session_id, "run");
  fake.children[0]?.stdout.write(`${heldToken}^done\n`);
  expect((await active).ok).toBe(true);
  expect((await closed).ok).toBe(true);
  await expect(queued).resolves.toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      operation: "gdb_console",
      issues: [{ path: ["session_id"], reason: "invalid_value" }],
    },
  });
  expect(commands.some((command) => command.includes('"run"'))).toBe(false);
});

it.each(["close", "retryCleanupFailures"] as const)(
  "blocks GDB commands during failed cleanup and retries through %s",
  async (retry) => {
    let heldToken = "";
    const commands: string[] = [];
    const fake = createFakeSpawner((child, token, command) => {
      commands.push(command);
      if (command.includes("held command")) heldToken = token;
      else
        child.stdout.write(
          command.includes("list-thread-groups")
            ? `${token}^done,groups=[]\n`
            : `${token}^done\n`,
        );
    });
    let finishStop!: () => void;
    const stopHeld = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    let stopCalls = 0;
    const manager = managerWithFakeSpawner(fake.spawnProcess, {
      stopProcess: async () => {
        stopCalls += 1;
        if (stopCalls === 1) {
          await stopHeld;
          return {
            status: "incomplete",
            reason: "simulated cleanup uncertainty",
          };
        }
        return { status: "stopped" };
      },
    });
    const started = await expectGdbSessionStarted(manager);
    const id = started.value.session_id;
    const active = manager.execute(id, "held command");
    await expect.poll(() => heldToken).not.toBe("");
    const closing = manager.close(id);
    const queued = manager.execute(id, "run");
    fake.children[0]?.stdout.write(`${heldToken}^done\n`);
    expect((await active).ok).toBe(true);
    await expect.poll(() => stopCalls).toBe(1);
    const unavailable = {
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        operation: "gdb_console",
        issues: [{ path: ["session_id"], reason: "invalid_value" }],
      },
    };
    // Finish the barrier before assertions so a regression cannot strand teardown.
    const duringStop = manager.execute(id, "run");
    finishStop();
    const closed = await closing;
    expect(closed).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    await expect(queued).resolves.toMatchObject(unavailable);
    await expect(duringStop).resolves.toMatchObject(unavailable);
    await expect(manager.execute(id, "run")).resolves.toMatchObject(
      unavailable,
    );
    expect(manager.status(id)?.state).toBe("closed");
    const commandsBeforeRetry = [...commands];
    expect(
      (
        await (retry === "close"
          ? manager.close(id)
          : manager.retryCleanupFailures())
      ).ok,
    ).toBe(true);
    expect(stopCalls).toBe(2);
    expect(commands).toEqual(commandsBeforeRetry);
    expect(commands.some((command) => command.includes('"run"'))).toBe(false);
    expect(manager.status(id)).toBeUndefined();
    if (!closed.ok) expect(closed.error.cleanupIncomplete).toBe(false);
  },
);

it.each([
  { name: "single inferior without TTY", verifiedTty: false, inferiorCount: 1 },
  {
    name: "multiple inferiors with verified TTY",
    verifiedTty: true,
    inferiorCount: 2,
  },
])(
  "allows explicit inferior remediation before destructive cleanup: $name",
  async ({ verifiedTty, inferiorCount }) => {
    const tty = "/dev/pts/42";
    const remainingInferiors = new Set(
      Array.from({ length: inferiorCount }, (_, index) => index + 1),
    );
    let selectedInferior = 1;
    let stopCalls = 0;
    const commands: string[] = [];
    const fake = createFakeSpawner((child, token, command) => {
      commands.push(command);
      const selection = /"inferior (\d+)"$/u.exec(command);
      if (selection !== null) selectedInferior = Number(selection[1]);
      if (command.includes('"detach"'))
        remainingInferiors.delete(selectedInferior);
      const groups = [...remainingInferiors]
        .map((id) => `{id="i${id}",pid="${122 + id}"}`)
        .join(",");
      child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,groups=[${groups}]\n`
          : command.includes("inferior-tty-show")
            ? `${token}^done,inferior_tty_terminal=${JSON.stringify(tty)}\n`
            : `${token}^done\n`,
      );
    });
    const manager = managerWithFakeSpawner(fake.spawnProcess, {
      stopProcess: async () => {
        stopCalls += 1;
        return remainingInferiors.size === 0
          ? { status: "stopped" }
          : {
              status: "incomplete",
              reason: "Inferior disposition is unresolved.",
            };
      },
    });
    const started = await expectGdbSessionStarted(
      manager,
      undefined,
      verifiedTty ? { inferiorTty: tty } : undefined,
    );
    const id = started.value.session_id;
    expect(manager.status(id)?.inferior_tty_verified).toBe(verifiedTty);
    const refused = await manager.close(id);
    expect(manager.status(id)?.state).toBe("ready");
    expect(refused).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError", retryable: true },
    });
    expect(stopCalls).toBe(0);
    expect(commands).not.toContain("-target-detach");
    expect(commands).not.toContain("-gdb-exit");
    expect(fake.children[0]?.killSignals).toEqual([]);
    for (let index = 1; index <= inferiorCount; index += 1) {
      expect((await manager.execute(id, `inferior ${index}`)).ok).toBe(true);
      expect((await manager.execute(id, "detach")).ok).toBe(true);
    }
    expect((await manager.close(id)).ok).toBe(true);
    expect(stopCalls).toBe(1);
    expect(manager.status(id)).toBeUndefined();
  },
);

it("rejects a duplicate GDB close queued behind a session close", async () => {
  let heldToken = "";
  const commands: string[] = [];
  let stopCalls = 0;
  const fake = createFakeSpawner((child, token, command) => {
    commands.push(command);
    if (command.includes("held command")) heldToken = token;
    else
      child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,groups=[]\n`
          : `${token}^done\n`,
      );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => {
      stopCalls += 1;
      return { status: "stopped" };
    },
  });
  const started = await expectGdbSessionStarted(manager);
  const active = manager.execute(started.value.session_id, "held command");
  await expect.poll(() => heldToken).not.toBe("");
  const closed = manager.close(started.value.session_id);
  const duplicate = manager.close(started.value.session_id);
  fake.children[0]?.stdout.write(`${heldToken}^done\n`);
  expect((await active).ok).toBe(true);
  await expect(closed).resolves.toMatchObject({
    ok: true,
    value: { target_state: "none_observed" },
  });
  await expect(duplicate).resolves.toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError", operation: "close_gdb_session" },
  });
  expect(
    commands.filter((command) => command.includes("-gdb-exit")),
  ).toHaveLength(1);
  expect(stopCalls).toBe(1);
});

it("enforces the per-session queue capacity while a GDB command is active", async () => {
  let heldToken = "";
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes("held-for-capacity")) heldToken = token;
    else if (command.includes("list-thread-groups"))
      child.stdout.write(`${token}^done,groups=[]\n`);
    else child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  const held = manager.execute(started.value.session_id, "held-for-capacity");
  await expect.poll(() => heldToken).not.toBe("");
  const queued = Array.from({ length: 15 }, (_, index) =>
    manager.execute(started.value.session_id, `queued-${index}`),
  );
  const overCapacity = await manager.execute(
    started.value.session_id,
    "over-capacity",
  );
  expect(overCapacity).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });

  fake.children[0]?.stdout.write(`${heldToken}^done\n`);
  expect((await held).ok).toBe(true);
  expect((await Promise.all(queued)).every((result) => result.ok)).toBe(true);
  expect((await manager.close(started.value.session_id)).ok).toBe(true);
  expect(manager.status(started.value.session_id)).toBeUndefined();
});

it("reports invalid UTF-8 in retained GDB stderr status", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  fake.children[0]?.stderr.write(Buffer.from([0xff]));
  await new Promise((resolve) => setImmediate(resolve));
  expect(manager.status(started.value.session_id)).toMatchObject({
    stderr: "�",
    stderr_invalid_utf8: true,
    recent_mi_records_truncated: false,
  });
});

it("reports invalid UTF-8 in retained GDB MI status", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  fake.children[0]?.stdout.write(Buffer.from([0xff, 0x0a]));
  await new Promise((resolve) => setImmediate(resolve));

  expect(manager.status(started.value.session_id)).toMatchObject({
    recent_mi_records: ["(gdb)", "1^done", "�"],
    mi_invalid_utf8: true,
  });
});

it.each([
  ["error", "GDB stdin stream failed: simulated stdin failure"],
  ["close", "GDB stdin stream closed unexpectedly."],
] as const)(
  "fails pending GDB commands when stdin emits %s",
  async (event, message) => {
    const fake = createFakeSpawner((child, token, command) => {
      if (!command.includes("held-command"))
        child.stdout.write(`${token}^done\n`);
    });
    const manager = managerWithFakeSpawner(fake.spawnProcess);
    const started = await expectGdbSessionStarted(manager);
    const stdin = fake.children[0]?.stdin;
    if (stdin === null || stdin === undefined)
      throw new Error("Expected GDB stdin");
    const commandSent = new Promise<void>((resolve) =>
      stdin.once("data", () => resolve()),
    );
    const pending = manager.execute(started.value.session_id, "held-command");
    await commandSent;

    if (event === "error")
      stdin.emit(event, new Error("simulated stdin failure"));
    else stdin.emit(event);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      pending.then((result) => ({ result })),
      new Promise<{ readonly timeout: true }>((resolve) => {
        timeout = setTimeout(() => resolve({ timeout: true }), 150);
      }),
    ]);
    clearTimeout(timeout);
    if ("timeout" in settled) {
      const child = fake.children[0];
      child?.exitLeader(9);
      child?.closeInheritedOutput();
      await pending;
      throw new Error(`GDB stdin ${event} did not settle the pending command`);
    }
    const failed = settled.result;
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).toContain(message);
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
  },
);

it("reports process exit rather than protocol failure when stdin closes afterward", async () => {
  const fake = createFakeSpawner((child, token, command) => {
    if (!command.includes("held-command"))
      child.stdout.write(`${token}^done\n`);
  });
  let stopCalls = 0;
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => {
      stopCalls += 1;
      return { status: "stopped" };
    },
  });
  const started = await expectGdbSessionStarted(manager);
  const child = fake.children[0];
  const stdin = child?.stdin;
  if (child === undefined || stdin === null || stdin === undefined)
    throw new Error("Expected GDB child and stdin");
  const commandSent = new Promise<void>((resolve) =>
    stdin.once("data", () => resolve()),
  );
  const pending = manager.execute(started.value.session_id, "held-command");
  await commandSent;

  child.exitLeader(7);
  stdin.emit("close");
  child.stdout.emit("end");

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    pending.then((result) => ({ result })),
    new Promise<{ readonly timeout: true }>((resolve) => {
      timeout = setTimeout(() => resolve({ timeout: true }), 150);
    }),
  ]);
  clearTimeout(timeout);
  if ("timeout" in settled) {
    child.closeInheritedOutput();
    await pending;
    throw new Error("GDB process exit did not settle the command promptly");
  }
  const failed = settled.result;

  expect(failed).toMatchObject({
    ok: true,
    value: {
      result: {
        process_exit_observed: true,
        process_exit_code: 7,
        completion_status: "unknown",
      },
      evidence: {
        limitations: expect.arrayContaining([
          "GDB exited before returning a correlated MI result record; only records retained for the active command are returned raw.",
        ]),
      },
    },
  });
  // Process-exit Evidence is returned only after the owned debugger stop is
  // confirmed; stdin closing afterward must not bypass cleanup settlement.
  expect(stopCalls).toBe(1);
});

it("retains partial GDB command Evidence while an inherited writer remains", async () => {
  let writerActive = false;
  const fake = createFakeSpawner((_child, _token, command) => {
    if (command.includes("held-writer-command")) return;
    _child.stdout.write(`${_token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => ({
      status: "incomplete",
      reason: writerActive
        ? "an inherited output writer remains active"
        : "the owned GDB process was not confirmed stopped",
    }),
  });
  const started = await expectGdbSessionStarted(manager);
  const child = fake.children[0];
  if (child === undefined || child.stdin === null)
    throw new Error("Expected GDB child and stdin");
  const stdin = child.stdin;
  const commandSent = new Promise<void>((resolve) =>
    stdin.once("data", () => resolve()),
  );
  const pending = manager.execute(
    started.value.session_id,
    "held-writer-command",
  );
  await commandSent;

  writerActive = true;
  child.stdout.write("~partial output from owned writer\n");
  child.exitLeader(7);
  const result = await pending;

  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      cleanupIncomplete: true,
      cleanup: {
        reason: "an inherited output writer remains active",
        resources: [started.value.session_id],
      },
      partialObservation: {
        normalized_result: {
          process_exit_observed: true,
          completion_status: "unknown",
        },
        raw_result: { process_exit_observed: true },
      },
    },
  });
  expect(manager.status(started.value.session_id)?.state).toBe("closed");
  child.stdout.write("~late writer output\n");
  writerActive = false;
  child.closeInheritedOutput();
});

it("converts non-Error queue cancellation failures into a tagged error", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  const signal = {
    aborted: false,
    addEventListener: () => {
      throw "opaque listener failure";
    },
    removeEventListener: () => undefined,
  } as unknown as AbortSignal;

  const result = await manager.execute(
    started.value.session_id,
    "show version",
    signal,
  );

  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect((await manager.close(started.value.session_id)).ok).toBe(true);
});

it("waits for GDB stdout settlement after a no-inferior exit without re-entering MI", async () => {
  const commands: string[] = [];
  const fake = createFakeSpawner((child, token, command) => {
    commands.push(command);
    if (command.includes("list-thread-groups"))
      child.stdout.write(`${token}^done,groups=[]\n`);
    else if (command.includes("gdb-exit")) {
      child.stdout.write(`${token}^exit\n`);
      queueMicrotask(() => child.exit(0, null));
    } else child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  const closed = await manager.close(started.value.session_id);
  expect(closed).toMatchObject({
    ok: true,
    value: { target_state: "none_observed" },
  });
  expect(
    commands.filter((command) => command.includes("list-thread-groups")),
  ).toHaveLength(1);
  expect(commands).toContain("-gdb-exit");
});

it("closes an idle session when its quoted executable contains groups=[", async () => {
  const commands: string[] = [];
  const fake = createFakeSpawner((child, token, command) => {
    commands.push(command);
    if (command.includes("list-thread-groups"))
      child.stdout.write(
        `${token}^done,groups=[{id="i1",executable="fixture/groups=[.out"}]\n`,
      );
    else if (command.includes("gdb-exit")) {
      child.stdout.write(`${token}^exit\n`);
      queueMicrotask(() => child.exit(0, null));
    } else child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  const closed = await manager.close(started.value.session_id);

  expect(closed).toMatchObject({
    ok: true,
    value: { target_state: "none_observed" },
  });
  expect(
    commands.filter((command) => command.includes("list-thread-groups")),
  ).toHaveLength(1);
  expect(commands).toContain("-gdb-exit");
}, 10_000);

it("releases binary open only after an exited GDB inferior is proven ended", async () => {
  const [target, replacement] = await createBinarySessionTargets();
  const binarySession = createTestBinarySession(createCacheProvider([]));
  expect((await binarySession.open(target)).ok).toBe(true);
  const inferiorPid = "424242";
  let inferiorAlive = true;
  let identityCaptured!: () => void;
  const captured = new Promise<void>((resolve) => {
    identityCaptured = resolve;
  });
  let running!: () => void;
  const observedRun = new Promise<void>((resolve) => {
    running = resolve;
  });
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes('console "run"')) {
      child.stdout.write(
        `=thread-group-started,id="i1",pid="${inferiorPid}"\n${token}^running\n*running,thread-id="all"\n`,
      );
      running();
    } else child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    readInferiorProcessStartTime: async (pid) => {
      if (pid !== inferiorPid || !inferiorAlive) return null;
      identityCaptured();
      return "inferior-start-time";
    },
  });
  const started = await expectGdbSessionStarted(manager);
  const run = manager.execute(started.value.session_id, "run");
  await observedRun;
  await new Promise<void>((resolve) => setImmediate(resolve));

  let ownerSettled = false;
  const gdbOwnerCompletion = manager.waitForInferiorStop(
    started.value.session_id,
  );
  void gdbOwnerCompletion.then(() => {
    ownerSettled = true;
  });
  binarySession.retainExternalMutationOwner(gdbOwnerCompletion);
  let openingSettled = false;
  const opening = binarySession.open(replacement).then((result) => {
    openingSettled = true;
    return result;
  });
  await captured;
  fake.children[0]?.exitLeader(9);
  fake.children[0]?.closeInheritedOutput();
  await run;
  const closeResult = await manager.close(started.value.session_id);
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(closeResult.ok).toBe(false);
  expect(manager.status(started.value.session_id)).toBeDefined();
  expect(ownerSettled).toBe(false);
  expect(openingSettled).toBe(false);
  expect(binarySession.activeTarget()?.path).toBe(target);

  inferiorAlive = false;
  const retryResult = await manager.close(started.value.session_id);
  expect(retryResult).toMatchObject({
    ok: true,
    value: { target_state: "none_observed" },
  });
  expect(manager.status(started.value.session_id)).toBeUndefined();
  await gdbOwnerCompletion;
  expect(ownerSettled).toBe(true);
  expect((await opening).ok).toBe(true);
  await binarySession.close();
}, 10_000);

it("retains the inferior identity across continue when GDB exits", async () => {
  const inferiorPid = "424243";
  let alive = true;
  let identityReads = 0;
  let continueWasDispatched!: () => void;
  const continued = new Promise<void>((resolve) => {
    continueWasDispatched = resolve;
  });
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes('console "run"'))
      child.stdout.write(
        `=thread-group-started,id="i1",pid="${inferiorPid}"\n${token}^running\n*running,thread-id="all"\n*stopped,reason="breakpoint-hit",thread-id="1",stopped-threads="all"\n`,
      );
    else if (command.includes('console "continue"')) {
      continueWasDispatched();
      child.stdout.write(`${token}^running\n*running,thread-id="all"\n`);
    } else child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    readInferiorProcessStartTime: async (pid) => {
      identityReads += 1;
      return pid === inferiorPid && alive ? "continued-inferior" : null;
    },
  });
  const started = await expectGdbSessionStarted(manager);
  expect((await manager.execute(started.value.session_id, "run")).ok).toBe(
    true,
  );
  const resumed = manager.execute(started.value.session_id, "continue");
  await continued;
  fake.children[0]?.exitLeader(9);
  fake.children[0]?.closeInheritedOutput();
  await resumed;

  alive = false;
  const closed = await manager.close(started.value.session_id);
  expect(identityReads).toBeGreaterThan(0);
  expect(closed.ok).toBe(true);
}, 10_000);

it("retains incomplete identity capture across continue and debugger exit", async () => {
  const capturedPid = "424244";
  const uncapturedPid = "424245";
  let alive = true;
  let continueWasDispatched!: () => void;
  const continued = new Promise<void>((resolve) => {
    continueWasDispatched = resolve;
  });
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes('console "run"'))
      child.stdout.write(
        `=thread-group-started,id="i1",pid="${capturedPid}"\n=thread-group-started,id="i2",pid="${uncapturedPid}"\n${token}^running\n*running,thread-id="all"\n*stopped,reason="breakpoint-hit",thread-id="1",stopped-threads="all"\n`,
      );
    else if (command.includes('console "continue"')) {
      continueWasDispatched();
      child.stdout.write(`${token}^running\n*running,thread-id="all"\n`);
    } else child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    readInferiorProcessStartTime: async (pid) =>
      pid === capturedPid && alive ? "captured-inferior" : null,
  });
  const started = await expectGdbSessionStarted(manager);
  expect((await manager.execute(started.value.session_id, "run")).ok).toBe(
    true,
  );
  const resumed = manager.execute(started.value.session_id, "continue");
  await continued;
  alive = false;
  fake.children[0]?.exitLeader(9);
  fake.children[0]?.closeInheritedOutput();
  await resumed;

  const closed = await manager.close(started.value.session_id);
  expect(closed.ok).toBe(false);
  expect(manager.status(started.value.session_id)).toBeDefined();
}, 10_000);

it("retains captured inferior identity across inspection and a later run", async () => {
  const firstPid = "424246";
  const secondPid = "424247";
  let alive = true;
  let runs = 0;
  let currentPid = firstPid;
  let continueWasDispatched!: () => void;
  const continued = new Promise<void>((resolve) => {
    continueWasDispatched = resolve;
  });
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes('console "run"')) {
      runs += 1;
      currentPid = runs === 1 ? firstPid : secondPid;
      child.stdout.write(
        `=thread-group-started,id="i${runs}",pid="${currentPid}"\n${token}^running\n*running,thread-id="all"\n*stopped,reason="breakpoint-hit",thread-id="1",stopped-threads="all"\n`,
      );
    } else if (command.includes('console "continue"')) {
      continueWasDispatched();
      child.stdout.write(`${token}^running\n*running,thread-id="all"\n`);
    } else child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    readInferiorProcessStartTime: async (pid) =>
      pid === currentPid && alive ? `inferior-${pid}` : null,
  });
  const started = await expectGdbSessionStarted(manager);
  expect((await manager.execute(started.value.session_id, "run")).ok).toBe(
    true,
  );
  expect(
    (await manager.execute(started.value.session_id, "info registers")).ok,
  ).toBe(true);
  expect((await manager.execute(started.value.session_id, "run")).ok).toBe(
    true,
  );
  const resumed = manager.execute(started.value.session_id, "continue");
  await continued;
  alive = false;
  fake.children[0]?.exitLeader(9);
  fake.children[0]?.closeInheritedOutput();
  await resumed;

  expect((await manager.close(started.value.session_id)).ok).toBe(true);
}, 10_000);

it("does not release target ownership when kill covers only one known inferior", async () => {
  const fake = createFakeSpawner((_child, token) => {
    fake.children[0]?.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    readInferiorProcessStartTime: async () => "multi-inferior-start",
  });
  const started = await expectGdbSessionStarted(manager);
  fake.children[0]?.stdout.write(
    '=thread-group-started,id="i1",pid="424251"\n=thread-group-started,id="i2",pid="424252"\n*running,thread-id="all"\n',
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const killed = await manager.execute(started.value.session_id, "kill");
  expect(killed.ok).toBe(true);

  let settled = false;
  const owner = manager
    .waitForInferiorStop(started.value.session_id)
    .then(() => {
      settled = true;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(manager.status(started.value.session_id)).toBeDefined();
  fake.children[0]?.stdout.write(
    '*stopped,reason="exited",stopped-threads="all"\n',
  );
  await owner;
}, 10_000);

it("does not release target ownership when a thread group has no captured PID", async () => {
  const fake = createFakeSpawner((_child, token) => {
    fake.children[0]?.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  fake.children[0]?.stdout.write(
    '=thread-group-started,id="i1",pid="424253"\n=thread-group-started,id="i2"\n*running,thread-id="all"\n',
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect((await manager.execute(started.value.session_id, "kill")).ok).toBe(
    true,
  );
  const owner = manager.waitForInferiorStop(started.value.session_id);
  let settled = false;
  void owner.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);

  fake.children[0]?.stdout.write(
    '*stopped,reason="exited",stopped-threads="all"\n',
  );
  await owner;
}, 10_000);

it("fails closed when target disposition races unresolved inferior identities", async () => {
  let finishIdentityReads!: () => void;
  const identityReads = new Promise<void>((resolve) => {
    finishIdentityReads = resolve;
  });
  const fake = createFakeSpawner((_child, token) => {
    fake.children[0]?.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    readInferiorProcessStartTime: async () => {
      await identityReads;
      return "pending-multi-inferior";
    },
  });
  const started = await expectGdbSessionStarted(manager);
  fake.children[0]?.stdout.write(
    '=thread-group-started,id="i1",pid="424261"\n=thread-group-started,id="i2",pid="424262"\n*running,thread-id="all"\n',
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const ownerSettled = manager.waitForInferiorStop(started.value.session_id);
  let settled = false;
  void ownerSettled.then(() => {
    settled = true;
  });

  expect((await manager.execute(started.value.session_id, "kill")).ok).toBe(
    true,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);

  finishIdentityReads();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  fake.children[0]?.stdout.write(
    '*stopped,reason="exited",stopped-threads="all"\n',
  );
  await ownerSettled;
}, 10_000);

it("keeps evaluated remote target unknown after GDB exits despite a local PID collision", async () => {
  const inferiorPid = "424242";
  let identityReads = 0;
  let coincidentalLocalProcessAlive = true;
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes('console "run"'))
      child.stdout.write(
        `=thread-group-started,id="i1",pid="${inferiorPid}"\n${token}^running\n*running,thread-id="all"\n`,
      );
    else child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    readInferiorProcessStartTime: async () => {
      identityReads += 1;
      return coincidentalLocalProcessAlive
        ? "coincidental-local-process"
        : null;
    },
  });
  const started = await expectGdbSessionStarted(manager);
  expect(
    (
      await manager.execute(
        started.value.session_id,
        'eval "target extended-remote %s", "localhost:1234"',
      )
    ).ok,
  ).toBe(true);
  const run = manager.execute(started.value.session_id, "run");
  fake.children[0]?.exitLeader(9);
  fake.children[0]?.closeInheritedOutput();
  await run;

  const closeResult = await manager.close(started.value.session_id);
  expect(closeResult.ok).toBe(false);
  expect(identityReads).toBe(0);
  expect(manager.status(started.value.session_id)).toBeDefined();
  coincidentalLocalProcessAlive = false;
  expect((await manager.close(started.value.session_id)).ok).toBe(false);
  expect(identityReads).toBe(0);
  expect(manager.status(started.value.session_id)).toBeDefined();
}, 10_000);

it("keeps target identity untrusted after the `sou` source abbreviation", async () => {
  const [target, replacement] = await createBinarySessionTargets();
  const binarySession = createTestBinarySession(createCacheProvider([]));
  expect((await binarySession.open(target)).ok).toBe(true);
  const inferiorPid = "424242";
  let localProcessAlive = true;
  let identityReads = 0;
  let runStarted!: () => void;
  const observedRun = new Promise<void>((resolve) => {
    runStarted = resolve;
  });
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes('console "run"')) {
      child.stdout.write(
        `=thread-group-started,id="i1",pid="${inferiorPid}"\n${token}^running\n*running,thread-id="all"\n`,
      );
      runStarted();
    } else child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    readInferiorProcessStartTime: async () => {
      identityReads += 1;
      return localProcessAlive ? "coincidental-local-process" : null;
    },
  });
  const started = await expectGdbSessionStarted(manager);
  expect(
    (await manager.execute(started.value.session_id, "sou /tmp/remote.gdb")).ok,
  ).toBe(true);
  const run = manager.execute(started.value.session_id, "run");
  await observedRun;
  await new Promise<void>((resolve) => setImmediate(resolve));

  const releaseForTestCleanup = createDeferred<void>();
  let ownerSettled = false;
  const ownerCompletion = manager.waitForInferiorStop(started.value.session_id);
  void ownerCompletion.then(() => {
    ownerSettled = true;
  });
  binarySession.retainExternalMutationOwner(
    Promise.race([ownerCompletion, releaseForTestCleanup.promise]),
  );
  let openingSettled = false;
  const opening = binarySession.open(replacement).then((result) => {
    openingSettled = true;
    return result;
  });
  fake.children[0]?.exitLeader(9);
  fake.children[0]?.closeInheritedOutput();
  await run;
  localProcessAlive = false;

  expect((await manager.close(started.value.session_id)).ok).toBe(false);
  expect(identityReads).toBe(0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(ownerSettled).toBe(false);
  expect(openingSettled).toBe(false);
  expect(binarySession.activeTarget()?.path).toBe(target);

  releaseForTestCleanup.resolve();
  expect((await opening).ok).toBe(true);
  await binarySession.close();
}, 10_000);

it("ignores stale inferior identity reads when a PID is reused", async () => {
  const [target, replacement] = await createBinarySessionTargets();
  const binarySession = createTestBinarySession(createCacheProvider([]));
  expect((await binarySession.open(target)).ok).toBe(true);
  const inferiorPid = "424242";
  const staleRead = createDeferred<string | null>();
  const currentRead = createDeferred<string | null>();
  const staleReadStarted = createDeferred<void>();
  const currentReadStarted = createDeferred<void>();
  let identityReads = 0;
  let inferiorAlive = true;
  let currentStartTime = "new-start-time";
  let runCount = 0;
  const fake = createFakeSpawner((child, token, command) => {
    if (!command.includes('console "run"')) {
      child.stdout.write(`${token}^done\n`);
      return;
    }
    runCount += 1;
    child.stdout.write(
      `=thread-group-started,id="i1",pid="${inferiorPid}"\n${token}^running\n*running,thread-id="all"\n`,
    );
    if (runCount === 1)
      child.stdout.write(
        '*stopped,reason="exited-normally",stopped-threads="all"\n',
      );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    readInferiorProcessStartTime: async (pid) => {
      if (pid !== inferiorPid) return null;
      identityReads += 1;
      if (identityReads === 1) {
        staleReadStarted.resolve();
        return staleRead.promise;
      }
      if (identityReads === 2) {
        currentReadStarted.resolve();
        return currentRead.promise;
      }
      return inferiorAlive ? currentStartTime : null;
    },
  });
  const started = await expectGdbSessionStarted(manager);
  expect((await manager.execute(started.value.session_id, "run")).ok).toBe(
    true,
  );
  await staleReadStarted.promise;
  const activeRun = manager.execute(started.value.session_id, "run");
  await currentReadStarted.promise;
  currentRead.resolve(currentStartTime);
  await new Promise<void>((resolve) => setImmediate(resolve));
  staleRead.resolve("old-start-time");
  await new Promise<void>((resolve) => setImmediate(resolve));

  let ownerSettled = false;
  const ownerCompletion = manager.waitForInferiorStop(started.value.session_id);
  void ownerCompletion.then(() => {
    ownerSettled = true;
  });
  binarySession.retainExternalMutationOwner(ownerCompletion);
  let openingSettled = false;
  const opening = binarySession.open(replacement).then((result) => {
    openingSettled = true;
    return result;
  });
  fake.children[0]?.exitLeader(9);
  fake.children[0]?.closeInheritedOutput();
  await activeRun;

  expect((await manager.close(started.value.session_id)).ok).toBe(false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(ownerSettled).toBe(false);
  expect(openingSettled).toBe(false);
  expect(binarySession.activeTarget()?.path).toBe(target);

  inferiorAlive = false;
  currentStartTime = "";
  expect(await manager.close(started.value.session_id)).toMatchObject({
    ok: true,
    value: { target_state: "none_observed" },
  });
  await ownerCompletion;
  expect(ownerSettled).toBe(true);
  expect((await opening).ok).toBe(true);
  await binarySession.close();
}, 10_000);

it("reports incomplete stop if GDB exits while close waits in the serialized queue", async () => {
  let heldToken = "";
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes("held-before-close")) heldToken = token;
    else if (command.includes("list-thread-groups"))
      child.stdout.write(`${token}^done,groups=[]\n`);
    else child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => ({
      status: "incomplete",
      reason: "GDB exited before queued close could verify cleanup",
    }),
  });
  const started = await expectGdbSessionStarted(manager);
  const active = manager.execute(started.value.session_id, "held-before-close");
  await expect.poll(() => heldToken).not.toBe("");
  const closing = manager.close(started.value.session_id);
  fake.children[0]?.exitLeader(9);
  const activeResult = await active;
  expect(activeResult).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      cleanupIncomplete: true,
      partialObservation: expect.objectContaining({
        normalized_result: expect.objectContaining({
          process_exit_observed: true,
        }),
      }),
    },
  });

  const closed = await closing;

  expect(closed).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  if (!closed.ok)
    expect(closed.error).toMatchObject({
      providerId: "gdb",
      operation: "close_gdb_session",
    });
});

it("configures and verifies the caller-selected inferior TTY before reporting ready", async () => {
  const tty = '/dev/pts/42 "🚀"';
  const miTty = tty.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const commands: string[] = [];
  const fake = createFakeSpawner((_child, token, command) => {
    commands.push(command);
    if (command.includes("inferior-tty-show"))
      _child.stdout.write(`${token}^done,inferior_tty_terminal="${miTty}"\n`);
    else if (command.includes("list-thread-groups"))
      _child.stdout.write(`${token}^done,groups=[]\n`);
    else _child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start(undefined, { inferiorTty: tty });

  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const status = manager.status(started.value.session_id);
  expect(status).toMatchObject({
    inferior_tty: tty,
    inferior_tty_verified: true,
  });
  expect(
    commands.indexOf(`-inferior-tty-set ${JSON.stringify(tty)}`),
  ).toBeGreaterThan(-1);
  expect(commands.indexOf("-inferior-tty-show")).toBeGreaterThan(
    commands.indexOf(`-inferior-tty-set ${JSON.stringify(tty)}`),
  );
});

it("rejects a GDB leader exit without a verified sink and retains inherited output", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  const child = fake.children[0];
  if (child === undefined) throw new Error("Expected GDB child");
  child.exitLeader(7);

  const closed = await manager.close(started.value.session_id);

  expect(closed.ok).toBe(false);
  expect(manager.status(started.value.session_id)).toMatchObject({
    state: "closed",
    inferior_tty: null,
    inferior_tty_verified: false,
  });
  expect(child.killSignals).toEqual([]);
  child.stdout.write("=thread-group-exited,id=descendant-sentinel\n");
  child.closeInheritedOutput();
  expect(manager.status(started.value.session_id)?.recent_mi_records).toContain(
    "=thread-group-exited,id=descendant-sentinel",
  );
});

it("does not infer detached state when the inferior verifier observes an exited GDB", async () => {
  let detachFailure = "";
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async (session) => {
      const debuggerSession = session as typeof session & {
        detachInferior: () => Promise<unknown>;
      };
      try {
        await debuggerSession.detachInferior();
      } catch (cause) {
        detachFailure = cause instanceof Error ? cause.message : String(cause);
      }
      return {
        status: "incomplete",
        reason: "the inferior state remained unknown",
      };
    },
  });
  const started = await expectGdbSessionStarted(manager);
  expect(
    (await manager.execute(started.value.session_id, "set pagination off")).ok,
  ).toBe(true);
  fake.children[0]?.exitLeader(7);

  const closed = await manager.close(started.value.session_id);

  expect(closed.ok).toBe(false);
  expect(detachFailure).toBe(
    "GDB exited before inferior state could be verified.",
  );
});

it("retains the GDB session while an unknown descendant holds output after leader exit", async () => {
  directory ??= await mkdtemp(join(tmpdir(), "rea-gdb-coverage-"));
  const tty = join(directory, "inferior-output");
  await writeFile(tty, "");
  const fake = createFakeSpawner((_child, token, command) => {
    if (command.includes("inferior-tty-show"))
      fake.children[0]?.stdout.write(
        `${token}^done,inferior_tty_terminal=${JSON.stringify(tty)}\n`,
      );
    else if (command.includes("list-thread-groups"))
      fake.children[0]?.stdout.write(`${token}^done,groups=[]\n`);
    else fake.children[0]?.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager, undefined, {
    inferiorTty: tty,
  });
  const child = fake.children[0];
  if (child === undefined) throw new Error("Expected GDB child");
  expect(manager.status(started.value.session_id)?.inferior_tty_verified).toBe(
    true,
  );
  child.exitLeader(7);

  const firstClose = await manager.close(started.value.session_id);
  expect(firstClose.ok).toBe(false);
  if (!firstClose.ok) {
    expect(firstClose.error.cleanupIncomplete).toBe(true);
    expect(firstClose.error.message).toMatch(/inferior disposition/i);
  }
  expect(manager.status(started.value.session_id)).toBeDefined();
  await writeFile(tty, "descendant sentinel after GDB leader exit\n");
  child.closeInheritedOutput();
  const closed = await manager.close(started.value.session_id);

  expect(closed).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(await readFile(tty, "utf8")).toBe(
    "descendant sentinel after GDB leader exit\n",
  );
  expect(manager.status(started.value.session_id)).toBeDefined();
  expect(child.killSignals).toEqual([]);
});

it("retries close after an exited GDB's inherited output streams settle", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  const child = fake.children[0];
  if (child === undefined) throw new Error("Expected GDB child");

  child.exitLeader(3);
  const firstClose = await manager.close(started.value.session_id);
  expect(firstClose.ok).toBe(false);
  if (!firstClose.ok)
    expect(firstClose.error.message).toMatch(/inferior disposition/i);
  expect(manager.status(started.value.session_id)).toBeDefined();

  child.closeInheritedOutput();
  await expect(manager.close(started.value.session_id)).resolves.toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(manager.status(started.value.session_id)).toBeDefined();
});

it("shares a single stop attempt across concurrent closes after GDB exits", async () => {
  let resolveStop!: (result: { status: "incomplete"; reason: string }) => void;
  let stopCalls = 0;
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => {
      stopCalls += 1;
      if (stopCalls > 1)
        return {
          status: "incomplete",
          reason: "shared stop attempt is uncertain",
        };
      return await new Promise((resolve) => {
        resolveStop = resolve;
      });
    },
  });
  const started = await expectGdbSessionStarted(manager);
  fake.children[0]?.exitLeader(7);

  const firstClose = manager.close(started.value.session_id);
  await expect.poll(() => stopCalls).toBe(1);
  const secondClose = manager.close(started.value.session_id);
  await new Promise((resolve) => setImmediate(resolve));
  expect(stopCalls).toBe(1);
  resolveStop({
    status: "incomplete",
    reason: "shared stop attempt is uncertain",
  });

  const [first, second] = await Promise.all([firstClose, secondClose]);
  expect(first.ok).toBe(false);
  expect(second.ok).toBe(false);
  expect(stopCalls).toBe(1);
});

it("rejects inferior TTY configuration when GDB reports a different terminal", async () => {
  const fake = createFakeSpawner((child, token, command) => {
    child.stdout.write(
      command.includes("inferior-tty-show")
        ? `${token}^done,inferior_tty_terminal="/dev/pts/other"\n`
        : command.includes("list-thread-groups")
          ? `${token}^done,groups=[]\n`
          : `${token}^done\n`,
    );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start(undefined, {
    inferiorTty: "/dev/pts/requested",
  });

  expect(started.ok).toBe(false);
  if (!started.ok)
    expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
  expect(
    fake.children.every((child) => child.killSignals.includes("SIGTERM")),
  ).toBe(true);
});

it("rejects an inferior TTY when GDB does not confirm the setting command", async () => {
  const commands: string[] = [];
  const fake = createFakeSpawner((child, token, command) => {
    commands.push(command);
    child.stdout.write(
      command.includes("inferior-tty-set")
        ? `${token}^error,msg="unsupported"\n`
        : `${token}^done\n`,
    );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start(undefined, {
    inferiorTty: "/dev/pts/requested",
  });

  expect(started).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  expect(commands).toContain('-inferior-tty-set "/dev/pts/requested"');
  expect(commands).not.toContain("-inferior-tty-show");
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
});

it("rejects a truncated inferior TTY readback before publishing the session", async () => {
  const tty = `/dev/pts/${"x".repeat(200)}`;
  const fake = createFakeSpawner((child, token, command) => {
    child.stdout.write(
      command.includes("inferior-tty-show")
        ? `${token}^done,inferior_tty_terminal=${JSON.stringify(tty)}\n`
        : `${token}^done\n`,
    );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    controlReplyBytes: 80,
  });

  const started = await manager.start(undefined, { inferiorTty: tty });

  expect(started).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
});

it("keeps inferior TTY readback when the caller output cap is smaller than that reply", async () => {
  const tty = `/dev/pts/${"x".repeat(200)}`;
  const fake = createFakeSpawner((child, token, command) => {
    child.stdout.write(
      command.includes("inferior-tty-show")
        ? `${token}^done,inferior_tty_terminal=${JSON.stringify(tty)}\n`
        : `${token}^done\n`,
    );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    maxCommandOutputBytes: 80,
  });

  const started = await manager.start(undefined, { inferiorTty: tty });

  if (!started.ok) throw started.error;
  expect(started.value.mi_version).toMatch(/^mi[23]$/u);
  expect(started.value.session_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  );
});

it.each([
  ["trailing garbage", 'inferior_tty_terminal="/dev/pts/42"junk'],
  [
    "duplicate field",
    'inferior_tty_terminal="/dev/pts/42",inferior_tty_terminal="/dev/pts/42"',
  ],
])("rejects MI inferior TTY readback with %s", async (_label, fields) => {
  const fake = createFakeSpawner((child, token, command) => {
    child.stdout.write(
      command.includes("inferior-tty-show")
        ? `${token}^done,${fields}\n`
        : `${token}^done\n`,
    );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await manager.start(undefined, {
    inferiorTty: "/dev/pts/42",
  });
  expect(started.ok).toBe(false);
  if (!started.ok)
    expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
});

const managerWithFakeSpawner = (
  spawnProcess: (
    options: OwnedProviderProcessSpawnOptions,
  ) => Promise<SpawnedOwnedProviderProcess>,
  options: ConstructorParameters<typeof GdbSessionManager>[0] = {},
): GdbSessionManager => {
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: { REA_GDB_COMMAND: "fake-gdb" },
    spawnProcess,
    verifyInferiorOutputSink: async () => "durable",
    ...options,
  });
  managers.push(manager);
  return manager;
};

it("routes GDB stdout stream errors through protocol failure handling", async () => {
  let commandWritten!: () => void;
  const written = new Promise<void>((resolve) => {
    commandWritten = resolve;
  });
  const fake = createFakeSpawner((_child, _token, command) => {
    if (command.includes("auto-load off")) _child.stdout.write("1^done\n");
    else commandWritten();
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  const child = fake.children[0]!;
  const executing = manager.execute(started.value.session_id, "waiting");
  await written;

  child.stdout.emit("error", new Error("simulated stdout read failure"));

  await expect(executing).resolves.toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      message: expect.stringContaining("simulated stdout read failure"),
    },
  });
});

const startWithVerifiedInferiorTty = async (
  tty: string,
): Promise<{
  readonly manager: GdbSessionManager;
  readonly sessionId: string;
  readonly commands: string[];
}> => {
  const commands: string[] = [];
  const fake = createFakeSpawner((_child, token, command) => {
    commands.push(command);
    const response = command.includes("inferior-tty-show")
      ? `^done,inferior_tty_terminal=${JSON.stringify(tty)}`
      : command.includes("list-thread-groups")
        ? '^done,groups=[{id="i1",pid="123"}]'
        : "^done";
    fake.children[0]?.stdout.write(`${token}${response}\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await manager.start(undefined, { inferiorTty: tty });
  if (!started.ok) throw new Error("GDB did not start with its selected TTY");
  return { manager, sessionId: started.value.session_id, commands };
};

it.each([
  "run < input.txt",
  "run <&-",
  "run 0<&-",
  "run <&- --mode fast",
  "run 0<&- arg",
  "run < first.txt < second.txt",
  "run 0<&- < input.txt",
])(
  "retains detach proof for the input-only redirection %s",
  async (runCommand) => {
    const commands: string[] = [];
    let outputSinkChecks = 0;
    const fake = createFakeSpawner((_child, token, command) => {
      commands.push(command);
      const response = command.includes("inferior-tty-show")
        ? '^done,inferior_tty_terminal="/dev/pts/42"'
        : command.includes("list-thread-groups")
          ? '^done,groups=[{id="i1",pid="123"}]'
          : "^done";
      fake.children[0]?.stdout.write(`${token}${response}\n`);
    });
    const manager = managerWithFakeSpawner(fake.spawnProcess, {
      verifyInferiorOutputSink: async () => {
        outputSinkChecks += 1;
        // A regular file on stdin is independent of the durable selected output
        // terminal and is permitted by the production descriptor classifier.
        return "not-inherited";
      },
    });
    const started = await manager.start(undefined, {
      inferiorTty: "/dev/pts/42",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(
      (await manager.execute(started.value.session_id, runCommand)).ok,
    ).toBe(true);
    expect(
      manager.status(started.value.session_id)?.inferior_tty_verified,
    ).toBe(true);
    expect((await manager.close(started.value.session_id)).ok).toBe(true);
    expect(outputSinkChecks).toBe(1);
    expect(commands).toContain("-target-detach");
  },
);

const createProvider = async (body: string): Promise<string> => {
  directory ??= await mkdtemp(join(tmpdir(), "rea-gdb-coverage-"));
  const provider = join(directory, `fake-gdb-${managers.length}.mjs`);
  await writeFile(provider, `#!${process.execPath}\n${body}`);
  await chmod(provider, 0o700);
  return provider;
};

const managerFor = async (
  body: string,
  options: ConstructorParameters<typeof GdbSessionManager>[0] = {},
): Promise<GdbSessionManager> => {
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: { REA_GDB_COMMAND: await createProvider(body) },
    ...options,
    ...(options.spawnProcess === undefined
      ? { spawnProcess: providerSpawns.spawnProcess }
      : {}),
  });
  managers.push(manager);
  return manager;
};

const responsiveProvider = (
  handler = "if (match[2].includes('list-thread-groups')) process.stdout.write(match[1] + '^done,groups=[]\\n'); else process.stdout.write(match[1] + '^done\\n');",
): string => `
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    ${handler}
  }
});
`;

afterEach(async () => {
  await Promise.all(
    managers
      .splice(0)
      .map((manager) => manager.closeAll().catch(() => undefined)),
  );
  expect(await providerSpawns.killSurvivors()).toEqual([]);
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it("rejects a pre-cancelled GDB start and an unconfigured executable", async () => {
  const cancelled = new AbortController();
  const reason = new Error("caller cancelled before start");
  cancelled.abort(reason);
  const startResult = await new GdbSessionManager({ platform: "linux" }).start(
    cancelled.signal,
  );
  expect(startResult.ok).toBe(false);
  if (!startResult.ok) {
    expect(startResult.error._tag).toBe("AnalysisCancelledError");
    expect(startResult.error.cause).toBe(reason);
  }

  const nullReasonController = new AbortController();
  nullReasonController.abort(null);
  const nullReasonResult = await new GdbSessionManager({
    platform: "linux",
  }).start(nullReasonController.signal);
  expect(nullReasonResult.ok).toBe(false);
  if (!nullReasonResult.ok) expect(nullReasonResult.error.cause).toBeNull();

  const missing = await new GdbSessionManager({
    platform: "linux",
    environment: { REA_GDB_COMMAND: join(tmpdir(), "does-not-exist-gdb") },
  }).start();
  expect(missing.ok).toBe(false);
  if (!missing.ok) {
    expect(missing.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(missing.error.message).toContain("does-not-exist-gdb");
    expect(projectAnalysisError(missing.error)).toMatchObject({
      code: "capability_unavailable",
      message: expect.stringContaining("does-not-exist-gdb"),
      remediation: { action: expect.stringContaining("REA_GDB_COMMAND") },
      details: {
        diagnostics: {
          boundary: "provider-launch",
          command: join(tmpdir(), "does-not-exist-gdb"),
          system_code: "ENOENT",
        },
      },
    });
  }
});

it("restores the caller's run ID for the inferior through a startup directive", async () => {
  const seen: string[][] = [];
  const spawn = async (options: OwnedProviderProcessSpawnOptions) => {
    seen.push([...options.arguments]);
    return createFakeSpawner().spawnProcess(options);
  };
  for (const [environment, expected] of [
    [{}, "unset environment REA_PROCESS_RUN_ID"],
    [
      { REA_PROCESS_RUN_ID: "caller-run" },
      "set environment REA_PROCESS_RUN_ID =caller-run",
    ],
    [
      { REA_PROCESS_RUN_ID: "=caller-run" },
      "set environment REA_PROCESS_RUN_ID ==caller-run",
    ],
  ] as const) {
    seen.length = 0;
    const manager = new GdbSessionManager({
      platform: "linux",
      environment,
      spawnProcess: spawn,
    });
    managers.push(manager);
    await manager.start();
    expect(seen[0]).toContain("-iex");
    expect(seen[0]?.at(-1)).toBe(expected);
  }
});

it.each([
  "a\nb",
  "a\rb",
  " caller-run",
  "\tcaller-run",
  "caller-run ",
  "caller-run\t",
])(
  "refuses a caller run ID that cannot be expressed as one directive: %j",
  async (runId) => {
    const manager = new GdbSessionManager({
      platform: "linux",
      environment: { REA_PROCESS_RUN_ID: runId },
      spawnProcess: async () => {
        throw new Error("must not spawn");
      },
    });
    managers.push(manager);

    const started = await manager.start();

    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.error.message).toContain("cannot be preserved");
    }
  },
);

it("retries MI2 after an MI3 process exits before its startup prompt", async () => {
  const provider = await createProvider(`
if (process.argv.includes('--interpreter=mi3')) process.exit(0);
${responsiveProvider()}
`);
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: { REA_GDB_COMMAND: provider },
  });
  managers.push(manager);

  const started = await manager.start();

  expect(started.ok).toBe(true);
  if (started.ok) expect(started.value.mi_version).toBe("mi2");
});

it("keeps the MI3 startup failure when the MI2 fallback also fails", async () => {
  const provider = await createProvider(`
if (process.argv.includes('--interpreter=mi3')) {
  process.stderr.write('mi3 startup diagnostic\\n');
}
process.exit(3);
`);
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: { REA_GDB_COMMAND: provider },
  });
  managers.push(manager);

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error.diagnostics).toHaveProperty("mi3_startup_error");
    expect(JSON.stringify(started.error.diagnostics)).toContain(
      "mi3 startup diagnostic",
    );
  }
});

it("retains ownership when GDB startup fails before its prompt and stop is incomplete", async () => {
  let stopCalls = 0;
  let retainedSessionId: string | undefined;
  const provider = await createProvider("process.exit(0);\n");
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: { REA_GDB_COMMAND: provider },
    stopProcess: async (session, name) => {
      stopCalls += 1;
      if (stopCalls === 1) {
        retainedSessionId = (session as typeof session & { id: string }).id;
        return { status: "incomplete", reason: "simulated stop uncertainty" };
      }
      return stopOwnedDebuggerProcess(session, name);
    },
  });
  managers.push(manager);

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(started.error.message).toContain("simulated stop uncertainty");
  }
  expect(stopCalls).toBe(1);
  expect(manager.status(retainedSessionId ?? "")?.state).toBe("closed");
});

it.each([
  ["required auto-load configuration", "auto-load"],
  ["caller-selected inferior TTY", "tty"],
  ["late startup cancellation", "cancel"],
] as const)(
  "keeps an incompletely stopped failed startup unavailable and retriable after %s",
  async (_label, failure) => {
    const controller = new AbortController();
    const commands: string[] = [];
    let stopCalls = 0;
    const fake = createFakeSpawner((child, token, command) => {
      commands.push(command);
      if (failure === "auto-load" && command.includes("auto-load off")) {
        child.stdout.write(`${token}^error,msg="setting rejected"\n`);
      } else if (failure === "tty" && command.includes("inferior-tty-show")) {
        child.stdout.write(
          `${token}^done,inferior_tty_terminal="/dev/pts/8"\n`,
        );
      } else {
        child.stdout.write(`${token}^done\n`);
      }
      // The MI response is complete, but the startup continuation has not yet
      // observed it. This exercises cancellation between, not during, requests.
      if (failure === "cancel" && command.includes("auto-load off"))
        controller.abort();
    });
    const manager = managerWithFakeSpawner(fake.spawnProcess, {
      stopProcess: async (session, name) => {
        stopCalls += 1;
        return stopCalls === 1
          ? {
              status: "incomplete",
              reason: "simulated startup stop uncertainty",
            }
          : stopOwnedDebuggerProcess(session, name);
      },
    });

    const started = await manager.start(
      failure === "cancel" ? controller.signal : undefined,
      failure === "tty" ? { inferiorTty: "/dev/pts/7" } : {},
    );

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error._tag).toBe(
      failure === "cancel"
        ? "AnalysisCancelledError"
        : "AnalysisCapabilityUnavailableError",
    );
    expect(started.error.cause).toBeDefined();
    expect(started.error.partialObservation).toMatchObject({
      predicate_type: "rea.debugger.startup-observation",
    });
    expect(started.error.cleanup).toMatchObject({
      reason: "simulated startup stop uncertainty",
    });
    expect(started.error.cleanupIncomplete).toBe(true);
    const [sessionId] = started.error.cleanupResources;
    if (sessionId === undefined)
      throw new Error("Failed startup did not retain its GDB session ID.");
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(started.error.cleanup?.resources).toEqual([sessionId]);
    expect(stopCalls).toBe(1);
    expect(fake.children[0]?.exitCode).toBeNull();
    expect(manager.status(sessionId)?.state).toBe("closed");

    const command = await manager.execute(sessionId, "show version");
    expect(command).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
    expect(commands).not.toContain('-interpreter-exec console "show version"');
    expect(fake.children[0]?.exitCode).toBeNull();

    expect((await manager.retryCleanupFailures()).ok).toBe(true);
    expect(stopCalls).toBe(2);
    expect(started.error.cleanupIncomplete).toBe(false);
    expect(manager.status(sessionId)).toBeUndefined();
    expect(fake.children[0]?.exitCode).toBeNull();
    expect(fake.children[0]?.signalCode).toBe("SIGTERM");
  },
);

it("uses a fallback message when the process launcher rejects without an Error", async () => {
  let attempts = 0;
  const manager = managerWithFakeSpawner(async () => {
    attempts += 1;
    return Promise.reject("non-error launch failure");
  });

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(started.error.message).toContain("Unable to start GDB");
  }
  expect(attempts).toBe(2);
});

it("returns startup timeout when the MI prompt never arrives", async () => {
  const provider = await createProvider(
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: { REA_GDB_COMMAND: provider },
    startupTimeoutMs: 20,
  });
  managers.push(manager);

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error._tag).toBe("AnalysisTimeoutError");
    expect(started.error).toBeInstanceOf(AnalysisTimeoutError);
    if (started.error instanceof AnalysisTimeoutError)
      expect(started.error.operation).toBe("start_gdb_session");
  }
});

it("handles a provider with no MI stdout stream as a startup timeout", async () => {
  const fake = createFakeSpawner(undefined, { stdoutNull: true });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    startupTimeoutMs: 15,
  });

  const started = await manager.start();

  expect(started).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisTimeoutError", operation: "start_gdb_session" },
  });
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
});

it("preserves a timeout while startup waits for the automatic-loading response", async () => {
  const fake = createFakeSpawner((_child, _token, _command) => undefined);
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 25,
  });

  const started = await manager.start();

  if (started.ok) throw new Error("expected startup to time out");
  expect(started.error._tag).toBe("AnalysisTimeoutError");
  if (!(started.error instanceof AnalysisTimeoutError)) throw started.error;
  expect(started.error.operation).toBe("start_gdb_session");
  expect(projectAnalysisError(started.error)).toMatchObject({
    code: "provider_timeout",
    details: {
      diagnostics: {
        setting: DEBUGGER_COMMAND_DEADLINE_SETTING,
        effective_value: 25,
        source: "runtime",
        unit: "ms",
        restart_required: true,
      },
    },
  });
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
});

it("maps an acknowledged startup-command timeout to the startup operation", async () => {
  const fake = createFakeSpawner((_child, _token, _command) => undefined);
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 20,
    stopProcess: async () => ({ status: "stopped" }),
  });

  const started = await manager.start();

  expect(started).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisTimeoutError", operation: "start_gdb_session" },
  });
});

it("retains startup timeout without partial evidence when cleanup is uncertain", async () => {
  let stopCalls = 0;
  const provider = await createProvider(
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: { REA_GDB_COMMAND: provider },
    startupTimeoutMs: 20,
    stopProcess: async (session, name) => {
      stopCalls += 1;
      return stopCalls === 1
        ? {
            status: "incomplete",
            reason: "simulated startup timeout cleanup uncertainty",
          }
        : stopOwnedDebuggerProcess(session, name);
    },
  });
  managers.push(manager);

  const started = await manager.start();

  expect(started).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisTimeoutError",
      operation: "start_gdb_session",
      cleanup: { reason: "simulated startup timeout cleanup uncertainty" },
    },
  });
  if (!started.ok)
    expect(
      (started.error as AnalysisTimeoutError & { partialObservation?: unknown })
        .partialObservation,
    ).toBeUndefined();
});

it("maps startup command timeout and preserves initial no-inferior evidence when cleanup is uncertain", async () => {
  let detachResult: unknown;
  let retainedSessionId = "";
  const fake = createFakeSpawner((_child, _token, _command) => undefined);
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 25,
    stopProcess: async (session) => {
      retainedSessionId = (session as typeof session & { id: string }).id;
      const debuggerSession = session as typeof session & {
        detachInferior: () => Promise<unknown>;
      };
      detachResult = await debuggerSession.detachInferior();
      return {
        status: "incomplete",
        reason: "simulated startup cleanup uncertainty",
      };
    },
  });

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error).toBeInstanceOf(AnalysisTimeoutError);
    if (started.error instanceof AnalysisTimeoutError)
      expect(started.error.operation).toBe("start_gdb_session");
  }
  expect(detachResult).toEqual({ status: "no-inferior" });
  expect(retainedSessionId).not.toBe("");
  expect(manager.status(retainedSessionId)?.state).toBe("closed");
});

it("handles a start signal that becomes aborted during listener registration", async () => {
  const provider = await createProvider(responsiveProvider());
  const controller = new AbortController();
  let registrations = 0;
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === "addEventListener")
        return (...arguments_: Parameters<AbortSignal["addEventListener"]>) => {
          registrations += 1;
          if (registrations === 1) {
            controller.abort();
          }
          return target.addEventListener(...arguments_);
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: { REA_GDB_COMMAND: provider },
  });
  managers.push(manager);

  const started = await manager.start(signal);

  expect(registrations).toBe(1);
  expect(started.ok).toBe(false);
  if (!started.ok) expect(started.error._tag).toBe("AnalysisCancelledError");
});

it("handles cancellation after the automatic-loading response", async () => {
  const controller = new AbortController();
  const reason = { source: "caller after automatic loading" };
  const fake = createFakeSpawner((child, token, command) => {
    child.stdout.write(
      command.includes("list-thread-groups")
        ? `${token}^done,groups=[]\n`
        : `${token}^done\n`,
    );
    if (command.includes("auto-load off")) controller.abort(reason);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await manager.start(controller.signal);

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error._tag).toBe("AnalysisCancelledError");
    expect(started.error.cause).toBe(reason);
  }
});

it("reports an MI stream failure when the child has no stdin pipe", async () => {
  const fake = createFakeSpawner(undefined, { stdinEnabled: false });
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(started.error.message).toContain("input stream is closed");
  }
  expect(fake.children[0]?.exitCode).toBeNull();
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
  expect(fake.children[0]?.signalCode).toBe("SIGTERM");
});

it("preserves the protocol failure when owned-process stop is confirmed", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => ({ status: "stopped" }),
  });
  const started = await expectGdbSessionStarted(manager);
  const stdin = fake.children[0]?.stdin;
  if (stdin === null || stdin === undefined)
    throw new Error("Expected GDB stdin");
  stdin.write = (() => {
    throw new Error("injected MI stdin write failure");
  }) as typeof stdin.write;

  const result = await manager.execute(started.value.session_id, "fail-write");

  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      message: expect.stringContaining("injected MI stdin write failure"),
    },
  });
});

it("converts a closed stdin guard failure without partial MI records", async () => {
  const fake = createFakeSpawner((child, token, command) => {
    child.stdout.write(`${token}^done\n`);
    if (command.includes("auto-load off"))
      Object.defineProperty(child.stdin, "destroyed", { value: true });
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => ({ status: "stopped" }),
  });
  const started = await expectGdbSessionStarted(manager);
  expect(fake.children[0]?.stdin?.destroyed).toBe(true);

  const result = await manager.execute(started.value.session_id, "info files");

  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
});

it("fails pending commands when the child closes stdin unexpectedly", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  const stdin = fake.children[0]?.stdin;
  if (stdin === null || stdin === undefined)
    throw new Error("Expected GDB stdin");
  const inputClosed = new Promise<void>((resolve) =>
    stdin.once("close", resolve),
  );
  stdin.destroy();
  await inputClosed;

  expect(manager.status(started.value.session_id)?.state).toBe("closed");
  expect(
    (await manager.execute(started.value.session_id, "after-close")).ok,
  ).toBe(false);
});

it.each([
  ["throws an Error", "error"],
  ["throws a non-Error value", "non-error"],
  ["reports a callback write error", "callback"],
] as const)(
  "handles stdin write failure when the fake writer %s",
  async (_label, failure) => {
    const fake = createFakeSpawner();
    const manager = managerWithFakeSpawner(fake.spawnProcess);
    const started = await expectGdbSessionStarted(manager);
    const stdin = fake.children[0]?.stdin;
    if (stdin === null || stdin === undefined)
      throw new Error("Expected GDB stdin");
    const originalWrite = stdin.write.bind(stdin);
    Object.defineProperty(stdin, "write", {
      value: (...arguments_: unknown[]) => {
        const payload = String(arguments_[0]);
        if (!payload.includes("-interpreter-exec"))
          return Reflect.apply(originalWrite, stdin, arguments_);
        if (failure === "callback") {
          const callback = arguments_[2] as
            | ((error?: Error | null) => void)
            | undefined;
          queueMicrotask(() =>
            callback?.(new Error("simulated callback error")),
          );
          return true;
        }
        if (failure === "error") throw new Error("simulated write error");
        throw "unstructured write failure";
      },
    });

    const failed = await manager.execute(started.value.session_id, "will-fail");

    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error._tag).toBe("AnalysisCapabilityUnavailableError");
      expect(failed.error.message).toContain(
        failure === "callback"
          ? "simulated callback error"
          : failure === "error"
            ? "simulated write error"
            : "unknown error",
      );
    }
  },
);

it("does not issue a command after an exit wins the startup prompt race", async () => {
  const fake = createFakeSpawner(undefined, { exitOnFirstStdoutData: true });
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok)
    expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
});

it("preserves SIGTERM startup exit status in the capability failure and Evidence", async () => {
  const fake = createFakeSpawner(undefined, {
    exitOnFirstStdoutData: true,
    startupExitCode: null,
    startupExitSignal: "SIGTERM",
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(started.error.message).toContain("exit code null, signal SIGTERM");
    expect(started.error.partialObservation).toMatchObject({
      raw_result: {
        process_exit_code: null,
        process_exit_signal: "SIGTERM",
        process_exit_observed: true,
      },
    });
  }
});

it("rejects the command queued behind a timed-out GDB request", async () => {
  const fake = createFakeSpawner((_child, _token, command) => {
    if (command.includes("auto-load off"))
      fake.children[0]?.stdout.write(`${_token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 25,
  });
  const started = await expectGdbSessionStarted(manager);

  const first = manager.execute(started.value.session_id, "stall");
  const queued = manager.execute(started.value.session_id, "after-timeout");
  const firstResult = await first;
  expect(firstResult.ok).toBe(false);
  if (!firstResult.ok)
    expect(firstResult.error._tag).toBe("AnalysisCapabilityUnavailableError");
  const rejected = await queued;

  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.error._tag).toBe("AnalysisInputError");
});

it("waits for the prior command and preserves cancellation and queue failures", async () => {
  const resolved = Promise.resolve();
  expect(waitForGdbCommandTurn(resolved)).toBe(resolved);

  const preAborted = new AbortController();
  const queueReason = "queue cancelled before admission";
  preAborted.abort(queueReason);
  await expect(
    waitForGdbCommandTurn(Promise.resolve(), preAborted.signal),
  ).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
    cause: queueReason,
  });

  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const activeQueueReason = { source: "active queue cancellation" };
  const cancelledWait = waitForGdbCommandTurn(pending, controller.signal);
  controller.abort(activeQueueReason);
  await expect(cancelledWait).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
    cause: activeQueueReason,
  });
  release();

  const queueFailure = new Error("previous command queue failed");
  await expect(
    waitForGdbCommandTurn(
      Promise.reject(queueFailure),
      new AbortController().signal,
    ),
  ).rejects.toBe(queueFailure);
});

it("retains a multi-run console command through its completion query before dispatching a follower", async () => {
  let completionToken = "";
  let sourceToken = "";
  const commands: string[] = [];
  const fake = createFakeSpawner((child, token, command) => {
    commands.push(command);
    if (command.includes("source commands.gdb")) {
      sourceToken = token;
      child.stdout.write(
        `${token}^running\n*running,thread-id="all"\n(gdb) \n`,
      );
      child.stdout.write('*stopped,reason="exited-normally"\n');
    } else if (command === "-gdb-show mi-async") completionToken = token;
    else if (command.includes("REA_NEXT_COMMAND"))
      child.stdout.write(`~"REA_NEXT_COMMAND\\n"\n${token}^done\n`);
    else
      child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,groups=[]\n`
          : `${token}^done\n`,
      );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  let settled = false;
  const source = manager.execute(
    started.value.session_id,
    "source commands.gdb",
  );
  void source.then(() => {
    settled = true;
  });
  const follower = manager.execute(
    started.value.session_id,
    "echo REA_NEXT_COMMAND\\n",
  );
  await expect.poll(() => completionToken).not.toBe("");
  expect(settled).toBe(false);
  expect(commands.some((command) => command.includes("REA_NEXT_COMMAND"))).toBe(
    false,
  );

  const child = fake.children[0]!;
  child.stdout.write(
    '*running,thread-id="all"\n*stopped,reason="exited-normally"\n',
  );
  child.stdout.write('~"REA_SOURCE_TAIL\\n"\n(gdb) \n');
  expect(settled).toBe(false);
  child.stdout.write(`${completionToken}^done,value="off"\n(gdb) \n`);
  const result = await source;
  if (!result.ok) throw result.error;
  expect(result.value.result).toMatchObject({
    mi: `${sourceToken}^running`,
    completion_status: "complete",
    output_truncated: false,
    console: '~"REA_SOURCE_TAIL\\n"',
  });
  expect(
    result.value.result.records.filter((record) =>
      record.startsWith("*stopped"),
    ),
  ).toHaveLength(2);
  expect(result.value.result.records).toContain(
    `${completionToken}^done,value="off"`,
  );
  expect(result.value.evidence.normalized_result).toMatchObject({
    console: result.value.result.console,
  });
  const next = await follower;
  if (!next.ok) throw next.error;
  expect(next.value.result.console).toBe('~"REA_NEXT_COMMAND\\n"');
  expect(
    next.value.result.records.some((record) => record.startsWith("*stopped")),
  ).toBe(false);
  expect(next.value.evidence.normalized_result).toMatchObject({
    console: next.value.result.console,
  });
});

it.each([
  "abc",
  "abc123",
  "é🚀",
  "999999^done",
  '~"raw stream-looking output"',
])(
  "completes raw unterminated shell output without guessing its MI suffix: %s",
  async (payload) => {
    let originalToken = "";
    let queryCount = 0;
    const fake = createFakeSpawner((child, token, command) => {
      if (command.includes("shell printf fixture")) {
        originalToken = token;
        const bytes = Buffer.from(`${payload}${token}^done\n(gdb) \n`);
        child.stdout.write(bytes.subarray(0, 1));
        child.stdout.write(bytes.subarray(1));
      } else if (command === "-gdb-show mi-async") {
        queryCount += 1;
        child.stdout.write(`${token}^done,value="off"\n(gdb) \n`);
      } else
        child.stdout.write(
          command.includes("list-thread-groups")
            ? `${token}^done,groups=[]\n`
            : `${token}^done\n`,
        );
    });
    const manager = managerWithFakeSpawner(fake.spawnProcess);
    const started = await expectGdbSessionStarted(manager);
    const executed = await manager.execute(
      started.value.session_id,
      "shell printf fixture",
    );
    if (!executed.ok) throw executed.error;
    expect(executed.value.result).toMatchObject({
      mi: "",
      records: expect.arrayContaining([`${payload}${originalToken}^done`]),
      completion_status: "complete",
      output_truncated: false,
    });
    expect(queryCount).toBe(1);
    expect(executed.value.evidence.limitations.join(" ")).toContain(
      "result class is unknown",
    );
    const following = await manager.execute(
      started.value.session_id,
      "show version",
    );
    expect(following.ok).toBe(true);
    expect(queryCount).toBe(1);
    expect((await manager.close(started.value.session_id)).ok).toBe(true);
  },
);

it("retains unknown completion and partial Evidence when the completion query fails", async () => {
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes("source commands.gdb"))
      child.stdout.write(
        `${token}^running\n*stopped,reason="exited-normally"\n~"REA_SOURCE_TAIL\\n"\n`,
      );
    else if (command === "-gdb-show mi-async")
      child.stdout.write(`${token}^error,msg="completion query failed"\n`);
    else child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => ({ status: "stopped" }),
  });
  const started = await expectGdbSessionStarted(manager);
  const result = await manager.execute(
    started.value.session_id,
    "source commands.gdb",
  );
  if (result.ok) throw new Error("Expected unavailable command completion");
  expect(result.error).toMatchObject({
    _tag: "AnalysisCapabilityUnavailableError",
    partialObservation: {
      normalized_result: {
        completion_status: "unknown",
        console: '~"REA_SOURCE_TAIL\\n"',
      },
    },
  });
  expect(
    await manager.execute(started.value.session_id, "show version"),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it("correlates command output records and reports invalid or cancelled requests", async () => {
  const manager = await managerFor(
    responsiveProvider(`
      if (match[2].includes('auto-load off') || match[2] === '-gdb-show mi-async') process.stdout.write(match[1] + '^done\\n');
      else {
        process.stdout.write('=thread-created,id="1"\\n');
        process.stdout.write('~"console\\n"\\n@"target\\n"\\n&"log\\n"\\n');
        process.stdout.write(match[1] + '^running\\n');
        process.stdout.write('*stopped,reason="end-stepping-range"\\n');
      }
    `),
  );
  expect((await manager.execute("missing", "info registers")).ok).toBe(false);
  expect((await manager.close("missing")).ok).toBe(false);

  const started = await expectGdbSessionStarted(manager);
  const result = await manager.execute(
    started.value.session_id,
    "info registers",
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.result).toMatchObject({
      mi: expect.stringMatching(/\^running/u),
      console: '~"console',
      target: '@"target',
      log: '&"log',
    });
  }
  const signalled = await manager.execute(
    started.value.session_id,
    "info registers",
    new AbortController().signal,
  );
  expect(signalled.ok).toBe(true);
  const cancelled = new AbortController();
  cancelled.abort();
  const rejected = await manager.execute(
    started.value.session_id,
    "info registers",
    cancelled.signal,
  );
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.error._tag).toBe("AnalysisCancelledError");
  const closed = await manager.close(started.value.session_id);
  expect(closed.ok).toBe(false);
  expect(manager.status(started.value.session_id)).toBeDefined();
});

it.each([
  ["malformed recursive list", "groups=[}]"],
  ["malformed result suffix", "groups=[],extra=}"],
  ["malformed leading result", "extra=},groups=[]"],
  [
    "duplicate inventory with a live PID after an empty list",
    'groups=[],groups=[{id="i1",pid="123"}]',
  ],
] as const)(
  "retains ownership when recursive MI cannot establish one safe inventory: %s",
  async (_label, groups) => {
    const commands: string[] = [];
    const fake = createFakeSpawner((child, token, command) => {
      commands.push(command);
      child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,${groups}\n`
          : `${token}^done\n`,
      );
    });
    const manager = managerWithFakeSpawner(fake.spawnProcess);
    const started = await expectGdbSessionStarted(manager);

    const closed = await manager.close(started.value.session_id);

    expect(closed).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
    expect(
      commands.filter((command) => command.includes("list-thread-groups")),
    ).toHaveLength(2);
    expect(commands).not.toContain("-gdb-exit");
    expect(manager.status(started.value.session_id)).toBeDefined();
    expect(fake.children[0]?.killSignals).toEqual([]);
  },
);

it("retains ownership when descriptor readback omits input confirmation", async () => {
  const commands: string[] = [];
  let inferiorAlive = true;
  const fake = createFakeSpawner((child, token, command) => {
    commands.push(command);
    const response = command.includes("inferior-tty-show")
      ? '^done,inferior_tty_terminal="/dev/pts/42"'
      : command.includes("list-thread-groups")
        ? '^done,groups=[{id="i1",pid="123"}]'
        : "^done";
    child.stdout.write(`${token}${response}\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    // Exercise malformed output from the injected descriptor boundary.
    verifyInferiorOutputSink: async (pid, _tty, rememberIdentity) => {
      rememberIdentity({ pid, startTime: "controlled-inferior" });
      return undefined as never;
    },
    readInferiorProcessStartTime: async () =>
      inferiorAlive ? "controlled-inferior" : null,
  });
  const started = await expectGdbSessionStarted(manager, undefined, {
    inferiorTty: "/dev/pts/42",
  });

  const closed = await manager.close(started.value.session_id);

  expect(closed.ok).toBe(false);
  expect(manager.status(started.value.session_id)).toBeDefined();
  expect(commands).not.toContain("-target-detach");
  expect(fake.children[0]?.killSignals).toEqual([]);

  const gdb = fake.children[0];
  if (gdb === undefined) throw new Error("Fake GDB did not spawn");
  gdb.exitLeader(0);
  gdb.closeInheritedOutput();
  inferiorAlive = false;
  const retried = await manager.close(started.value.session_id);

  expect(retried).toMatchObject({
    ok: true,
    value: { target_state: "none_observed" },
  });
  expect(manager.status(started.value.session_id)).toBeUndefined();
});

it("detaches a live inferior before the shared stop helper signals GDB", async () => {
  const tty = "/dev/pts/42";
  const commands: string[] = [];
  let detached = false;
  const fake = createFakeSpawner((_child, token, command) => {
    commands.push(command);
    if (command.includes("inferior-tty-show"))
      fake.children[0]?.stdout.write(
        `${token}^done,inferior_tty_terminal=${JSON.stringify(tty)}\n`,
      );
    else if (command.includes("list-thread-groups"))
      fake.children[0]?.stdout.write(
        detached
          ? `${token}^done,groups=[]\n`
          : `${token}^done,groups=[{id="i1",pid="123"}]\n`,
      );
    else {
      if (command.includes("target-detach")) detached = true;
      fake.children[0]?.stdout.write(`${token}^done\n`);
    }
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager, undefined, {
    inferiorTty: tty,
  });

  const closed = await manager.close(started.value.session_id);

  expect(closed).toMatchObject({
    ok: true,
    value: { target_state: "unknown" },
  });
  expect(commands).toContain("-list-thread-groups --recurse 1");
  expect(commands).toContain("-target-detach");
  expect(
    commands.filter((command) => command.includes("target-detach")),
  ).toHaveLength(1);
  expect(commands).not.toContain("-gdb-exit");
  expect(commands.indexOf("-inferior-tty-show")).toBeLessThan(
    commands.indexOf("-target-detach"),
  );
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
});

it.each([false, true])(
  "retains verified detach when MI becomes unavailable with a queued follower: %s",
  async (withFollower) => {
    const tty = "/dev/pts/42";
    const commands: string[] = [];
    let detached = false;
    const fake = createFakeSpawner((_child, token, command) => {
      commands.push(command);
      if (command.includes("inferior-tty-show"))
        fake.children[0]?.stdout.write(
          `${token}^done,inferior_tty_terminal=${JSON.stringify(tty)}\n`,
        );
      else if (command.includes("list-thread-groups"))
        fake.children[0]?.stdout.write(
          detached
            ? `${token}^error,msg="transport shutting down"\n`
            : `${token}^done,groups=[{id="i1",pid="123"}]\n`,
        );
      else {
        if (command.includes("target-detach")) detached = true;
        fake.children[0]?.stdout.write(`${token}^done\n`);
      }
    });
    const manager = managerWithFakeSpawner(fake.spawnProcess);
    const started = await expectGdbSessionStarted(manager, undefined, {
      inferiorTty: tty,
    });

    const closing = manager.close(started.value.session_id);
    const follower = withFollower
      ? manager.execute(started.value.session_id, "show version")
      : undefined;
    const closed = await closing;
    if (follower !== undefined)
      expect(await follower).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisInputError" },
      });
    expect(commands.some((command) => command.includes("show version"))).toBe(
      false,
    );
    expect(manager.status(started.value.session_id)).toBeUndefined();

    expect(closed).toMatchObject({
      ok: true,
      value: { target_state: "unknown" },
    });
    expect(
      commands.filter((command) => command.includes("list-thread-groups")),
    ).toHaveLength(2);
    expect(commands).toContain("-target-detach");
    expect(
      commands.filter((command) => command.includes("target-detach")),
    ).toHaveLength(1);
    expect(commands).not.toContain("-gdb-exit");
    expect(commands.indexOf("-inferior-tty-show")).toBeLessThan(
      commands.indexOf("-target-detach"),
    );
    expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
  },
);

it("reports none observed when the inferior disappears before detach", async () => {
  const tty = "/dev/pts/42";
  const commands: string[] = [];
  let groupQueries = 0;
  const fake = createFakeSpawner((child, token, command) => {
    commands.push(command);
    if (command.includes("inferior-tty-show"))
      child.stdout.write(
        `${token}^done,inferior_tty_terminal=${JSON.stringify(tty)}\n`,
      );
    else if (command.includes("list-thread-groups")) {
      groupQueries += 1;
      child.stdout.write(
        groupQueries === 1
          ? `${token}^done,groups=[{id="i1",pid="123"}]\n`
          : `${token}^done,groups=[]\n`,
      );
    } else child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager, undefined, {
    inferiorTty: tty,
  });

  const closed = await manager.close(started.value.session_id);

  expect(closed).toMatchObject({
    ok: true,
    value: { target_state: "none_observed" },
  });
  expect(groupQueries).toBe(2);
  expect(commands).not.toContain("-target-detach");
});

it("retains GDB ownership when MI does not confirm target detachment", async () => {
  const tty = "/dev/pts/42";
  const commands: string[] = [];
  const fake = createFakeSpawner((child, token, command) => {
    commands.push(command);
    child.stdout.write(
      command.includes("inferior-tty-show")
        ? `${token}^done,inferior_tty_terminal=${JSON.stringify(tty)}\n`
        : command.includes("list-thread-groups")
          ? `${token}^done,groups=[{id="i1",pid="123"}]\n`
          : command.includes("target-detach")
            ? `${token}^error,msg="detach rejected"\n`
            : `${token}^done\n`,
    );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager, undefined, {
    inferiorTty: tty,
  });

  const closed = await manager.close(started.value.session_id);

  expect(closed).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  expect(
    commands.filter((command) => command.includes("target-detach")),
  ).toHaveLength(2);
  expect(fake.children[0]?.killSignals).toEqual([]);
  expect(manager.status(started.value.session_id)).toBeDefined();
});

it.each([
  ["releases cleanup after the identified inferior ends", false],
  ["invalidates old identity after a newer ambiguous inventory", true],
])("%s", async (_title, invalidateAfterFirstInspection) => {
  const inferior = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1_000)"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let inferiorAlive = true;
  let capturedStartTime: string | undefined;
  try {
    if (inferior.pid === undefined) throw new Error("Inferior did not spawn");
    await new Promise<void>((resolve, reject) => {
      inferior.stdout.once("data", () => resolve());
      inferior.once("error", reject);
    });
    const pid = String(inferior.pid);
    const tty = "/dev/pts/42";
    let groupQueries = 0;
    const fake = createFakeSpawner((_child, token, command) => {
      let response: string;
      if (command.includes("inferior-tty-show"))
        response = `^done,inferior_tty_terminal=${JSON.stringify(tty)}`;
      else if (command.includes("list-thread-groups")) {
        groupQueries += 1;
        response =
          invalidateAfterFirstInspection && groupQueries > 1
            ? '^done,groups=[{id="i1",pid="123"},{id="i2",pid="456"}]'
            : `^done,groups=[{id="i1",pid="${pid}"}]`;
      } else if (command.includes("target-detach"))
        response = '^error,msg="detach reply lost"';
      else response = "^done";
      fake.children[0]?.stdout.write(`${token}${response}\n`);
    });
    const manager = managerWithFakeSpawner(fake.spawnProcess, {
      verifyInferiorOutputSink: async (observedPid, _tty, rememberIdentity) => {
        expect(observedPid).toBe(pid);
        if (process.platform === "linux") {
          const stat = await readFile(`/proc/${observedPid}/stat`, "utf8");
          const parsed = parseLinuxProcessStat(stat);
          capturedStartTime =
            parsed?.pid === Number(observedPid) ? parsed.startTime : undefined;
        } else capturedStartTime = `test-inferior-${observedPid}`;
        if (capturedStartTime === undefined)
          throw new Error("Controlled inferior identity was unreadable");
        rememberIdentity({ pid: observedPid, startTime: capturedStartTime });
        return "durable";
      },
      readInferiorProcessStartTime: async (observedPid) => {
        if (observedPid !== pid || !inferiorAlive) return null;
        if (process.platform === "linux") {
          const stat = await readFile(`/proc/${observedPid}/stat`, "utf8");
          const parsed = parseLinuxProcessStat(stat);
          return parsed?.pid === Number(observedPid) ? parsed.startTime : null;
        }
        return capturedStartTime ?? null;
      },
    });
    const started = await expectGdbSessionStarted(manager, undefined, {
      inferiorTty: tty,
    });
    const firstClose = await manager.close(started.value.session_id);
    expect(firstClose.ok).toBe(false);
    if (!firstClose.ok) expect(firstClose.error.cleanupIncomplete).toBe(true);

    const gdbProcess = fake.children[0];
    if (gdbProcess === undefined) throw new Error("Fake GDB did not spawn");
    expect(groupQueries).toBeGreaterThanOrEqual(2);
    gdbProcess.exitLeader(7);
    gdbProcess.closeInheritedOutput();

    if (invalidateAfterFirstInspection) {
      const inferiorExit = new Promise<void>((resolve, reject) => {
        inferior.once("exit", () => resolve());
        inferior.once("error", reject);
      });
      inferior.kill("SIGTERM");
      await inferiorExit;
      inferiorAlive = false;
      const invalidated = await manager.close(started.value.session_id);
      expect(invalidated.ok).toBe(false);
      expect(manager.status(started.value.session_id)).toBeDefined();
      return;
    }

    const whileInferiorLives = await manager.close(started.value.session_id);
    expect(whileInferiorLives.ok).toBe(false);
    expect(manager.status(started.value.session_id)).toBeDefined();

    const inferiorExit = new Promise<void>((resolve, reject) => {
      inferior.once("exit", () => resolve());
      inferior.once("error", reject);
    });
    inferior.kill("SIGTERM");
    await inferiorExit;
    inferiorAlive = false;
    await expect(
      manager.close(started.value.session_id),
    ).resolves.toMatchObject({
      ok: true,
      value: { target_state: "none_observed" },
    });
    expect(manager.status(started.value.session_id)).toBeUndefined();
  } finally {
    if (inferior.exitCode === null && inferior.signalCode === null) {
      const inferiorExit = new Promise<void>((resolve) =>
        inferior.once("exit", () => resolve()),
      );
      inferior.kill("SIGKILL");
      await inferiorExit;
    }
  }
});

it("revokes the verified sink after an abbreviated with inferior-tty run command", async () => {
  const tty = "/dev/pts/42";
  const commands: string[] = [];
  const fake = createFakeSpawner((_child, token, command) => {
    commands.push(command);
    if (command.includes("inferior-tty-show"))
      fake.children[0]?.stdout.write(
        `${token}^done,inferior_tty_terminal=${JSON.stringify(tty)}\n`,
      );
    else if (command.includes("list-thread-groups"))
      fake.children[0]?.stdout.write(
        `${token}^done,groups=[{id="i1",pid="123"}]\n`,
      );
    else fake.children[0]?.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager, undefined, {
    inferiorTty: tty,
  });

  for (const inspection of ["show inferior-tty", "help inferior-tty"]) {
    expect(
      (await manager.execute(started.value.session_id, inspection)).ok,
    ).toBe(true);
    expect(
      manager.status(started.value.session_id)?.inferior_tty_verified,
    ).toBe(true);
  }
  const overridden = await manager.execute(
    started.value.session_id,
    "with inferior-t /tmp/other-output -- run",
  );

  expect(overridden.ok).toBe(true);
  expect(manager.status(started.value.session_id)).toMatchObject({
    inferior_tty: tty,
    inferior_tty_verified: false,
  });
  const closed = await manager.close(started.value.session_id);
  expect(closed.ok).toBe(false);
  expect(commands).not.toContain("-target-detach");
  expect(manager.status(started.value.session_id)).toBeDefined();
});

const expectDetachProofRevoked = async (
  commandsToRun: readonly string[],
  expectedVerifiedBeforeLastCommand?: boolean,
): Promise<void> => {
  const { manager, sessionId, commands } =
    await startWithVerifiedInferiorTty("/dev/pts/42");
  for (const [index, command] of commandsToRun.entries()) {
    await manager.execute(sessionId, command);
    if (index === 0 && expectedVerifiedBeforeLastCommand)
      expect(manager.status(sessionId)?.inferior_tty_verified).toBe(true);
  }

  expect(manager.status(sessionId)?.inferior_tty_verified).toBe(false);
  const closed = await manager.close(sessionId);
  expect(closed.ok).toBe(false);
  expect(commands).not.toContain("-target-detach");
};

it.each([
  {
    title: "an abbreviated TTY change followed by restoring the original TTY",
    commands: [
      "set pagination off",
      "set inferior-t /tmp/other",
      "set inferior-t /dev/pts/42",
      "start",
    ],
    expectedVerified: true,
  },
  {
    title: "redirection attached to a run argument",
    commands: ["start arg>/dev/null"],
    expectedVerified: false,
  },
  {
    title: "a Python abbreviation that changes inferior TTY",
    commands: [
      'py gdb.execute("set " + chr(45).join(["inferior", "tty"]) + " /dev/null")',
    ],
    expectedVerified: false,
  },
  {
    title: "a GDB alias that can change inferior output",
    commands: ["alias redirect-output = run > /tmp/gdb-redirected-output"],
    expectedVerified: false,
  },
  {
    title: "an abbreviated TTY command",
    commands: ["tt /tmp/gdb-alternate-inferior-output"],
    expectedVerified: false,
  },
  {
    title: "an abbreviated run command",
    commands: ["ru > /tmp/gdb-alternate-inferior-output"],
    expectedVerified: false,
  },
  {
    title: "Python nested in an abbreviated with command",
    commands: [
      'with confirm off -- py gdb.execute("set " + chr(45).join(["inferior", "tty"]) + " /dev/null")',
    ],
    expectedVerified: false,
  },
  {
    title: "Python nested in an abbreviated wit command",
    commands: [
      'wit confirm off -- py gdb.execute("set " + chr(45).join(["inferior", "tty"]) + " /dev/null")',
    ],
    expectedVerified: false,
  },
])(
  "revokes detach proof for $title",
  async ({ commands, expectedVerified }) => {
    await expectDetachProofRevoked(commands, expectedVerified);
  },
);

it("does not detach a live inferior when no durable TTY was selected", async () => {
  const responder = recordingInferiorListResponder('[{id="i1",pid="123"}]');
  const fake = createFakeSpawner(responder.respond);
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  await expect(manager.closeAll()).rejects.toMatchObject({
    errors: [
      expect.objectContaining({
        message: expect.stringMatching(/durable output sink/i),
      }),
    ],
  });

  expect(responder.commands).not.toContain("-target-detach");
  expect(responder.commands).not.toContain("-gdb-exit");
  expect(manager.status(started.value.session_id)).toBeDefined();
  expect(fake.children[0]?.killSignals).toEqual([]);
});

it("retains ownership without signaling when recursive MI reports multiple inferiors", async () => {
  const responder = recordingInferiorListResponder(
    '[{id="i1",pid="123"},{id="i2",pid="456"}]',
  );
  const fake = createFakeSpawner(responder.respond);
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  await expect(manager.closeAll()).rejects.toMatchObject({
    errors: [
      expect.objectContaining({
        message: expect.stringMatching(/multiple inferiors/iu),
      }),
    ],
  });

  expect(responder.commands).toContain("-list-thread-groups --recurse 1");
  expect(responder.commands).not.toContain("-target-detach");
  expect(manager.status(started.value.session_id)).toBeDefined();
  expect(fake.children[0]?.killSignals).toEqual([]);
});

it("confirms no inferior before the shared stop helper signals GDB", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  const closed = await manager.close(started.value.session_id);

  expect(closed).toMatchObject({
    ok: true,
    value: { target_state: "none_observed" },
  });
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
});

it("retains ownership when manual close receives a truncated empty inferior list", async () => {
  const commands: string[] = [];
  const fake = createFakeSpawner((_child, token, command) => {
    commands.push(command);
    if (command.includes("auto-load off")) {
      fake.children[0]?.stdout.write(`${token}^done\n`);
      return;
    }
    if (command.includes("list-thread-groups")) {
      const child = fake.children[0];
      if (child === undefined) return;
      // Keep each MI record below the per-line ceiling while exceeding the
      // per-command byte budget before the apparently empty result arrives.
      for (let index = 0; index < 17; index += 1)
        child.stdout.write(`~"${"x".repeat(1_000_000)}"\n`);
      child.stdout.write(`${token}^done,groups=[]\n`);
      return;
    }
    fake.children[0]?.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  const closed = await manager.close(started.value.session_id);

  expect(closed.ok).toBe(false);
  expect(commands).toContain("-list-thread-groups --recurse 1");
  expect(commands).not.toContain("-gdb-exit");
  expect(commands).not.toContain("-target-detach");
  expect(manager.status(started.value.session_id)).toBeDefined();
  expect(fake.children[0]?.killSignals).toEqual([]);
});

it("retains ownership and sends no signal when MI state is saturated or unknown", async () => {
  const fake = createFakeSpawner((_child, token, command) => {
    if (command.includes("auto-load off"))
      fake.children[0]?.stdout.write(`${token}^done\n`);
    else if (command.includes("list-thread-groups"))
      fake.children[0]?.stdout.write(`${token}^error,msg="unknown"\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 20,
  });
  const started = await expectGdbSessionStarted(manager);

  const timedOut = await manager.execute(started.value.session_id, "saturated");
  expect(timedOut.ok).toBe(false);
  await expect(manager.closeAll()).rejects.toMatchObject({
    errors: [
      expect.objectContaining({
        message: expect.stringMatching(/inferior detach/i),
      }),
    ],
  });

  expect(manager.status(started.value.session_id)?.state).toBe("closed");
  expect(fake.children[0]?.killSignals).toEqual([]);
});

it("routes protocol failure cleanup through detach verification without direct signals", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  const child = fake.children[0];
  if (child?.stdin === null || child?.stdin === undefined)
    throw new Error("Expected GDB child and stdin");
  Object.defineProperty(child.stdin, "write", {
    value: (
      _chunk: string,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): boolean => {
      callback(new Error("synthetic protocol failure"));
      return false;
    },
  });

  const failed = await manager.execute(started.value.session_id, "will-fail");
  expect(failed.ok).toBe(false);
  await new Promise((resolve) => setImmediate(resolve));
  expect(child.killSignals).toEqual([]);
});

it("retains ownership without signaling when detach confirmation fails", async () => {
  const fake = createFakeSpawner((_child, token, command) => {
    fake.children[0]?.stdout.write(
      command.includes("list-thread-groups")
        ? `${token}^error,msg="state unavailable"\n`
        : `${token}^done\n`,
    );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  await expect(manager.closeAll()).rejects.toThrow(/did not stop cleanly/i);

  expect(manager.status(started.value.session_id)?.state).toBe("closed");
  expect(fake.children[0]?.killSignals).toEqual([]);
});

it("closes with unknown target state when MI cannot confirm thread groups", async () => {
  const manager = await managerFor(
    responsiveProvider(`
      if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
      else if (match[2].includes('list-thread-groups')) process.stdout.write(match[1] + '^error,msg="not supported"\\n');
      else process.stdout.write(match[1] + '^done\\n');
    `),
  );
  const started = await expectGdbSessionStarted(manager);
  const closed = await manager.close(started.value.session_id);
  expect(closed.ok).toBe(false);
  if (!closed.ok) {
    expect(closed.error.message).toContain("inferior state");
    expect(closed.error._tag).toBe("AnalysisCapabilityUnavailableError");
  }
  expect(manager.status(started.value.session_id)).toBeDefined();
});

it("retains unknown inferior ownership after GDB exits during a command", async () => {
  const manager = await managerFor(
    responsiveProvider(`
      if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
      else process.stdout.write('~leaving\\n', () => process.exit(2));
    `),
  );
  const started = await expectGdbSessionStarted(manager);

  const executing = manager.execute(
    started.value.session_id,
    "exit during command",
  );
  const closing = manager.close(started.value.session_id);
  const executed = await executing;
  expect(executed).toMatchObject({
    ok: false,
    error: {
      cleanupIncomplete: true,
      partialObservation: {
        parameters: { command: "exit during command" },
        raw_result: { command: "exit during command" },
        normalized_result: {
          command: "exit during command",
          process_exit_observed: true,
          completion_status: "unknown",
        },
      },
    },
  });
  expect(await closing).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(manager.status(started.value.session_id)).toBeDefined();
});

it("retains an exited GDB session when no inferior identity was captured", async () => {
  const manager = await managerFor(
    responsiveProvider(`
      if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
      else process.exit(3);
    `),
  );
  const started = await expectGdbSessionStarted(manager);

  const executed = await manager.execute(started.value.session_id, "exit now");
  expect(executed).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (manager.status(started.value.session_id)?.state === "closed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(manager.status(started.value.session_id)?.state).toBe("closed");
  await expect(manager.close(started.value.session_id)).resolves.toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(manager.status(started.value.session_id)).toBeDefined();
});

it("retains a session when closing cannot confirm the debugger process stopped", async () => {
  let stopCalls = 0;
  const provider = await createProvider(responsiveProvider());
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: { REA_GDB_COMMAND: provider },
    stopProcess: async (session, name) => {
      stopCalls += 1;
      if (stopCalls === 1)
        return { status: "incomplete", reason: "simulated close uncertainty" };
      return stopOwnedDebuggerProcess(session, name);
    },
  });
  managers.push(manager);
  const started = await expectGdbSessionStarted(manager);

  const closed = await manager.close(started.value.session_id);

  expect(closed.ok).toBe(false);
  if (!closed.ok) {
    expect(closed.error.message).toContain("simulated close uncertainty");
    expect(closed.error).toMatchObject({
      providerId: "gdb",
      operation: "close_gdb_session",
    });
  }
  expect(manager.status(started.value.session_id)?.state).toBe("closed");
});

it("retains an exited GDB session when provider stop verification is incomplete", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => ({
      status: "incomplete",
      reason: "simulated exited debugger cleanup uncertainty",
    }),
  });
  const started = await expectGdbSessionStarted(manager);
  fake.children[0]?.exitLeader(9);

  const closed = await manager.close(started.value.session_id);

  expect(closed).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  expect(manager.status(started.value.session_id)?.state).toBe("closed");
});

it("preserves a command timeout when stopping the owned process rejects", async () => {
  let stopCalls = 0;
  const provider = await createProvider(
    responsiveProvider(`
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
  `),
  );
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: { REA_GDB_COMMAND: provider },
    commandTimeoutMs: 25,
    stopProcess: async (session, name) => {
      stopCalls += 1;
      if (stopCalls === 1) throw new Error("simulated stop failure");
      return stopOwnedDebuggerProcess(session, name);
    },
  });
  managers.push(manager);
  const started = await expectGdbSessionStarted(manager);

  const timedOut = await manager.execute(started.value.session_id, "stall");

  expect(timedOut.ok).toBe(false);
  if (!timedOut.ok) {
    expect(timedOut.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(timedOut.error.message).toContain("shutdown failed");
  }
});

it("retains caller cancellation and cleanup authority after active-command stop rejects", async () => {
  const controller = new AbortController();
  const reason = { source: "console caller cancellation" };
  const cleanupFailure = new AnalysisTimeoutError("foreign_cleanup", 17);
  let stopCalls = 0;
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes("auto-load off"))
      child.stdout.write(`${token}^done\n`);
    else controller.abort(reason);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async (session, name) => {
      stopCalls += 1;
      if (stopCalls === 1) throw cleanupFailure;
      return stopOwnedDebuggerProcess(session, name);
    },
  });
  const started = await expectGdbSessionStarted(manager);

  const cancelled = await manager.execute(
    started.value.session_id,
    "cancel me",
    controller.signal,
  );

  expect(cancelled.ok).toBe(false);
  if (!cancelled.ok) {
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
    expect(cancelled.error.cause).toBe(reason);
    expect(cancelled.error.cleanup).toEqual({
      reason: expect.stringContaining("foreign_cleanup"),
      resources: [started.value.session_id],
    });
    expect(cancelled.error.cleanupIncomplete).toBe(true);
  }
  expect(stopCalls).toBe(1);
  expect((await manager.retryCleanupFailures()).ok).toBe(false);
  if (!cancelled.ok) expect(cancelled.error.cleanupIncomplete).toBe(true);
  expect(stopCalls).toBe(2);
});

it.each(["tagged", "unexpected"] as const)(
  "retains %s stop failures while closing and resolves them after retry",
  async (failureKind) => {
    const fake = createFakeSpawner();
    let recovered = false;
    const manager = managerWithFakeSpawner(fake.spawnProcess, {
      stopProcess: () => {
        if (recovered) {
          fake.children[0]?.exit(0, null);
          return Promise.resolve({ status: "stopped" });
        }
        // Include synchronous throws at this injected provider boundary.
        throw failureKind === "tagged"
          ? new AnalysisTimeoutError("foreign_cleanup", 17)
          : new Error("unexpected cleanup failure");
      },
    });
    const started = await expectGdbSessionStarted(manager);
    const closed = await manager.close(started.value.session_id);
    expect(closed).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCapabilityUnavailableError",
        operation: "close_gdb_session",
        cleanupIncomplete: true,
        cleanupResources: [started.value.session_id],
        message: expect.stringContaining(
          failureKind === "tagged"
            ? "foreign_cleanup"
            : "unexpected cleanup failure",
        ),
      },
    });
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    recovered = true;
    expect((await manager.retryCleanupFailures()).ok).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
    if (!closed.ok) expect(closed.error.cleanupIncomplete).toBe(false);
  },
);

it("returns partial command evidence when the active MI request times out after stop", async () => {
  const fake = createFakeSpawner((_child, token, command) => {
    if (command.includes("hang-for-timeout")) return;
    if (command.includes("list-thread-groups"))
      _child.stdout.write(`${token}^done,groups=[]\n`);
    else _child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 20,
    stopProcess: async () => ({ status: "stopped" }),
  });
  const started = await expectGdbSessionStarted(manager);

  const result = await manager.execute(
    started.value.session_id,
    "hang-for-timeout",
  );

  expect(result).toMatchObject({
    ok: true,
    value: {
      result: {
        completion_status: "unknown",
        output_truncated: false,
      },
    },
  });
});

it("preserves cancellation without cleanup details when stop is confirmed", async () => {
  const controller = new AbortController();
  const reason = { source: "confirmed active command cancellation" };
  let requestToken = "";
  const fake = createFakeSpawner((_child, token, command) => {
    if (command.includes("cancel-confirmed")) requestToken = token;
    else _child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => ({ status: "stopped" }),
  });
  const started = await expectGdbSessionStarted(manager);

  const active = manager.execute(
    started.value.session_id,
    "cancel-confirmed",
    controller.signal,
  );
  await expect.poll(() => requestToken).not.toBe("");
  controller.abort(reason);
  const cancelled = await active;

  expect(cancelled).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError", operation: "gdb_console" },
  });
  if (!cancelled.ok) {
    expect(cancelled.error.cleanup).toBeUndefined();
    expect(cancelled.error.cause).toBe(reason);
  }
});

it("rechecks cancellation after registering the active MI request listener", async () => {
  const controller = new AbortController();
  let registrations = 0;
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === "addEventListener")
        return (...arguments_: Parameters<AbortSignal["addEventListener"]>) => {
          registrations += 1;
          const result = target.addEventListener(...arguments_);
          if (registrations === 2) controller.abort();
          return result;
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const commands: string[] = [];
  const fake = createFakeSpawner((child, token, command) => {
    commands.push(command);
    child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async () => ({ status: "stopped" }),
  });
  const started = await expectGdbSessionStarted(manager);

  const cancelled = await manager.execute(
    started.value.session_id,
    "must-not-be-sent",
    signal,
  );

  expect(cancelled).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect(commands).not.toContain(expect.stringContaining("must-not-be-sent"));
  expect(registrations).toBeGreaterThanOrEqual(2);
});

it("classifies timeout and unexpected failures raised while quoting console commands", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  const timeoutCommand = Object.assign(new String("timeout"), {
    replaceAll() {
      throw new AnalysisTimeoutError("test_command_quote", 17);
    },
  }) as unknown as string;
  const timeout = await manager.execute(
    started.value.session_id,
    timeoutCommand,
  );
  expect(timeout.ok).toBe(false);
  if (!timeout.ok) expect(timeout.error._tag).toBe("AnalysisTimeoutError");

  const unexpectedCommand = Object.assign(new String("unexpected"), {
    replaceAll() {
      throw new Error("command quoting failed");
    },
  }) as unknown as string;
  const unexpected = await manager.execute(
    started.value.session_id,
    unexpectedCommand,
  );
  expect(unexpected.ok).toBe(false);
  if (!unexpected.ok)
    expect(unexpected.error._tag).toBe("AnalysisTimeoutError");
});

it("marks retained exit output as truncated when command records exceed the byte cap", async () => {
  const manager = await managerFor(`
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
    else {
      const record = 'x'.repeat(6 * 1024 * 1024);
      process.stdout.write('~' + record + '\\n~' + record + '\\n~' + record + '\\n', () => process.exit(7));
    }
  }
});
`);
  const started = await expectGdbSessionStarted(manager);

  const exited = await manager.execute(started.value.session_id, "large exit");

  expect(exited.ok).toBe(false);
  if (!exited.ok) {
    expect(exited.error.cleanupIncomplete).toBe(true);
    expect(exited.error.partialObservation).toMatchObject({
      normalized_result: {
        process_exit_observed: true,
        output_truncated: true,
        completion_status: "unknown",
      },
    });
    expect(projectAnalysisError(exited.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        diagnostics: {
          setting: DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_SETTING,
          effective_value: DEFAULT_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
          source: "default",
        },
      },
    });
  }
});

it("retains split MI records while bounding recent and command output", async () => {
  const manager = await managerFor(`
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
    else {
      process.stdout.write('=split-record');
      setTimeout(() => {
        process.stdout.write('\\n999^done\\n=unmatched-token\\n' + 'x'.repeat(70_000) + '\\n');
        const largeRecord = 'a'.repeat(6 * 1024 * 1024);
        process.stdout.write('~' + largeRecord + '\\n~' + largeRecord + '\\n~' + largeRecord + '\\n');
        process.stdout.write(match[1] + '^done\\n');
      }, 5);
    }
  }
});

`);
  const started = await expectGdbSessionStarted(manager);

  const result = await manager.execute(
    started.value.session_id,
    "large-output",
  );

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.result.output_truncated).toBe(true);
    expect(result.value.result.records).toHaveLength(7);
  }
  expect(
    manager.status(started.value.session_id)?.recent_mi_records_truncated,
  ).toBe(true);
});

it("truncates retained MI records on UTF-8 code point boundaries", async () => {
  const manager = await managerFor(`
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
    else process.stdout.write('~' + '💩'.repeat(20_000) + '\\n' + match[1] + '^done\\n');
  }
});
`);
  const started = await expectGdbSessionStarted(manager);
  await manager.execute(started.value.session_id, "large unicode output");

  const retained = manager
    .status(started.value.session_id)
    ?.recent_mi_records.find((record) => record.startsWith("~"));
  expect(retained).toBeDefined();
  if (retained !== undefined) {
    expect(Buffer.byteLength(retained, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(retained).not.toContain("�");
    expect(retained.endsWith("[recent record truncated]")).toBe(true);
  }
});

it("closes the GDB session when a complete MI record exceeds the protocol limit", async () => {
  const manager = await managerFor(`
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
    else process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1) + '\\n');
  }
});
`);
  const started = await expectGdbSessionStarted(manager);

  const failed = await manager.execute(started.value.session_id, "bad-record");

  expect(failed).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      reason: expect.stringContaining("MI line exceeding the 16777216 byte"),
      cleanupIncomplete: true,
      cleanup: { resources: [started.value.session_id] },
      partialObservation: {
        predicate_type: "rea.debugger.console-observation",
        raw_result: { command: "bad-record", completion_status: "unknown" },
      },
    },
  });
  expect(manager.status(started.value.session_id)?.state).toBe("closed");
});

it("rejects a partial MI line that exceeds the protocol limit", async () => {
  const manager = await managerFor(`
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
    else process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1));
  }
});
`);
  const started = await expectGdbSessionStarted(manager);

  const failed = await manager.execute(
    started.value.session_id,
    "partial-line",
  );

  expect(failed).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      reason: expect.stringContaining("MI line exceeding the 16777216 byte"),
      cleanupIncomplete: true,
      cleanup: { resources: [started.value.session_id] },
      partialObservation: {
        predicate_type: "rea.debugger.console-observation",
        raw_result: { command: "partial-line", completion_status: "unknown" },
      },
    },
  });
  expect(manager.status(started.value.session_id)?.state).toBe("closed");
});

it("caps the number of MI records retained for a single command", async () => {
  const recordCount = 16_385;
  const manager = await managerFor(`
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
    else process.stdout.write(Array.from({ length: ${recordCount} }, () => '~"x"').join('\\n') + '\\n' + match[1] + '^done\\n');
  }
});
`);
  const started = await expectGdbSessionStarted(manager);

  const result = await manager.execute(
    started.value.session_id,
    "many-records",
  );

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.result.records).toHaveLength(16_384);
    expect(result.value.result.output_truncated).toBe(true);
  }
});

it("completes an MI record split after a chunk without a newline", async () => {
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes("auto-load off")) {
      child.stdout.write(`${token}^done\n`);
      return;
    }
    child.stdout.write("=thread-created");
    setImmediate(() => child.stdout.write(`,id="1"\n${token}^done\n`));
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  const result = await manager.execute(started.value.session_id, "thread-info");

  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.value.result.records).toContain('=thread-created,id="1"');
});

it.each(["incomplete", "rejected"] as const)(
  "preserves the protocol failure and cleanup owner when stop is %s",
  async (stopOutcome) => {
    let stopCalls = 0;
    const fake = createFakeSpawner();
    const manager = managerWithFakeSpawner(fake.spawnProcess, {
      stopProcess: async (session, name) => {
        stopCalls += 1;
        if (stopCalls === 1) {
          if (stopOutcome === "rejected")
            throw new Error("simulated protocol stop uncertainty");
          return {
            status: "incomplete",
            reason: "simulated protocol stop uncertainty",
          };
        }
        if (stopCalls === 3) {
          // Simulate later owner verification after recovery completed.
          fake.children[0]?.exit(0, null);
          return { status: "stopped" };
        }
        return stopOwnedDebuggerProcess(session, name);
      },
    });
    const started = await expectGdbSessionStarted(manager);
    const stdin = fake.children[0]?.stdin;
    if (stdin === null || stdin === undefined)
      throw new Error("Expected GDB stdin");
    Object.defineProperty(stdin, "write", {
      value: (
        _chunk: string,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): boolean => {
        fake.children[0]?.stdout.write('~"protocol output before failure"\n');
        callback(new Error("simulated protocol write failure"));
        return false;
      },
    });

    const failed = await manager.execute(started.value.session_id, "will-fail");

    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.message).toContain(
        "GDB stdin write failed: simulated protocol write failure",
      );
      expect(failed.error.message).toContain(
        "simulated protocol stop uncertainty",
      );
      expect(failed.error.cleanup).toEqual({
        reason: expect.stringContaining("simulated protocol stop uncertainty"),
        resources: [started.value.session_id],
      });
      expect(failed.error.partialObservation).toMatchObject({
        predicate_type: "rea.debugger.console-observation",
        raw_result: {
          command: "will-fail",
          records: ['~"protocol output before failure"'],
          completion_status: "unknown",
        },
      });
    }
    expect(manager.status(started.value.session_id)?.state).toBe("closed");
    const subsequent = await manager.execute(
      started.value.session_id,
      "must-not-run",
    );
    expect(subsequent).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
    expect((await manager.retryCleanupFailures()).ok).toBe(false);
    expect(stopCalls).toBe(2);
    if (!failed.ok) expect(failed.error.cleanupIncomplete).toBe(true);
    expect((await manager.retryCleanupFailures()).ok).toBe(true);
    expect(stopCalls).toBe(3);
    expect(manager.status(started.value.session_id)).toBeUndefined();
    if (!failed.ok) expect(failed.error.cleanupIncomplete).toBe(false);
  },
);

it("drains buffered startup stdout before capturing early-exit Evidence", async () => {
  const children: FakeGdbProcess[] = [];
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: {},
    startupTimeoutMs: 500,
    spawnProcess: async (options) => {
      const child = new FakeGdbProcess();
      children.push(child);
      setImmediate(() => {
        child.exitLeader(7);
        setImmediate(() => {
          child.stdout.end('~"late startup record"\n');
          setTimeout(() => {
            child.stderr.write("late startup stderr");
            child.closeInheritedOutput();
          }, 20);
        });
      });
      return {
        process: child,
        ownership: {
          runId: options.runId,
          leaderPid: child.pid,
          processGroupId: child.pid,
          expectedParentPid: process.pid,
        },
      };
    },
  });
  managers.push(manager);

  const started = await manager.start();

  expect(started.ok).toBe(false);
  expect(children).toHaveLength(2);
  if (!started.ok)
    expect(started.error.capturedOutput?.stderr).toContain(
      "late startup stderr",
    );
  if (!started.ok)
    expect(started.error.partialObservation).toMatchObject({
      raw_result: {
        process_exit_code: 7,
        records: ['~"late startup record"'],
        completion_status: "unknown",
      },
    });
});

it("reports command timeout when an incomplete stop cannot confirm process exit", async () => {
  let stopCalls = 0;
  const fake = createFakeSpawner((_child, _token, command) => {
    if (!command.includes("auto-load off")) return;
    fake.children[0]?.stdout.write(`${_token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 20,
    stopProcess: async (session, name) => {
      stopCalls += 1;
      if (stopCalls === 1)
        return {
          status: "incomplete",
          reason: "simulated timeout stop uncertainty",
        };
      return stopOwnedDebuggerProcess(session, name);
    },
  });
  const started = await expectGdbSessionStarted(manager);

  const failed = await manager.execute(started.value.session_id, "stall");

  expect(failed.ok).toBe(false);
  if (!failed.ok) {
    expect(failed.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(failed.error.message).toContain(
      "simulated timeout stop uncertainty",
    );
  }
});

it.each(["reply-first", "stop-first"] as const)(
  "keeps interrupt pending until its MI reply and async stop arrive (%s)",
  async (order) => {
    let running!: () => void;
    const observedRun = new Promise<void>((resolve) => {
      running = resolve;
    });
    let interruptSent!: (token: string) => void;
    const observedInterrupt = new Promise<string>((resolve) => {
      interruptSent = resolve;
    });
    const commands: string[] = [];
    const fake = createFakeSpawner((child, token, command) => {
      commands.push(command);
      if (command.includes('console "run"')) {
        child.stdout.write(`${token}^running\n`);
        running();
      } else if (command.includes("interrupt")) interruptSent(token);
      else
        child.stdout.write(
          command.includes("list-thread-groups")
            ? `${token}^done,groups=[]\n`
            : `${token}^done\n`,
        );
    });
    const manager = managerWithFakeSpawner(fake.spawnProcess, {
      commandTimeoutMs: 500,
    });
    const started = await expectGdbSessionStarted(manager);
    const child = fake.children[0]!;
    const originalKill = child.kill.bind(child);
    child.kill = (signal) => {
      if (signal !== "SIGINT") return originalKill(signal);
      child.killSignals.push(signal);
      return true;
    };
    const run = manager.execute(started.value.session_id, "run");
    await observedRun;
    let interruptSettled = false;
    const interrupt = manager.execute(started.value.session_id, "interrupt");
    void interrupt.then(() => {
      interruptSettled = true;
    });
    const token = await observedInterrupt;

    if (order === "reply-first") child.stdout.write(`${token}^done\n`);
    else
      child.stdout.write(
        '*stopped,reason="signal-received",signal-name="SIGINT"\n',
      );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(interruptSettled).toBe(false);
    const overlapping = await manager.execute(
      started.value.session_id,
      "interrupt",
    );
    expect(overlapping.ok).toBe(false);
    expect(
      commands.filter((command) => command.includes("interrupt")),
    ).toHaveLength(1);

    if (order === "reply-first")
      child.stdout.write(
        '*stopped,reason="signal-received",signal-name="SIGINT"\n',
      );
    else child.stdout.write(`${token}^done\n`);
    expect(await interrupt).toMatchObject({ ok: true });
    expect(child.killSignals).toEqual(["SIGINT"]);
    expect(await run).toMatchObject({
      ok: true,
      value: {
        result: {
          mi: expect.stringContaining("^running"),
          completion_status: "complete",
        },
      },
    });
  },
);

it("keeps running threads interruptible after a non-stop partial stop", async () => {
  let running!: () => void;
  const observedRun = new Promise<void>((resolve) => {
    running = resolve;
  });
  let interruptSent!: (token: string) => void;
  const observedInterrupt = new Promise<string>((resolve) => {
    interruptSent = resolve;
  });
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes('console "run"')) {
      child.stdout.write(`${token}^running\n*running,thread-id="all"\n`);
      running();
    } else if (command.includes("interrupt")) interruptSent(token);
    else
      child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,groups=[]\n`
          : `${token}^done\n`,
      );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 500,
  });
  const started = await expectGdbSessionStarted(manager);
  const child = fake.children[0]!;
  const originalKill = child.kill.bind(child);
  child.kill = (signal) => {
    if (signal !== "SIGINT") return originalKill(signal);
    child.killSignals.push(signal);
    return true;
  };
  const run = manager.execute(started.value.session_id, "run");
  await observedRun;
  child.stdout.write(
    '*stopped,reason="breakpoint-hit",thread-id="1",stopped-threads=["1"]\n',
  );
  await expect(run).resolves.toMatchObject({
    ok: true,
    value: { result: { completion_status: "complete" } },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  let interruptSettled = false;
  const interrupt = manager.execute(started.value.session_id, "interrupt");
  void interrupt.then(() => {
    interruptSettled = true;
  });
  const token = await observedInterrupt;
  child.stdout.write(`${token}^done\n`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(interruptSettled).toBe(false);

  child.stdout.write(
    '*stopped,reason="signal-received",signal-name="SIGINT",stopped-threads="all"\n',
  );
  await expect(interrupt).resolves.toMatchObject({ ok: true });
  expect(child.killSignals).toEqual(["SIGINT"]);
});

it("does not release the shared stop owner when one non-stop inferior exits", async () => {
  let observedRun!: () => void;
  const runStarted = new Promise<void>((resolve) => {
    observedRun = resolve;
  });
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes('console "run"')) {
      child.stdout.write(
        `=thread-group-started,id="i1"\n=thread-group-started,id="i2"\n${token}^running\n*running,thread-id="all"\n`,
      );
      observedRun();
    } else if (command === "-thread-info") {
      child.stdout.write(
        `${token}^done,threads=[{id="2",target-id="Thread 2",state="running"}]\n`,
      );
    } else
      child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,groups=[]\n`
          : `${token}^done\n`,
      );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 500,
  });
  const started = await expectGdbSessionStarted(manager);
  const run = manager.execute(started.value.session_id, "run");
  await runStarted;
  const ownerCompletion = manager.waitForInferiorStop(started.value.session_id);
  let ownerReleased = false;
  void ownerCompletion.then(() => {
    ownerReleased = true;
  });

  const child = fake.children[0]!;
  child.stdout.write('=thread-group-exited,id="i1"\n');
  child.stdout.write('*stopped,reason="exited-normally"\n');
  await expect(run).resolves.toMatchObject({ ok: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(ownerReleased).toBe(false);

  child.stdout.write(
    '*stopped,reason="breakpoint-hit",thread-id="2",stopped-threads="all"\n',
  );
  await ownerCompletion;
  expect(ownerReleased).toBe(true);
});

it("finishes interrupt after the last per-thread stop is verified by MI", async () => {
  let observedRun!: () => void;
  const runStarted = new Promise<void>((resolve) => {
    observedRun = resolve;
  });
  let threadInfoQueries = 0;
  let observedThreadInfo!: (token: string) => void;
  const firstThreadInfo = new Promise<string>((resolve) => {
    observedThreadInfo = resolve;
  });
  let observedInterrupt!: (token: string) => void;
  const interruptSent = new Promise<string>((resolve) => {
    observedInterrupt = resolve;
  });
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes('console "run"')) {
      child.stdout.write(`${token}^running\n*running,thread-id="all"\n`);
      observedRun();
    } else if (command.includes("interrupt")) observedInterrupt(token);
    else if (command === "-thread-info") {
      threadInfoQueries += 1;
      if (threadInfoQueries === 1) observedThreadInfo(token);
      else
        child.stdout.write(
          `${token}^done,threads=[{id="1",target-id="Thread 1",state="stopped"}]\n`,
        );
    } else
      child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,groups=[]\n`
          : `${token}^done\n`,
      );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 500,
  });
  const started = await expectGdbSessionStarted(manager);
  const child = fake.children[0]!;
  const originalKill = child.kill.bind(child);
  child.kill = (signal) => {
    if (signal !== "SIGINT") return originalKill(signal);
    child.killSignals.push(signal);
    return true;
  };
  const run = manager.execute(started.value.session_id, "run");
  await runStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  child.stdout.write(
    '*stopped,reason="breakpoint-hit",thread-id="1",stopped-threads=["1"]\n',
  );
  const threadInfoToken = await firstThreadInfo;
  await expect(run).resolves.toMatchObject({ ok: true });
  expect(threadInfoQueries).toBe(1);
  const interrupt = manager.execute(started.value.session_id, "interrupt");
  const interruptToken = await interruptSent;
  child.stdout.write(`${interruptToken}^done\n`);
  child.stdout.write(
    '*stopped,reason="signal-received",signal-name="SIGINT",thread-id="1",stopped-threads=["1"]\n',
  );
  child.stdout.write(
    `${threadInfoToken}^done,threads=[{id="1",target-id="Thread 1",state="running"}]\n`,
  );
  await expect(interrupt).resolves.toMatchObject({ ok: true });
  expect(child.killSignals).toEqual(["SIGINT"]);
  expect(threadInfoQueries).toBe(2);
});

it.each(["cancel", "timeout"] as const)(
  "retains a %s running command until async stop before cleanup",
  async (mode) => {
    let running!: () => void;
    const observedRun = new Promise<void>((resolve) => {
      running = resolve;
    });
    const commands: string[] = [];
    const fake = createFakeSpawner((child, token, command) => {
      commands.push(command);
      if (command.includes('console "run"')) {
        child.stdout.write(`${token}^running\n`);
        running();
      } else
        child.stdout.write(
          command.includes("list-thread-groups")
            ? `${token}^done,groups=[]\n`
            : `${token}^done\n`,
        );
    });
    const manager = managerWithFakeSpawner(fake.spawnProcess, {
      commandTimeoutMs: 40,
    });
    const started = await expectGdbSessionStarted(manager);
    const controller = new AbortController();
    const run = manager.execute(
      started.value.session_id,
      "run",
      controller.signal,
    );
    await observedRun;
    if (mode === "cancel") controller.abort();
    const result = await run;
    expect(result).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    expect(
      commands.some((command) => command.includes("list-thread-groups")),
    ).toBe(false);
    expect(fake.children[0]?.killSignals).toEqual([]);
    await expect(
      manager.close(started.value.session_id),
    ).resolves.toMatchObject({ ok: false, error: { cleanupIncomplete: true } });
    fake.children[0]?.stdout.write('*stopped,reason="signal-received"\n');
    await expect(
      manager.close(started.value.session_id),
    ).resolves.toMatchObject({ ok: true });
    if (!result.ok) expect(result.error.cleanupIncomplete).toBe(false);
  },
);
