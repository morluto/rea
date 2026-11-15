import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../../src/process/ProviderProcess.js";
import { OwnedDebuggerCleanupError } from "../../../src/process/ownedDebuggerCleanupError.js";
import { expect } from "vitest";

import type { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";

/** Version every fake GDB reports in its `-gdb-version` banner. */
export const FAKE_GDB_VERSION = "99.1.rea-fake";

/** The `-gdb-version` reply, before the token's result record. */
export const fakeGdbVersionStream = `~"GNU gdb (REA fake) ${FAKE_GDB_VERSION}\\n"\n`;

/**
 * Answer the fixed `-gdb-version` startup query for an in-process fake GDB.
 * Returns false for any other command, which the scenario answers.
 */
export const answerFakeGdbStartup = (
  stdout: { write(text: string): unknown },
  token: string,
  command: string,
): boolean => {
  if (command !== "-gdb-version") return false;
  stdout.write(`${fakeGdbVersionStream}${token}^done\n`);
  return true;
};

/**
 * Startup preamble for a scripted fake GDB, placed after its shebang. One
 * buffered reader owns stdin: it answers each complete `-gdb-version` line
 * once and hands every other complete line to the scenario's `data`
 * listeners, so a scenario models only its own commands whatever the chunk
 * boundaries or listener count. Lines that arrive before the scenario
 * registers a listener wait for it.
 */
export const fakeGdbStartupPreamble = String.raw`{
  const listen = process.stdin.on.bind(process.stdin);
  const listeners = [];
  let partial = "";
  let undelivered = "";
  const deliver = () => {
    if (undelivered.length === 0 || listeners.length === 0) return;
    const lines = undelivered;
    undelivered = "";
    for (const listener of listeners) listener(lines);
  };
  process.stdin.setEncoding("utf8");
  listen("data", (chunk) => {
    partial += chunk;
    const end = partial.lastIndexOf("\n") + 1;
    for (const line of partial.slice(0, end).split(/(?<=\n)/u)) {
      const query = /^(\d+)-gdb-version\n$/u.exec(line);
      if (query === null) undelivered += line;
      else process.stdout.write(${JSON.stringify(fakeGdbVersionStream)} + query[1] + "^done\n");
    }
    partial = partial.slice(end);
    deliver();
  });
  process.stdin.on = process.stdin.addListener = (event, listener) => {
    if (event !== "data") return listen(event, listener);
    listeners.push(listener);
    setImmediate(deliver);
    return process.stdin;
  };
}`;

type GdbSessionStart = Awaited<ReturnType<GdbSessionManager["start"]>>;
type StartedGdbSession = Extract<GdbSessionStart, { readonly ok: true }>;

export const expectGdbSessionStarted = async (
  manager: GdbSessionManager,
  ...arguments_: Parameters<GdbSessionManager["start"]>
): Promise<StartedGdbSession> => {
  const started = await manager.start(...arguments_);
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error.message);
  return started;
};

/** The fixture, unlike GDB, knows these inert provider processes have no real inferior. */
export const createGdbFixtureOwner = (
  controls: {
    readonly stopOwnedProcess?: (
      supervisor: ProviderProcessSupervisor,
    ) => ReturnType<ProviderProcessSupervisor["stop"]>;
  } = {},
) => {
  const processes = new Set<ProviderProcessSupervisor>();
  const spawnProcess: typeof spawnOwnedProviderProcess = async (options) => {
    const launched = await spawnOwnedProviderProcess(options);
    processes.add(
      new ProviderProcessSupervisor(
        { ...launched, ownsProcessLifetime: true },
        { captureStdout: false, maxDiagnosticBytes: 0 },
      ),
    );
    return launched;
  };
  const cleanup = async (
    managers: Array<{ closeAll(): Promise<void> }>,
    removeFiles: () => Promise<void>,
  ): Promise<void> => {
    const outcomes = await Promise.allSettled(
      managers.map((manager) => manager.closeAll()),
    );
    // The tests intentionally model unknown inferior state. Only that tagged
    // refusal is discharged by the fixture's independent physical process owner.
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" &&
      !(outcome.reason instanceof OwnedDebuggerCleanupError)
        ? [outcome.reason as unknown]
        : [],
    );
    for (const supervisor of processes) {
      try {
        const result =
          controls.stopOwnedProcess === undefined
            ? await supervisor.stop()
            : await controls.stopOwnedProcess(supervisor);
        if (result.status === "incomplete")
          throw new Error(`Fake GDB cleanup incomplete: ${result.reason}`);
        if (supervisor.observedExit() === undefined)
          throw new Error("Fake GDB cleanup did not observe child exit");
        processes.delete(supervisor);
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Fake GDB fixture cleanup failed");
    managers.length = 0;
    await removeFiles();
  };
  return { spawnProcess, cleanup };
};
