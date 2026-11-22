import { open, realpath, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it, onTestFinished, vi } from "vitest";
import { createInjectedProcess } from "./RizinDebugSessionCoverage.fixtures.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";
import { rizinTestInferiorTty } from "./RizinTestInferiorTty.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { RizinDebugSessionManager } from "../../../src/rizin/RizinDebugSessionManager.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

it.skipIf(process.platform === "win32")(
  "retains the TTY descriptor when its close fails",
  async () => {
    const closeFailure = new Error("TTY descriptor close refused");
    let closeCalls = 0;
    let allowClose = false;
    await instrumentDescriptor("/dev/null", (handle, close) => {
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closeCalls++;
        if (!allowClose) throw closeFailure;
        await close();
      });
    });
    const manager = new RizinDebugSessionManager(
      {},
      {
        platform: "linux",
        spawnProcess: () => {
          throw new Error("unexpected spawn");
        },
      },
    );
    const result = await manager.start({
      path: "/fixture",
      inferior_tty: "/dev/null",
    });
    if (result.ok) throw new Error("expected TTY admission failure");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cause).toBeInstanceOf(AggregateError);
    const cleanupChild = (result.error.cause as AggregateError).errors[1];
    expect(cleanupChild.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toContain("/dev/null");
    expect(result.error.cleanupPrimary).toMatchObject({
      issues: [
        expect.objectContaining({
          message: expect.stringContaining("not a character TTY"),
        }),
      ],
    });
    expect(closeCalls).toBe(1);
    const retryFailure = await manager.retryCleanupFailures();
    if (retryFailure.ok) throw new Error("expected retry failure");
    expect(retryFailure.error.cleanupResources).toContain("/dev/null");
    expect(closeCalls).toBe(2);
    allowClose = true;
    expect((await manager.retryCleanupFailures()).ok).toBe(true);
    expect(closeCalls).toBe(3);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(cleanupChild.cleanupIncomplete).toBe(false);
    expect(retryFailure.error.cleanupIncomplete).toBe(false);
    await manager.closeAll();
  },
);

it.skipIf(process.platform === "win32")(
  "does not spawn Rizin when cancellation arrives during TTY validation",
  async () => {
    const tty = await realpath(await rizinTestInferiorTty());
    const controller = new AbortController();
    const reason = { cancelled: "during TTY validation" };
    await instrumentDescriptor(tty, () => controller.abort(reason));
    let spawned = false;
    const manager = new RizinDebugSessionManager(
      {},
      {
        platform: "linux",
        spawnProcess: () => {
          spawned = true;
          throw new Error("must not spawn after cancellation");
        },
      },
    );
    const result = await manager.start(
      { path: "/fixture", inferior_tty: tty },
      controller.signal,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", cause: reason },
    });
    expect(spawned).toBe(false);
    await manager.closeAll();
  },
);

it.skipIf(process.platform === "win32")(
  "preserves cancellation during final TTY close with failed cleanup",
  async () => {
    const tty = await realpath(await rizinTestInferiorTty());
    const controller = new AbortController();
    const reason = { cancelled: "during TTY close" };
    let closeCalls = 0;
    await instrumentDescriptor(tty, (handle, close) => {
      vi.spyOn(handle, "close").mockImplementation(async () => {
        if (++closeCalls === 1) {
          controller.abort(reason);
          throw new Error("close denied");
        }
        await close();
      });
    });
    const manager = new RizinDebugSessionManager(
      {},
      {
        platform: "linux",
        spawnProcess: () => {
          throw new Error("unexpected spawn");
        },
      },
    );
    const result = await manager.start(
      { path: "/fixture", inferior_tty: tty },
      controller.signal,
    );
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error.cleanupPrimary?.cause).toBe(reason);
    expect(result.error.cleanupIncomplete).toBe(true);
    await manager.closeAll();
    expect(result.error.cleanupIncomplete).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "retries a failed TTY owner without stopping a released session again",
  async () => {
    const tty = await realpath(await rizinTestInferiorTty());
    let opens = 0;
    let closeCalls = 0;
    let allowClose = false;
    await instrumentDescriptor(tty, (handle, close) => {
      if (++opens === 2)
        vi.spyOn(handle, "close").mockImplementation(async () => {
          closeCalls++;
          if (!allowClose) throw new Error("TTY close denied");
          await close();
        });
    });
    const injected = createInjectedProcess();
    let stops = 0;
    const manager = new RizinDebugSessionManager(
      {},
      {
        platform: "linux",
        spawnProcess: injected.spawnProcess,
        stopProcess: async () => {
          stops++;
          injected.control.exit();
          return { status: "stopped" };
        },
      },
    );
    onTestFinished(() => injected.control.exit());
    const first = await manager.start({
      path: "/fixture",
      inferior_tty: tty,
    });
    if (!first.ok) throw first.error;
    const second = await manager.start({
      path: "/fixture",
      inferior_tty: tty,
    });
    if (second.ok) throw new Error("expected failed TTY close");
    await expect(manager.closeAll()).rejects.toThrow();
    expect(stops).toBe(1);
    expect(closeCalls).toBe(2);
    allowClose = true;
    await manager.closeAll();
    expect(stops).toBe(1);
    expect(closeCalls).toBe(3);
    expect(second.error.cleanupIncomplete).toBe(false);
  },
);

type Debugger = "rizin" | "gdb";

const instrumentDescriptor = async (
  path: string,
  instrument: (handle: FileHandle, close: () => Promise<void>) => void,
) => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const releases: Array<() => Promise<void>> = [];
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[0] === path) {
      const close = handle.close.bind(handle);
      releases.push(close);
      instrument(handle, close);
    }
    return handle;
  });
  onTestFinished(async () => {
    try {
      await Promise.all(releases.map((close) => close()));
    } finally {
      vi.restoreAllMocks();
      vi.mocked(open).mockImplementation(actual.open);
    }
  });
};

const startWithLaunchFile = async (
  debuggerName: Debugger,
  path: string,
  signal?: AbortSignal,
) => {
  const spawnProcess = vi.fn(() => {
    throw new Error("must not spawn before file observation settles");
  });
  const options = { platform: "linux" as const, spawnProcess };
  if (debuggerName === "gdb") {
    const manager = new GdbSessionManager(options);
    const started = await manager.start(signal, { executable: path });
    expect(spawnProcess).not.toHaveBeenCalled();
    return { manager, started, operation: "start_gdb_session" };
  }

  const manager = new RizinDebugSessionManager({}, options);
  const started = await manager.start(
    { path, inferior_tty: await rizinTestInferiorTty() },
    signal,
  );
  expect(spawnProcess).not.toHaveBeenCalled();
  return { manager, started, operation: "start_rizin_debug_session" };
};

it.skipIf(process.platform === "win32").each(["rizin", "gdb"] as const)(
  "keeps the %s launch file read failure when its descriptor close also fails",
  async (debuggerName) => {
    const directory = await createTestTempDirectory(
      "rea-debugger-launch-read-",
    );
    const launchFile = join(directory, "target.bin");
    await writeFile(launchFile, "launch bytes");
    let closeCalls = 0;
    await instrumentDescriptor(launchFile, (handle, close) => {
      vi.spyOn(handle, "read").mockRejectedValue(
        new Error("launch file read refused"),
      );
      vi.spyOn(handle, "close").mockImplementation(async () => {
        if (++closeCalls === 1) throw new Error("launch file close refused");
        await close();
      });
    });

    const { manager, started, operation } = await startWithLaunchFile(
      debuggerName,
      launchFile,
    );
    if (started.ok) throw new Error("expected the failed close to fail start");
    expect(projectAnalysisError(started.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        operation,
        resources: [launchFile],
        diagnostics: {
          launch_file_hash_failure: expect.stringContaining(
            "launch file read refused",
          ),
        },
      },
    });
    expect(closeCalls).toBe(1);
    expect((await manager.retryCleanupFailures()).ok).toBe(true);
    expect(closeCalls).toBe(2);
    expect(started.error.cleanupIncomplete).toBe(false);
    await manager.closeAll();
  },
);

it.skipIf(process.platform === "win32").each([
  { debuggerName: "gdb", cancel: false, closeFails: true },
  { debuggerName: "rizin", cancel: true, closeFails: false },
  { debuggerName: "rizin", cancel: true, closeFails: true },
  { debuggerName: "gdb", cancel: true, closeFails: true },
] as const)(
  "preserves a completed $debuggerName launch hash (cancel: $cancel, close fails: $closeFails)",
  async ({ debuggerName, cancel, closeFails }) => {
    const directory = await createTestTempDirectory("rea-debugger-hash-close-");
    const launchFile = join(directory, "target.bin");
    const contents = "completed launch-file observation";
    await writeFile(launchFile, contents);
    const completed = {
      completed_hash: {
        sha256: createHash("sha256").update(contents).digest("hex"),
        bytes: Buffer.byteLength(contents),
      },
    };
    const controller = new AbortController();
    const reason = { cancelled: "after launch hash" };
    let closeCalls = 0;
    await instrumentDescriptor(launchFile, (handle, close) => {
      vi.spyOn(handle, "close").mockImplementation(async () => {
        if (++closeCalls === 1 && closeFails) {
          if (cancel) controller.abort(reason);
          throw new Error("launch file close refused");
        }
        await close();
        if (cancel && closeCalls === 1) controller.abort(reason);
      });
    });

    const { manager, started, operation } = await startWithLaunchFile(
      debuggerName,
      launchFile,
      controller.signal,
    );
    if (started.ok) throw new Error("expected finalization to fail startup");
    expect(started.error.cleanupIncomplete).toBe(closeFails);
    const observed = started.error.cleanupPrimary ?? started.error;
    expect(projectAnalysisError(observed).details).toMatchObject({
      operation,
      diagnostics: completed,
    });
    if (cancel) {
      expect(observed._tag).toBe("AnalysisCancelledError");
      expect(observed.cause).toBe(reason);
    }
    expect(closeCalls).toBe(1);
    expect((await manager.retryCleanupFailures()).ok).toBe(true);
    expect(started.error.cleanupIncomplete).toBe(false);
    expect(closeCalls).toBe(closeFails ? 2 : 1);
    expect(
      projectAnalysisError(started.error).details?.diagnostics,
    ).toMatchObject(completed);
    await manager.closeAll();
  },
);
