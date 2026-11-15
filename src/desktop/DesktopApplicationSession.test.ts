import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  terminateTokenOwnedProcesses,
  type TokenOwnedTerminationHost,
} from "../process/TokenOwnedTermination.js";
import * as providerProcess from "../process/ProviderProcess.js";
import { systemProcessOwnershipHost } from "../process/ProcessOwnershipObservation.js";
import * as sessionObservations from "./DesktopSessionObservations.js";
import type { ProcessCleanupResult } from "../process/ProcessOwnership.js";
import * as runTokenObservations from "../process/ProcessRunTokenObservations.js";
import { isProcessOwnershipInspectionCancellation } from "../process/ProcessInspectionCancellation.js";
import { assertArtifactReadActive } from "../artifacts/ArtifactFileOperation.js";
import {
  runDesktopSession,
  type DesktopSessionPlan,
} from "./DesktopApplicationSession.js";
import { X11WindowObserver } from "./X11WindowObserver.js";

vi.mock("../process/TokenOwnedTermination.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../process/TokenOwnedTermination.js")
    >();
  return {
    ...actual,
    terminateTokenOwnedProcesses: vi.fn(actual.terminateTokenOwnedProcesses),
  };
});

const noWindows = {
  sample: async () => ({ state: "listed", windows: [] }),
} as unknown as X11WindowObserver;

/** A plan that launches `script` with sh and never sends a request. */
const shellPlan = (
  root: string,
  script: string,
  windows: X11WindowObserver = noWindows,
): DesktopSessionPlan => ({
  argv: ["/bin/sh", "-c", script],
  workingDirectory: root,
  environment: { PATH: "/usr/bin:/bin" },
  windows,
  windowMatching: { names: new Set(), byPid: true },
  roots: [],
  maxDurationMs: 20_000,
  pollIntervalMs: 50,
  nextRequest: () => undefined,
  checkpoint: async () => {},
  report: async () => {},
  signal: undefined,
});

/** Real inert child lifetime; native inspection facts are deliberately not claimed. */
const inertSessionPorts = () => {
  let child: providerProcess.ProviderProcessHandle | undefined;
  let lifetime: Promise<void> | undefined;
  let closed = false;
  let stdoutEnded = false;
  let stderrEnded = false;
  let releases = 0;
  const unexpectedSignal = () => {
    throw new Error("inert closed child must not be signalled");
  };
  const host: TokenOwnedTerminationHost = {
    ownership: {
      platform: process.platform,
      listProcesses: async () => {
        expect(closed && stdoutEnded && stderrEnded).toBe(true);
        return [];
      },
      environment: async () => {
        throw new Error("no live fixture process needs a token read");
      },
      signalGroup: unexpectedSignal,
    },
    signalProcess: unexpectedSignal,
  };
  vi.spyOn(systemProcessOwnershipHost, "prepare").mockResolvedValue(undefined);
  if (systemProcessOwnershipHost.captureBaseline === undefined)
    throw new Error(
      "inert session requires the existing capture baseline port",
    );
  vi.spyOn(systemProcessOwnershipHost, "captureBaseline").mockResolvedValue([
    { pid: process.pid, identity: null },
  ]);
  vi.spyOn(sessionObservations, "trackProcess").mockResolvedValue(undefined);
  const spawn = providerProcess.spawnOwnedProviderProcess;
  vi.spyOn(providerProcess, "spawnOwnedProviderProcess").mockImplementationOnce(
    async (options) => {
      const spawned = await spawn({ ...options, stdin: "pipe" });
      child = spawned.process;
      vi.spyOn(spawned.process, "kill").mockImplementation(unexpectedSignal);
      spawned.process.stdout?.once("end", () => {
        stdoutEnded = true;
      });
      spawned.process.stderr?.once("end", () => {
        stderrEnded = true;
      });
      const drained = new Promise<void>((resolve, reject) => {
        spawned.process.once("error", reject);
        spawned.process.once("close", () => {
          closed = true;
          resolve();
        });
      });
      lifetime = drained;
      return {
        ...spawned,
        cleanup: async (): Promise<ProcessCleanupResult> => {
          releases += 1;
          if (!closed) spawned.process.stdin?.end();
          await drained;
          expect(closed && stdoutEnded && stderrEnded).toBe(true);
          return { cleaned: true, signaled: false };
        },
      };
    },
  );
  return {
    argv: [
      process.execPath,
      "-e",
      "process.stdin.resume();process.stdin.once('end',()=>process.exit(0));",
    ],
    host,
    finish: async () => {
      if (child === undefined || lifetime === undefined)
        throw new Error("inert child was not launched");
      if (!closed) child.stdin?.end();
      await lifetime;
      expect(closed && stdoutEnded && stderrEnded).toBe(true);
    },
    releases: () => releases,
  };
};

describe.skipIf(process.platform !== "linux")("runDesktopSession", () => {
  it("releases the application once when the exit checkpoint fails after release", async () => {
    const root = await createTestTempDirectory("desktop-session-");
    const failure = new Error("exit checkpoint failed");
    const checkpoints: string[] = [];
    const plan: DesktopSessionPlan = {
      ...shellPlan(root, "trap 'exit 0' TERM; while :; do sleep 0.1; done"),
      nextRequest: () => ({ kind: "stop" }),
      checkpoint: async (name) => {
        checkpoints.push(name);
        if (name === "exit") throw failure;
      },
    };

    await expect(runDesktopSession(plan)).rejects.toBe(failure);
    expect(checkpoints).toEqual(["stop", "exit"]);
    expect(vi.mocked(terminateTokenOwnedProcesses)).toHaveBeenCalledTimes(1);
  });

  it("launches the application without the agent environment's variables", async () => {
    const root = await createTestTempDirectory("desktop-session-env-");
    const plan = shellPlan(root, `env > "${join(root, "env")}"`);

    await runDesktopSession({
      ...plan,
      environment: {
        ...plan.environment,
        AGENTENV_CONTROL_TOKEN: "control",
        AGENTENV_URL: "http://127.0.0.1:1",
        NOT_AGENTENV_KEPT: "kept",
      },
    });

    const names = (await readFile(join(root, "env"), "utf8"))
      .split("\n")
      .map((line) => line.split("=")[0]);
    expect(names.filter((name) => name?.startsWith("AGENTENV_"))).toEqual([]);
    expect(names).toEqual(
      expect.arrayContaining([
        "NOT_AGENTENV_KEPT",
        "PATH",
        "REA_PROCESS_RUN_ID",
      ]),
    );
  });
});

describe.skipIf(process.platform !== "linux")(
  "runDesktopSession natural exit",
  () => {
    it("keeps watching a worker whose launcher exited before it was sampled", async () => {
      const root = await createTestTempDirectory("desktop-session-worker-");
      // The middle shell exits at once, so no parent link reaches the worker.
      const outcome = await runDesktopSession(
        shellPlan(
          root,
          `( (sleep 1; touch "${join(root, "done")}") & ); exit 0`,
        ),
      );

      expect(outcome.session.end_reason).toBe("application_exited");
      expect(await readdir(root)).toContain("done");
      expect(
        outcome.session.processes.filter(
          (entry) =>
            entry.started_by_capture &&
            entry.pid !== outcome.session.launch_pid,
        ).length,
      ).toBeGreaterThan(0);
    });

    it("does not take samples whose window list was unreadable as the application having exited", async () => {
      const root = await createTestTempDirectory("desktop-session-unread-");
      let samples = 0;
      const windows = {
        sample: async () => {
          samples += 1;
          return samples <= 4
            ? { state: "display_unreadable" }
            : { state: "listed", windows: [] };
        },
      } as unknown as X11WindowObserver;

      const outcome = await runDesktopSession(
        shellPlan(root, "exit 0", windows),
      );

      expect(outcome.session.end_reason).toBe("application_exited");
      expect(outcome.unreadableWindowSamples).toBe(4);
      expect(samples).toBeGreaterThanOrEqual(6);
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "runDesktopSession finalization",
  () => {
    it.each([
      { fails: false, cancelAt: "cleanup" },
      { fails: true, cancelAt: "cleanup" },
      { fails: false, cancelAt: "exit" },
      { fails: true, cancelAt: "checkpoint" },
      { fails: false, cancelAt: "checkpoint" },
      { fails: false, cancelAt: "poll" },
      { fails: false, cancelAt: "tokens" },
    ])(
      "preserves the session outcome when cancellation arrives during $cancelAt (checkpoint fails: $fails)",
      async ({ fails, cancelAt }) => {
        const root = await createTestTempDirectory(
          "desktop-session-final-cancel-",
        );
        const controller = new AbortController();
        const reason = new Error("cancelled during cleanup");
        const failure = new Error("stop checkpoint failed");
        const terminate = vi.mocked(terminateTokenOwnedProcesses);
        terminate.mockImplementationOnce(async (...args) => {
          if (cancelAt === "cleanup") controller.abort(reason);
          const original = await vi.importActual<
            typeof import("../process/TokenOwnedTermination.js")
          >("../process/TokenOwnedTermination.js");
          if (inert !== undefined) await inert.finish();
          return inert === undefined
            ? original.terminateTokenOwnedProcesses(...args)
            : original.terminateTokenOwnedProcesses(
                args[0],
                args[1],
                inert.host,
              );
        });
        const inert =
          cancelAt === "checkpoint" ||
          cancelAt === "poll" ||
          cancelAt === "tokens"
            ? inertSessionPorts()
            : undefined;
        const windows = new X11WindowObserver(process.execPath, {});
        if (cancelAt === "poll" || cancelAt === "tokens")
          vi.spyOn(windows, "sample").mockImplementation(async () => {
            if (cancelAt === "tokens") await inert!.finish();
            else controller.abort(reason);
            return { state: "listed", windows: [] };
          });
        let tokenFailure: unknown;
        if (cancelAt === "tokens") {
          vi.spyOn(
            systemProcessOwnershipHost,
            "listProcesses",
          ).mockImplementation(async () => {
            await inert!.finish();
            controller.abort(reason);
            return [];
          });
          const read = runTokenObservations.readRunTokenCarriers;
          vi.spyOn(
            runTokenObservations,
            "readRunTokenCarriers",
          ).mockImplementation(async (...args) => {
            try {
              return await read(...args);
            } catch (cause: unknown) {
              tokenFailure = cause;
              throw cause;
            }
          });
        }
        const checkpoints: string[] = [];
        const plan: DesktopSessionPlan = {
          ...shellPlan(root, "exit 0"),
          ...(inert === undefined ? {} : { argv: inert.argv }),
          ...(cancelAt === "poll" || cancelAt === "tokens" ? { windows } : {}),
          signal: controller.signal,
          nextRequest: () =>
            cancelAt === "poll" || cancelAt === "tokens"
              ? undefined
              : { kind: "stop" },
          checkpoint: async (name: string) => {
            checkpoints.push(name);
            if (cancelAt === "checkpoint") {
              await inert!.finish();
              controller.abort(reason);
              if (!fails) assertArtifactReadActive(controller.signal);
            }
            if (cancelAt === "exit" && name === "exit")
              controller.abort(reason);
            if (fails) throw failure;
          },
        };
        try {
          const result = await runDesktopSession(plan).catch(
            (cause: unknown) => cause,
          );
          if (cancelAt === "tokens") {
            expect(isProcessOwnershipInspectionCancellation(tokenFailure)).toBe(
              true,
            );
            if (!isProcessOwnershipInspectionCancellation(tokenFailure))
              throw new Error(
                "expected actual token observation cancellation fact",
              );
            expect(tokenFailure.reason).toBe(reason);
          }
          if (fails) expect(result).toBe(failure);
          else
            expect(result).toMatchObject({
              session: { end_reason: "cancelled", cleanup: { verified: true } },
            });
          expect(checkpoints).toEqual(
            cancelAt === "poll" || cancelAt === "tokens"
              ? []
              : cancelAt === "exit"
                ? ["stop", "exit"]
                : ["stop"],
          );
          if (inert !== undefined) expect(inert.releases()).toBe(1);
        } finally {
          if (inert !== undefined) {
            await inert.finish();
            vi.restoreAllMocks();
          }
        }
      },
    );
  },
);

describe.skipIf(process.platform === "win32")(
  "runDesktopSession diagnostics",
  () => {
    it("keeps the end of an app's stderr when it writes more than the session keeps", async () => {
      const root = await createTestTempDirectory("desktop-session-stderr-");
      const cause =
        "[error] notes: Unable to find an appropriate java runtime.";
      // About 16 KiB of warnings, then the cause, as an app that fails at launch writes.
      const outcome = await runDesktopSession(
        shellPlan(
          root,
          `i=0; while [ $i -lt 400 ]; do echo "[warning] notes: probing runtime $i of 400" >&2; i=$((i+1)); done; echo '${cause}' >&2; exit 1`,
        ),
      );

      const { stderr, stderr_truncated } = outcome.session;
      expect(stderr.trimEnd().endsWith(cause)).toBe(true);
      expect(stderr).not.toContain("runtime 0 of 400");
      expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(8 * 1024);
      expect(stderr_truncated).toBe(true);
    });

    it("gives each checkpoint the titles the app's own windows have shown so far", async () => {
      const root = await createTestTempDirectory("desktop-session-titles-");
      const window = (id: string, name: string, title: string) => ({
        id,
        instance: name.toLowerCase(),
        class: name,
        title,
        pid: null,
        window_type: null,
      });
      let samples = 0;
      // The app's window closes after a few samples, so the session ends with it.
      const windows = {
        sample: async () => ({
          state: "listed",
          windows:
            (samples += 1) > 5
              ? []
              : [
                  window("0x1", "Notes", "today.txt - Notes"),
                  window("0x2", "Other", "unrelated.txt - Other"),
                ],
        }),
      } as unknown as X11WindowObserver;
      const seen: (readonly string[])[] = [];

      await runDesktopSession({
        ...shellPlan(root, "sleep 1", windows),
        windowMatching: { names: new Set(["notes"]), byPid: false },
        checkpoint: async (_name, _trigger, _atMs, { titles }) => {
          seen.push(titles);
        },
      });

      expect(seen.at(-1)).toEqual(["today.txt - Notes"]);
    });

    it("launches the app with glibc's fatal errors sent to its stderr, not its terminal", async () => {
      const root = await createTestTempDirectory("desktop-session-libc-");

      const outcome = await runDesktopSession(
        shellPlan(
          root,
          'echo "LIBC_FATAL_STDERR_=$LIBC_FATAL_STDERR_" >&2; exit 1',
        ),
      );

      expect(outcome.session.stderr).toContain("LIBC_FATAL_STDERR_=1");
    });
  },
);
