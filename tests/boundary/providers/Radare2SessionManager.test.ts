import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { Radare2SessionManager } from "../../../src/radare2/Radare2SessionManager.js";
import { waitFor } from "../../support/testWait.js";
import type {
  ProviderProcessHandle,
  SpawnedOwnedProviderProcess,
} from "../../../src/process/ProviderProcess.js";

interface InjectedControl {
  output(chunk: Buffer | string): void;
  stderr(chunk: Buffer | string): void;
  exit(code: number | null, signal?: NodeJS.Signals): void;
}

const createInjectedProcess = (
  options: {
    readonly startup?: (control: InjectedControl) => void;
    readonly onWrite?: (text: string, control: InjectedControl) => void;
  } = {},
) => {
  const written: string[] = [];
  const createProcess = () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const handle = new EventEmitter() as EventEmitter &
      ProviderProcessHandle & {
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
    const control: InjectedControl = {
      output: (chunk) => {
        stdout.write(chunk);
      },
      stderr: (chunk) => {
        stderr.write(chunk);
      },
      exit: (code, signal) => {
        handle.exitCode = code;
        handle.signalCode = signal ?? null;
        handle.emit("exit", code, signal);
      },
    };
    Object.assign(handle, {
      pid: 4242,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => {
        if (handle.exitCode !== null) return false;
        handle.exitCode = null;
        handle.signalCode = "SIGTERM";
        queueMicrotask(() => handle.emit("exit", null, "SIGTERM"));
        return true;
      }),
      stdin: new Writable({
        write: (chunk: Buffer, _encoding, callback) => {
          const text = chunk.toString("utf8");
          written.push(text);
          options.onWrite?.(text, control);
          callback();
        },
      }),
    });
    return { handle, control };
  };
  const first = createProcess();
  let issued = false;
  const spawnProcess = vi.fn(async () => {
    const spawned = issued ? createProcess() : first;
    issued = true;
    options.startup?.(spawned.control);
    return {
      process: spawned.handle,
      ownership: {} as SpawnedOwnedProviderProcess["ownership"],
      cleanup: async () =>
        ({ cleaned: true as const, signaled: false }) as const,
    };
  });
  return { spawnProcess, control: first.control, written };
};

const jsonResponder =
  (res: string, extra: Record<string, unknown> = {}) =>
  (text: string, control: InjectedControl): void => {
    const lines = text.split("\n").filter((line) => line.length > 0);
    for (const line of lines) {
      let parsed: { cmd?: unknown };
      try {
        parsed = JSON.parse(line) as { cmd?: unknown };
      } catch {
        continue;
      }
      if (typeof parsed.cmd !== "string") continue;
      control.output(
        `${JSON.stringify({ res, error: false, value: 0, code: 0, ...extra })}\0`,
      );
    }
  };

describe("Radare2SessionManager lifecycle", () => {
  it("starts a session after the first NUL frame and echoes the spawn profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-r2-start-"));
    const artifact = join(directory, "fixture.bin");
    await writeFile(artifact, "fixture");
    const { spawnProcess, control } = createInjectedProcess({
      startup: (startupControl) => {
        startupControl.output("\0");
      },
    });
    const manager = new Radare2SessionManager(
      { REA_R2_COMMAND: "/selected/r2" },
      { spawnProcess },
    );

    try {
      const result = await manager.start({ path: artifact });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.session_id).toEqual(expect.any(String));
      expect(spawnProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "/selected/r2",
          arguments: [
            "-N",
            "-q",
            "-e",
            "scr.color=0",
            "-e",
            "scr.utf8=0",
            "-0",
            artifact,
          ],
          stdin: "pipe",
        }),
      );
      control.exit(0);
      await manager.closeAll();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("opens the caller-selected path without rewriting symlink-relative parents", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
    });
    const manager = new Radare2SessionManager({}, { spawnProcess });
    const selected = "/work/link/../sample";
    // POSIX resolves `..` after the preceding symlink, so only Win32 may
    // normalize it lexically.
    const expected =
      process.platform === "win32" ? win32.resolve(selected) : selected;

    const started = await manager.start({ path: selected });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: [
          "-N",
          "-q",
          "-e",
          "scr.color=0",
          "-e",
          "scr.utf8=0",
          "-0",
          expected,
        ],
      }),
    );
    expect(manager.status(started.value.session_id)?.resolved_path).toBe(
      expected,
    );
    await manager.closeAll();
  });

  it("executes a command over the r2pipe2 protocol and maps the reply", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-r2-exec-"));
    const artifact = join(directory, "fixture.bin");
    await writeFile(artifact, "fixture");
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
      onWrite: jsonResponder('{"functions":[]}'),
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 5_000 },
    );

    try {
      const started = await manager.start({ path: artifact });
      if (!started.ok) throw started.error;
      const executed = await manager.execute(started.value.session_id, "aflj");
      expect(executed.ok).toBe(true);
      if (!executed.ok) return;
      expect(executed.value.result.command).toBe("aflj");
      expect(executed.value.result.output).toBe('{"functions":[]}');
      expect(executed.value.result.command_error).toBe(false);
      expect(executed.value.result.command_code).toBe(0);
      expect(executed.value.result.command_logs).toEqual([]);
      expect(executed.value.result.completion_status).toBe("complete");
      expect(executed.value.evidence.provider.id).toBe("radare2.session");
    } finally {
      await manager.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves plugin failure logs from an error-free reply", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
      onWrite: jsonResponder("", {
        logs: [
          {
            type: "WARN",
            origin: "r2ghidra",
            message: "Ghidra Decompiler Error: No function at this offset",
          },
        ],
      }),
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 5_000 },
    );

    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    const executed = await manager.execute(
      started.value.session_id,
      "pdg @ main",
    );
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.value.result.output).toBe("");
    expect(executed.value.result.command_error).toBe(false);
    expect(executed.value.result.command_logs).toEqual([
      {
        type: "WARN",
        origin: "r2ghidra",
        message: "Ghidra Decompiler Error: No function at this offset",
      },
    ]);
  });
});

describe("Radare2SessionManager cancellation", () => {
  it("stops and retires the session when a dispatched command is cancelled", async () => {
    // Arrange
    const { spawnProcess, written } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
    });
    const manager = new Radare2SessionManager({}, { spawnProcess });
    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    const controller = new AbortController();

    // Act
    const executed = manager.execute(
      started.value.session_id,
      "aaa",
      controller.signal,
    );
    await waitFor(() =>
      expect(written.some((line) => line.includes("aaa"))).toBe(true),
    );
    controller.abort();
    const result = await executed;

    // Assert
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(written.at(-1)).toBe("q\n");
    expect(manager.status(started.value.session_id)).toBeUndefined();
  });

  it("keeps the running command's capture state when a queued command is cancelled", async () => {
    // Arrange
    let ownerControl: InjectedControl | undefined;
    const { spawnProcess, written } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
      onWrite: (_text, commandControl) => {
        ownerControl = commandControl;
      },
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 5_000 },
    );
    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;

    // Act: the first command keeps running, the second is cancelled while queued.
    const owner = manager.execute(started.value.session_id, "aaa");
    await waitFor(() =>
      expect(written.some((line) => line.includes("aaa"))).toBe(true),
    );
    const controller = new AbortController();
    const queued = manager.execute(
      started.value.session_id,
      "aflj",
      controller.signal,
    );
    controller.abort();
    const cancelled = await queued;
    ownerControl?.output("a".repeat(16 * 1024 * 1024 + 1));
    const result = await owner;

    // Assert: the running command still sees a bounded, truncated reply.
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok)
      expect(cancelled.error._tag).toBe("AnalysisCancelledError");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.result.output_truncated).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
    await manager.closeAll();
  });

  it("holds cancelled queued commands against the queue cap until their predecessor settles", async () => {
    // Arrange: one owner command runs without replying.
    let ownerControl: InjectedControl | undefined;
    const { spawnProcess, written } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
      onWrite: (_text, commandControl) => {
        ownerControl = commandControl;
      },
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 5_000 },
    );
    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    const owner = manager.execute(started.value.session_id, "aaa");
    await waitFor(() =>
      expect(written.some((line) => line.includes("aaa"))).toBe(true),
    );

    // Act: queue-and-cancel cycles must hold their reservations, so the owner
    // plus 15 cancelled waiters fill the 16-command cap and the next call is
    // rejected at the capacity check instead of growing the chain.
    for (let index = 0; index < 15; index += 1) {
      const controller = new AbortController();
      const queued = manager.execute(
        started.value.session_id,
        "aflj",
        controller.signal,
      );
      controller.abort();
      const cancelled = await queued;
      expect(cancelled.ok).toBe(false);
      if (!cancelled.ok)
        expect(cancelled.error._tag).toBe("AnalysisCancelledError");
    }
    const overflow = await manager.execute(started.value.session_id, "aflj");

    // Assert: the next queued command meets the capacity error, and the owner
    // still completes normally once its reply arrives.
    expect(overflow.ok).toBe(false);
    if (!overflow.ok)
      expect(overflow.error._tag).toBe("AnalysisResourceConstraintError");
    ownerControl?.output(
      `${JSON.stringify({ res: [], error: false, value: 0, code: 0 })}\0`,
    );
    const ownerResult = await owner;
    expect(ownerResult.ok).toBe(true);
    await manager.closeAll();
  });
});

describe("Radare2SessionManager command handling", () => {
  it("rejects multiline commands before writing to stdin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-r2-lines-"));
    const artifact = join(directory, "fixture.bin");
    await writeFile(artifact, "fixture");
    const { spawnProcess, written } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
    });
    const manager = new Radare2SessionManager({}, { spawnProcess });

    try {
      const started = await manager.start({ path: artifact });
      if (!started.ok) throw started.error;
      const executed = await manager.execute(
        started.value.session_id,
        "aflj\nq",
      );
      expect(executed.ok).toBe(false);
      if (!executed.ok) expect(executed.error._tag).toBe("AnalysisInputError");
      expect(written).toEqual([]);
    } finally {
      await manager.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("times out a command whose reply never arrives and stops the session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-r2-timeout-"));
    const artifact = join(directory, "fixture.bin");
    await writeFile(artifact, "fixture");
    const { spawnProcess } = createInjectedProcess({
      startup: (startupControl) => {
        startupControl.output("\0");
      },
      onWrite: () => {
        // No reply frame: the r2pipe2 answer never arrives.
      },
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 50 },
    );

    try {
      const started = await manager.start({ path: artifact });
      if (!started.ok) throw started.error;
      const executed = await manager.execute(started.value.session_id, "aaa");
      expect(executed.ok).toBe(false);
      if (!executed.ok) {
        expect(executed.error._tag).toBe("AnalysisTimeoutError");
        expect(
          JSON.stringify(executed.error.partialObservation ?? {}),
        ).toContain('"radare2.session"');
      }
      expect(manager.status(started.value.session_id)).toBeUndefined();
    } finally {
      await manager.closeAll();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects the ninth concurrent session with a capacity error", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
    });
    const manager = new Radare2SessionManager({}, { spawnProcess });
    const started = [];
    for (let index = 0; index < 8; index += 1)
      started.push(await manager.start({ path: `/tmp/f${index}` }));
    expect(started.every((result) => result.ok)).toBe(true);
    const ninth = await manager.start({ path: "/tmp/f8" });
    expect(ninth.ok).toBe(false);
    if (!ninth.ok)
      expect(ninth.error._tag).toBe("AnalysisResourceConstraintError");
  });

  it("surfaces bounded session stderr in status diagnostics", async () => {
    const { spawnProcess, control } = createInjectedProcess({
      startup: (startupControl) => {
        startupControl.output("\0");
      },
    });
    const manager = new Radare2SessionManager({}, { spawnProcess });
    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    control.stderr("WARN: ABI mismatch from plugin\n");
    const status = manager.status(started.value.session_id);
    expect(status?.recent_stderr).toContain("WARN: ABI mismatch");
    control.exit(0);
    await manager.close(started.value.session_id);
  });

  it("closes a session and removes it from the manager", async () => {
    const { spawnProcess, control } = createInjectedProcess({
      startup: (startupControl) => {
        startupControl.output("\0");
      },
    });
    const manager = new Radare2SessionManager({}, { spawnProcess });
    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    control.exit(0);
    const closed = await manager.close(started.value.session_id);
    expect(closed.ok).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
  });

  it("retains a session whose stop cannot be verified and frees it on retry", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (startupControl) => {
        startupControl.output("\0");
      },
    });
    let stopOutcome:
      | { status: "incomplete"; reason: string }
      | { status: "verified-cleanup" } = {
      status: "incomplete",
      reason: "injected uncertainty",
    };
    const manager = new Radare2SessionManager(
      {},
      {
        spawnProcess,
        stopProcess: async () => stopOutcome,
      },
    );
    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    const failed = await manager.close(started.value.session_id);
    if (failed.ok) throw new Error("the injected stop must fail");
    expect(failed.error.cleanupIncomplete).toBe(true);
    expect(manager.status(started.value.session_id)).toBeDefined();
    stopOutcome = { status: "verified-cleanup" };
    const retried = await manager.retryCleanupFailures();
    expect(retried.ok).toBe(true);
    // The verified retry resolves the retained ownership error so callers are
    // not left blocked on a cleanup failure that no longer exists.
    expect(failed.error.cleanupIncomplete).toBe(false);
    expect(manager.status(started.value.session_id)).toBeUndefined();
  });
});

describe("Radare2SessionManager r2pipe2 protocol failures", () => {
  it("retires a session whose oversized reply stopped it", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
      onWrite: (_text, commandControl) => {
        // Reply after the write returns: a synchronous frame would race the
        // protocol check that runs before the manager waits for the reply.
        queueMicrotask(() =>
          commandControl.output(`${"a".repeat(16 * 1024 * 1024 + 1)}\0`),
        );
      },
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 5_000 },
    );

    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    const executed = await manager.execute(
      started.value.session_id,
      "p8 100000000",
    );
    expect(executed.ok).toBe(true);
    if (executed.ok) expect(executed.value.result.output_truncated).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
    await manager.closeAll();
  });

  it("delivers the bounded frame without waiting for a delimiter that never arrives", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
      onWrite: (_text, commandControl) => {
        queueMicrotask(() =>
          commandControl.output("a".repeat(16 * 1024 * 1024 + 1)),
        );
      },
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 5_000 },
    );

    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    const executed = await manager.execute(
      started.value.session_id,
      "p8 100000000",
    );
    // A stalled reply must fail closed at the limit, not consume the timeout.
    expect(executed.ok).toBe(true);
    if (executed.ok) expect(executed.value.result.output_truncated).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
    await manager.closeAll();
  });

  it("retires a session whose process exits during a command", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
      onWrite: (_text, commandControl) => {
        commandControl.exit(1);
      },
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 5_000 },
    );

    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    const executed = await manager.execute(started.value.session_id, "aflj");
    expect(executed.ok).toBe(false);
    if (!executed.ok)
      expect(executed.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(manager.status(started.value.session_id)).toBeUndefined();
    await manager.closeAll();
  });

  it("stops the session when a r2pipe2 reply is not JSON", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
      onWrite: (_text, commandControl) => {
        commandControl.output("not json\0");
      },
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 5_000 },
    );

    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;
    const executed = await manager.execute(started.value.session_id, "aflj");
    expect(executed.ok).toBe(false);
    if (!executed.ok)
      expect(executed.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(manager.status(started.value.session_id)).toBeUndefined();
    await manager.closeAll();
  });
});

describe("Radare2SessionManager error replies", () => {
  it("keeps the session when a reply fails before producing output", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
      onWrite: (_text, commandControl) => {
        queueMicrotask(() =>
          commandControl.output(
            `${JSON.stringify({
              error: true,
              value: 0,
              code: 0,
              logs: [
                {
                  type: "ERROR",
                  origin: "r_core_cmd_subst_i",
                  message: "Invalid tmpseek address 'sym._nope'",
                },
              ],
            })}\0`,
          ),
        );
      },
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 5_000 },
    );
    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;

    const executed = await manager.execute(
      started.value.session_id,
      "pdg @ sym._nope",
    );

    // The failure belongs to the command, not the protocol: radare2 omits `res`
    // when it fails before producing output, and the reason arrives in logs.
    expect(executed.ok).toBe(true);
    if (executed.ok) {
      expect(executed.value.result.command_error).toBe(true);
      expect(executed.value.result.output).toBe("");
      expect(executed.value.result.command_logs[0]?.message).toContain(
        "Invalid tmpseek address",
      );
    }
    expect(manager.status(started.value.session_id)).toBeDefined();
    await manager.closeAll();
  });
});

describe("Radare2SessionManager shutdown", () => {
  it("rejects a shutdown that cannot verify its stop and frees the session on retry", async () => {
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
    });
    let stopOutcome:
      | { status: "incomplete"; reason: string }
      | { status: "verified-cleanup" } = {
      status: "incomplete",
      reason: "injected uncertainty",
    };
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, stopProcess: async () => stopOutcome },
    );
    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;

    await expect(manager.closeAll()).rejects.toThrow(AggregateError);
    expect(manager.status(started.value.session_id)).toBeDefined();

    stopOutcome = { status: "verified-cleanup" };
    const retried = await manager.retryCleanupFailures();
    expect(retried.ok).toBe(true);
    expect(manager.status(started.value.session_id)).toBeUndefined();
  });
});

describe("Radare2SessionManager provider resolution", () => {
  it("resolves the configured executable for the host platform", async () => {
    const { spawnProcess, control } = createInjectedProcess({
      startup: (startupControl) => {
        startupControl.output("\0");
      },
    });
    const resolveExecutable = vi.fn(
      (command: string) => `C:\\tools\\${command}.exe`,
    );
    const manager = new Radare2SessionManager(
      { REA_R2_COMMAND: "radare2" },
      { spawnProcess, platform: "win32", resolveExecutable },
    );
    const started = await manager.start({ path: "/tmp/f" });
    expect(started.ok).toBe(true);
    expect(resolveExecutable).toHaveBeenCalledWith(
      "radare2",
      expect.anything(),
      "win32",
    );
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.objectContaining({ command: "C:\\tools\\radare2.exe" }),
    );
    control.exit(0);
    await manager.closeAll();
  });
});

describe("Radare2SessionManager delivery views", () => {
  it("keeps the session when a reply holds JSON at the Evidence depth limit", async () => {
    let deep = "1";
    for (let index = 0; index < 1000; index += 1) deep = `[${deep}]`;
    const { spawnProcess } = createInjectedProcess({
      startup: (control) => {
        control.output("\0");
      },
      onWrite: (_text, commandControl) => {
        queueMicrotask(() =>
          commandControl.output(
            `${JSON.stringify({ res: deep, error: false, code: 0 })}\0`,
          ),
        );
      },
    });
    const manager = new Radare2SessionManager(
      {},
      { spawnProcess, frameTimeoutMs: 5_000 },
    );
    const started = await manager.start({ path: "/tmp/f" });
    if (!started.ok) throw started.error;

    const executed = await manager.execute(started.value.session_id, "ij");

    // The optional projection must degrade here: Evidence validates raw_result
    // one level deeper, and throwing would cost the caller the whole session.
    expect(executed.ok).toBe(true);
    if (executed.ok) expect(executed.value.result.parsed).toBeUndefined();
    expect(manager.status(started.value.session_id)).toBeDefined();
    await manager.closeAll();
  });
});
