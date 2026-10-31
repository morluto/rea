import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type ProviderProcessHandle,
} from "../../../src/process/ProviderProcess.js";
import { stopOwnedDebuggerProcess } from "../../../src/process/ownedDebuggerSession.js";
import { createInjectedProcess } from "./RizinDebugSessionCoverage.fixtures.js";
import {
  createRizinTestManager,
  rizinTestInferiorTty,
} from "./RizinTestInferiorTty.js";

const targets = new Set<ProviderProcessSupervisor>();
const directories = new Set<string>();

async function assertStaleRetry(
  manager: ReturnType<typeof createRizinTestManager>,
  sessionId: string,
  staleInventory: { value: boolean },
  inferior: ProviderProcessSupervisor,
  process: ProviderProcessHandle,
): Promise<void> {
  const liveRetry = await manager.retryCleanupFailures();
  expect(liveRetry.ok).toBe(false);
  expect(manager.status(sessionId)).toBeDefined();
  staleInventory.value = true;
  process.kill("SIGUSR1");
  expect(await inferior.waitForExit(1_000)).toBe(true);
  const endedRetry = await manager.retryCleanupFailures();
  expect(endedRetry.ok).toBe(false);
  expect(manager.status(sessionId)).toBeDefined();
  const finalRetry = await manager.retryCleanupFailures();
  expect(finalRetry.ok).toBe(true);
  expect(manager.status(sessionId)).toBeUndefined();
}

function createStopProcess(
  mode: string,
  attempts: { value: number },
):
  | typeof stopOwnedDebuggerProcess
  | ((
      ...args: Parameters<typeof stopOwnedDebuggerProcess>
    ) => ReturnType<typeof stopOwnedDebuggerProcess>) {
  return async (session, name, options) => {
    if (mode === "stale-retry" && attempts.value++ < 3) {
      await session.detachInferior?.();
      return {
        status: "incomplete",
        reason: "injected debugger stop uncertainty",
      };
    }
    return stopOwnedDebuggerProcess(session, name, options);
  };
}

async function assertClosedState(
  mode: string,
  closed: Awaited<
    ReturnType<ReturnType<typeof createRizinTestManager>["close"]>
  >,
  manager: ReturnType<typeof createRizinTestManager>,
  sessionId: string,
  debuggerExit: ReturnType<typeof vi.spyOn>,
  supervisor: ProviderProcessSupervisor,
  staleInventory: { value: boolean },
  inferiorProcess: ProviderProcessHandle,
): Promise<void> {
  if (mode === "exit") {
    expect(closed.ok).toBe(true);
    expect(manager.status(sessionId)).toBeUndefined();
    expect(supervisor.observedExit()?.code).toBe(0);
    return;
  }
  expect(closed.ok).toBe(false);
  expect(manager.status(sessionId)).toBeDefined();
  expect(debuggerExit).not.toHaveBeenCalled();
  if (mode === "redirect" || mode === "stale-retry")
    expect(supervisor.observedExit()).toBeUndefined();
  else expect(supervisor.observedExit()?.code).toBe(0);
  if (!closed.ok)
    expect(closed.error.message).toContain(
      mode === "redirect"
        ? "not routed to the selected TTY"
        : mode === "stale-retry"
          ? "injected debugger stop uncertainty"
          : "dbg.exitkills readback did not confirm false",
    );
  if (mode === "stale-retry")
    await assertStaleRetry(
      manager,
      sessionId,
      staleInventory,
      supervisor,
      inferiorProcess,
    );
}

afterEach(async () => {
  const failures: Error[] = [];
  for (const supervisor of targets) {
    const stopped = await supervisor.stop();
    if (stopped.status === "incomplete")
      failures.push(new Error(`Fixture cleanup incomplete: ${stopped.reason}`));
    else targets.delete(supervisor);
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Retained owned inferior fixtures");
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
    directories.delete(directory);
  }
});

it
  .skipIf(process.platform !== "linux")
  .each(["exit", "redirect", "ambiguous-policy", "stale-retry"] as const)(
  "verifies the original inferior after %s during detach",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "rea-rizin-exit-"));
    directories.add(directory);
    const ready = join(directory, "ready");
    const redirected = join(directory, "redirected");
    const tty = await rizinTestInferiorTty();
    const launched = await spawnOwnedProviderProcess({
      command: process.execPath,
      arguments: [
        "-e",
        `const fs = require("node:fs");
const [tty, ready, redirected, mode] = process.argv.slice(1);
function route(destination) {
  for (const fd of [1, 2]) {
    fs.closeSync(fd);
    if (fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_NOCTTY) !== fd)
      throw new Error("Unexpected fixture descriptor allocation");
  }
}
route(tty);
fs.writeFileSync(ready, "ready");
process.on("SIGUSR1", () => {
  if (mode === "exit" || mode === "ambiguous-policy" || mode === "stale-retry")
    process.exit(0);
  route("/dev/null");
  fs.writeFileSync(redirected, "redirected");
});
setInterval(() => {}, 1000);
`,
        tty,
        ready,
        redirected,
        mode,
      ],
      runId: randomUUID(),
    });
    const supervisor = new ProviderProcessSupervisor(
      { ...launched, ownsProcessLifetime: true },
      { captureStdout: false, maxDiagnosticBytes: 0 },
    );
    targets.add(supervisor);
    let descriptorOpen = true;
    let ambiguousPolicyReadbackSent = false;
    const staleInventory = { value: false };
    const stopAttempts = { value: 0 };
    let commandTail = Promise.resolve();
    let protocolFailure: unknown;
    const injected = createInjectedProcess({
      onWrite: (text, control) => {
        commandTail = commandTail
          .then(async () => {
            for (const line of text.trimEnd().split("\n")) {
              if (line === "olj")
                control.output(
                  JSON.stringify(
                    descriptorOpen || staleInventory.value
                      ? [
                          {
                            raised: true,
                            fd: 3,
                            uri: `ptrace://${launched.process.pid}`,
                          },
                        ]
                      : [],
                  ) + "\0",
                );
              else if (line === "o- 3") {
                descriptorOpen = false;
                if (mode !== "ambiguous-policy" && mode !== "stale-retry") {
                  launched.process.kill("SIGUSR1");
                  if (mode === "exit") {
                    expect(await supervisor.waitForExit(1_000)).toBe(true);
                  } else
                    await expect
                      .poll(() => readFile(redirected, "utf8"), {
                        timeout: 1_000,
                      })
                      .toBe("redirected");
                }
              } else if (line === "e dbg.exitkills") {
                if (
                  mode === "ambiguous-policy" &&
                  !descriptorOpen &&
                  !ambiguousPolicyReadbackSent
                ) {
                  ambiguousPolicyReadbackSent = true;
                  // End the identified process only during the final policy query.
                  launched.process.kill("SIGUSR1");
                  expect(await supervisor.waitForExit(1_000)).toBe(true);
                  control.output("ambiguous\0");
                } else control.output("false\0");
              } else if (line.startsWith("!echo "))
                control.output(`${line.slice(6)}\0`);
            }
          })
          .catch((cause: unknown) => {
            protocolFailure = cause;
            control.exit();
          });
      },
    });
    const debuggerExit = vi.spyOn(injected.control, "exit");
    const manager = createRizinTestManager(
      {},
      {
        spawnProcess: injected.spawnProcess,
        stopProcess: createStopProcess(mode, stopAttempts),
        readProcessTracerPid: async () => process.pid,
      },
    );
    try {
      await expect
        .poll(() => readFile(ready, "utf8"), { timeout: 2_000 })
        .toBe("ready");
      const started = await manager.start({
        path: "fixture.bin",
        inferior_tty: tty,
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      const closed = await manager.close(started.value.session_id);
      await commandTail;
      if (protocolFailure !== undefined) throw protocolFailure;
      await assertClosedState(
        mode,
        closed,
        manager,
        started.value.session_id,
        debuggerExit,
        supervisor,
        staleInventory,
        launched.process,
      );
    } finally {
      const stopped = await supervisor.stop();
      try {
        await manager.closeAll();
      } finally {
        injected.control.exit();
      }
      if (stopped.status === "incomplete")
        throw new Error(`Fixture cleanup incomplete: ${stopped.reason}`);
    }
  },
);
