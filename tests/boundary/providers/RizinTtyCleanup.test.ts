import { isatty } from "node:tty";
import { open } from "node:fs/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import { createInjectedProcess } from "./RizinDebugSessionCoverage.fixtures.js";
import { RizinDebugSessionManager } from "../../../src/rizin/RizinDebugSessionManager.js";

vi.mock("node:tty", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:tty")>();
  return { ...actual, isatty: vi.fn(actual.isatty) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

it.skipIf(process.platform === "win32")(
  "retains the TTY descriptor when its close fails",
  async () => {
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const closeFailure = new Error("TTY descriptor close refused");
    let closeCalls = 0;
    let closeFixture: (() => Promise<void>) | undefined;
    let allowClose = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      closeFixture = close;
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closeCalls++;
        if (!allowClose) throw closeFailure;
        await close();
      });
      return handle;
    });
    onTestFinished(async () => {
      await closeFixture?.().catch(() => undefined);
      vi.restoreAllMocks();
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
  "preserves cancellation during final TTY close with failed cleanup",
  async () => {
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(isatty).mockReturnValue(true);
    const controller = new AbortController();
    const reason = { cancelled: "during TTY close" };
    let releaseFixture: (() => Promise<void>) | undefined;
    let closeCalls = 0;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      releaseFixture = close;
      vi.spyOn(handle, "close").mockImplementation(async () => {
        if (++closeCalls === 1) {
          controller.abort(reason);
          throw new Error("close denied");
        }
        await close();
      });
      return handle;
    });
    onTestFinished(async () => {
      await releaseFixture?.().catch(() => undefined);
      vi.restoreAllMocks();
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
      { path: "/fixture", inferior_tty: "/dev/null" },
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
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(isatty).mockReturnValue(true);
    let opens = 0;
    let closeCalls = 0;
    let allowClose = false;
    let releaseFixture: (() => Promise<void>) | undefined;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (++opens === 2) {
        const close = handle.close.bind(handle);
        releaseFixture = close;
        vi.spyOn(handle, "close").mockImplementation(async () => {
          closeCalls++;
          if (!allowClose) throw new Error("TTY close denied");
          await close();
        });
      }
      return handle;
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
    onTestFinished(async () => {
      injected.control.exit();
      await releaseFixture?.().catch(() => undefined);
      vi.restoreAllMocks();
    });
    const first = await manager.start({
      path: "/fixture",
      inferior_tty: "/dev/null",
    });
    if (!first.ok) throw first.error;
    const second = await manager.start({
      path: "/fixture",
      inferior_tty: "/dev/null",
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
