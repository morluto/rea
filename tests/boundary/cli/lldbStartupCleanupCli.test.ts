import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import pino from "pino";
import { expect, it, vi } from "vitest";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../../src/domain/analysisErrorCore.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { err, ok } from "../../../src/domain/result.js";
import { cliCommand } from "../../../src/cli/commandRegistry.js";
import { registerReverseEngineeringCommands } from "../../../src/cli/reverseEngineeringCommands.js";
import { CLI_COMMANDS } from "../../../src/contracts/cliCommandNames.js";
import type { CliInstance } from "../../../src/cli/types.js";
import { LLDB_PROVIDER_IDENTITY } from "../../../src/lldb/LldbProviderIdentity.js";
import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import { LldbSessionManager } from "../../../src/lldb/LldbSessionManager.js";
import type { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";

const registerLldbCommand = (
  createManager: () => LldbSessionManager,
): {
  run(input: {
    args: { command: string };
    options: { path?: string };
    formatExplicit?: boolean;
  }): Promise<unknown>;
} => {
  const cli = {} as unknown as CliInstance;
  registerReverseEngineeringCommands(
    cli,
    pino({ enabled: false }),
    {},
    undefined,
    undefined,
    () => createManager(),
  );
  const entry = cliCommand(cli, CLI_COMMANDS.debugWithLldb);
  if (entry === undefined)
    throw new Error("LLDB CLI command was not registered");
  return entry.definition as unknown as {
    run(input: {
      args: { command: string };
      options: { path?: string };
      formatExplicit?: boolean;
    }): Promise<unknown>;
  };
};

it("retries retained LLDB cleanup when CLI session startup fails", async () => {
  const closeAll = vi.fn(async () => undefined);
  const manager = {
    start: vi.fn(async () =>
      err(new AnalysisOutputError("start_lldb_session", "startup failed")),
    ),
    closeAll,
  } as unknown as LldbSessionManager;
  const originalExitCode = process.exitCode;
  const command = registerLldbCommand(() => manager);

  try {
    const result = await command.run({
      args: { command: "version" },
      options: {},
    });
    expect(result).toMatchObject({ code: "unreadable_output" });
    expect(manager.start).toHaveBeenCalledOnce();
    expect(closeAll).toHaveBeenCalledOnce();
  } finally {
    process.exitCode = originalExitCode;
  }
});

it("marks the CLI failed when retained LLDB cleanup remains incomplete", async () => {
  const manager = {
    start: vi.fn(async () =>
      err(new AnalysisOutputError("start_lldb_session", "startup failed")),
    ),
    closeAll: vi.fn(async () => {
      throw new Error("target still owned");
    }),
  } as unknown as LldbSessionManager;
  const originalExitCode = process.exitCode;
  const command = registerLldbCommand(() => manager);

  try {
    const result = await command.run({
      args: { command: "version" },
      options: {},
    });
    expect(result).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        diagnostics: { primary_error: { code: "unreadable_output" } },
      },
    });
    expect(manager.closeAll).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

it("executes LLDB command through public CLI and performs clean session close", async () => {
  const sessionId = "lldb-test-session-1";
  const evidence = createEvidence(
    {
      kind: "session",
      session_kind: "lldb",
      id: sessionId,
      target: unknownTarget("not-observed"),
    },
    LLDB_PROVIDER_IDENTITY,
    {
      predicateType: "rea.debugger.console-observation",
      operation: "lldb_command",
      parameters: { session_id: sessionId, command: "version" },
      result: {
        command: "version",
        output: "lldb-1700.0.13.2",
        completion_status: "complete",
        output_truncated: false,
      },
      rawResult: {
        command: "version",
        output: "lldb-1700.0.13.2",
        completion_status: "complete",
        output_truncated: false,
      },
    },
  );
  const close = vi.fn(async () =>
    ok({ target_state: "none_observed" as const }),
  );
  const closeAll = vi.fn(async () => undefined);
  const manager = {
    start: vi.fn(async () =>
      ok({
        session_id: sessionId,
        state: "ready" as const,
        pid: null,
        target: null,
      }),
    ),
    execute: vi.fn(async () =>
      ok({
        result: {
          command: "version",
          output: "lldb-1700.0.13.2",
          completion_status: "complete" as const,
          output_truncated: false,
        },
        evidence,
      }),
    ),
    close,
    closeAll,
  } as unknown as LldbSessionManager;

  const command = registerLldbCommand(() => manager);
  const result = await command.run({
    args: { command: "version" },
    options: {},
  });
  expect(result).toMatchObject({
    predicate_type: "rea.debugger.console-observation",
  });
  expect(manager.start).toHaveBeenCalledOnce();
  expect(manager.execute).toHaveBeenCalledWith(
    sessionId,
    "version",
    expect.anything(),
  );
  expect(close).toHaveBeenCalledWith(sessionId);
  expect(closeAll).toHaveBeenCalledOnce();
});

it("retains ownership and marks CLI failed when close fails after collecting command output", async () => {
  const sessionId = "lldb-test-session-2";
  const evidence = createEvidence(
    {
      kind: "session",
      session_kind: "lldb",
      id: sessionId,
      target: unknownTarget("not-observed"),
    },
    LLDB_PROVIDER_IDENTITY,
    {
      predicateType: "rea.debugger.console-observation",
      operation: "lldb_command",
      parameters: { session_id: sessionId, command: "register read" },
      result: {
        command: "register read",
        output: "x0 = 0x0",
        completion_status: "complete",
        output_truncated: false,
      },
      rawResult: {
        command: "register read",
        output: "x0 = 0x0",
        completion_status: "complete",
        output_truncated: false,
      },
    },
  );
  const manager = {
    start: vi.fn(async () =>
      ok({
        session_id: sessionId,
        state: "ready" as const,
        pid: 1234,
        target: "/bin/ls",
      }),
    ),
    execute: vi.fn(async () =>
      ok({
        result: {
          command: "register read",
          output: "x0 = 0x0",
          completion_status: "complete" as const,
          output_truncated: false,
        },
        evidence,
      }),
    ),
    close: vi.fn(async () =>
      err(
        new AnalysisCapabilityUnavailableError(
          "lldb",
          "close_lldb_session",
          "Target cleanup unconfirmed",
        ),
      ),
    ),
    closeAll: vi.fn(async () => {
      throw new Error("retained session target cleanup incomplete");
    }),
  } as unknown as LldbSessionManager;

  const originalExitCode = process.exitCode;
  const command = registerLldbCommand(() => manager);
  try {
    const result = await command.run({
      args: { command: "register read" },
      options: { path: "/bin/ls" },
    });
    expect(result).toMatchObject({
      code: "cleanup_incomplete",
    });
    expect(manager.close).toHaveBeenCalledWith(sessionId);
    expect(manager.closeAll).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = originalExitCode;
  }
});

class FakeLldbBridge extends EventEmitter {
  pid = process.pid + 2;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(
    private readonly closeResult: {
      status: string;
      target_state: string;
    } = { status: "closed", target_state: "terminated" },
    private readonly options: {
      readonly initializeError?: string;
      readonly commandDelayMs?: number;
    } = {},
  ) {
    super();
    this.stdin.on("data", (chunk) => {
      const text = String(chunk);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const req = JSON.parse(trimmed);
          if (req.method === "initialize") {
            if (this.options.initializeError) {
              this.stdout.write(
                JSON.stringify({
                  id: req.id,
                  error: this.options.initializeError,
                }) + "\n",
              );
            } else {
              this.stdout.write(
                JSON.stringify({
                  id: req.id,
                  result: { status: "ok", version: "lldb-1700" },
                }) + "\n",
              );
            }
          } else if (req.method === "launch") {
            this.stdout.write(
              JSON.stringify({
                id: req.id,
                result: { status: "ok", state: "launched", pid: 9999 },
              }) + "\n",
            );
          } else if (req.method === "status") {
            this.stdout.write(
              JSON.stringify({
                id: req.id,
                result: { state: "ready", process_state: "stopped", pid: 9999 },
              }) + "\n",
            );
          } else if (req.method === "close") {
            this.stdout.write(
              JSON.stringify({ id: req.id, result: this.closeResult }) + "\n",
            );
          } else if (req.method === "command") {
            const sendReply = () => {
              this.stdout.write(
                JSON.stringify({
                  id: req.id,
                  result: {
                    command: req.params.command,
                    output: "mock command output",
                    process_state: "stopped",
                    output_truncated: false,
                    completion_status: "complete",
                  },
                }) + "\n",
              );
            };
            if (this.options.commandDelayMs) {
              setTimeout(sendReply, this.options.commandDelayMs);
            } else {
              sendReply();
            }
          } else if (req.method === "attach") {
            this.stdout.write(
              JSON.stringify({
                id: req.id,
                result: {
                  status: "ok",
                  state: "attached",
                  pid: req.params.pid,
                },
              }) + "\n",
            );
          }
        } catch {}
      }
    });
  }

  kill(signal: NodeJS.Signals) {
    this.exitCode = 0;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.stdin.destroy();
    this.emit("exit", 0, signal);
    this.emit("close", 0, signal);
    return true;
  }
}

it("retains session ownership in LldbSessionManager when target cleanup cannot be confirmed", async () => {
  const fakeBridge = new FakeLldbBridge({
    status: "failed",
    target_state: "unknown",
  });
  const spawnProcess = vi.fn(async () => ({
    process: fakeBridge as unknown as import("node:child_process").ChildProcess,
    ownsProcessLifetime: true,
  }));
  const manager = new LldbSessionManager({
    platform: "darwin",
    spawnProcess: spawnProcess as unknown as typeof spawnOwnedProviderProcess,
  });

  const started = await manager.start(undefined, { path: "/bin/echo" });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const sessionId = started.value.session_id;

  const initialStatus = await manager.status(sessionId);
  expect(initialStatus).toBeDefined();
  expect(initialStatus?.state).toBe("ready");

  // Close receives target_state: "unknown" from the bridge
  const closed = await manager.close(sessionId);
  expect(closed.ok).toBe(false);

  // Repository requirement: ownership must be retained when cleanup fails
  const retainedStatus = await manager.status(sessionId);
  expect(retainedStatus).toBeDefined();
  expect(retainedStatus?.state).toBe("ready");

  // The cleanup failure is retained in the registry
  const retried = await manager.retryCleanupFailures();
  expect(retried.ok).toBe(false);

  // Still retained until confirmed cleanup
  const afterRetryStatus = await manager.status(sessionId);
  expect(afterRetryStatus).toBeDefined();
  expect(afterRetryStatus?.state).toBe("ready");
});

it("releases session ownership in LldbSessionManager when target cleanup is confirmed", async () => {
  const fakeBridge = new FakeLldbBridge({
    status: "closed",
    target_state: "terminated",
  });
  const spawnProcess = vi.fn(async () => ({
    process: fakeBridge as unknown as import("node:child_process").ChildProcess,
    ownsProcessLifetime: true,
  }));
  const manager = new LldbSessionManager({
    platform: "darwin",
    spawnProcess: spawnProcess as unknown as typeof spawnOwnedProviderProcess,
  });

  const started = await manager.start(undefined, { path: "/bin/echo" });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const sessionId = started.value.session_id;

  const initialStatus = await manager.status(sessionId);
  expect(initialStatus).toBeDefined();
  expect(initialStatus?.state).toBe("ready");

  const closed = await manager.close(sessionId);
  expect(closed.ok).toBe(true);
  if (closed.ok) {
    expect(closed.value.target_state).toBe("terminated");
  }

  // Released upon confirmed cleanup
  const finalStatus = await manager.status(sessionId);
  expect(finalStatus).toBeUndefined();
});

it("retains caller-selected launch facts, provenance, and hashes target file in command evidence", async () => {
  const fakeBridge = new FakeLldbBridge();
  const spawnProcess = vi.fn(async () => ({
    process: fakeBridge as unknown as import("node:child_process").ChildProcess,
    ownsProcessLifetime: true,
  }));
  const manager = new LldbSessionManager({
    platform: "darwin",
    spawnProcess: spawnProcess as unknown as typeof spawnOwnedProviderProcess,
  });

  const started = await manager.start(undefined, {
    path: "/bin/echo",
    args: ["test-arg"],
    env: { TEST_ENV: "val" },
  });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const sessionId = started.value.session_id;

  const executed = await manager.execute(sessionId, "register read");
  expect(executed.ok).toBe(true);
  if (!executed.ok) return;

  const { evidence } = executed.value;
  expect(evidence.subject.identity).toMatchObject({
    kind: "session",
    session_kind: "lldb",
    id: sessionId,
    target: {
      kind: "file",
      sha256: expect.any(String),
      format: "file",
      architecture: null,
      selection: null,
    },
  });

  expect(evidence.parameters).toMatchObject({
    session_id: sessionId,
    command: "register read",
    path: "/bin/echo",
    args: ["test-arg"],
    env: { TEST_ENV: "val" },
    launch_provenance: {
      caller_selected_path: "/bin/echo",
      resolved_path: await realpath("/bin/echo"),
      args: ["test-arg"],
      env: { TEST_ENV: "val" },
    },
  });

  expect(evidence.limitations).toContainEqual(
    expect.stringContaining(
      "The session target is the initial file selected and hashed",
    ),
  );

  await manager.close(sessionId);
});

it("preserves unknown target identity and omits launch provenance when started without path", async () => {
  const fakeBridge = new FakeLldbBridge();
  const spawnProcess = vi.fn(async () => ({
    process: fakeBridge as unknown as import("node:child_process").ChildProcess,
    ownsProcessLifetime: true,
  }));
  const manager = new LldbSessionManager({
    platform: "darwin",
    spawnProcess: spawnProcess as unknown as typeof spawnOwnedProviderProcess,
  });

  const started = await manager.start(undefined, { pid: 1234 });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const sessionId = started.value.session_id;

  const executed = await manager.execute(sessionId, "process status");
  expect(executed.ok).toBe(true);
  if (!executed.ok) return;

  const { evidence } = executed.value;
  expect(evidence.subject.identity).toMatchObject({
    kind: "session",
    session_kind: "lldb",
    id: sessionId,
    target: {
      kind: "unknown",
      reason: "not-observed",
    },
  });

  expect(evidence.parameters).not.toHaveProperty("launch_provenance");
  expect(evidence.parameters).not.toHaveProperty("path");

  await manager.close(sessionId);
});

it("resolves symlinked traversal paths so evidence hash and launch binary match the true target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rea-lldb-symlink-"));
  try {
    const workDir = join(dir, "work");
    const otherInnerDir = join(dir, "other", "inner");
    const otherDir = join(dir, "other");
    await mkdir(workDir, { recursive: true });
    await mkdir(otherInnerDir, { recursive: true });

    const otherTarget = join(otherDir, "target");
    const workTarget = join(workDir, "target");
    await writeFile(otherTarget, "#!/bin/sh\necho other\n", { mode: 0o755 });
    await writeFile(workTarget, "#!/bin/sh\necho work\n", { mode: 0o755 });

    const linkPath = join(workDir, "link");
    await symlink(otherInnerDir, linkPath);

    const callerSelected = `${workDir}/link/../target`;
    const expectedResolved = await realpath(otherTarget);
    const expectedSha256 = createHash("sha256")
      .update(await readFile(otherTarget))
      .digest("hex");

    let launchedPath: string | undefined;
    const fakeBridge = new FakeLldbBridge();
    fakeBridge.stdin.on("data", (chunk) => {
      const text = String(chunk);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const req = JSON.parse(trimmed);
          if (req.method === "launch") {
            launchedPath = req.params.path;
          }
        } catch {}
      }
    });

    const spawnProcess = vi.fn(async () => ({
      process:
        fakeBridge as unknown as import("node:child_process").ChildProcess,
      ownsProcessLifetime: true,
    }));
    const manager = new LldbSessionManager({
      platform: "darwin",
      spawnProcess: spawnProcess as unknown as typeof spawnOwnedProviderProcess,
    });

    const started = await manager.start(undefined, { path: callerSelected });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const sessionId = started.value.session_id;

    // Verify LLDB launch received the true resolved target, not the lexical work/target
    expect(launchedPath).toBe(expectedResolved);

    const executed = await manager.execute(sessionId, "target info");
    expect(executed.ok).toBe(true);
    if (!executed.ok) return;

    const { evidence } = executed.value;
    expect(evidence.parameters.launch_provenance).toEqual({
      caller_selected_path: callerSelected,
      resolved_path: expectedResolved,
    });
    expect(evidence.subject.identity).toMatchObject({
      kind: "session",
      session_kind: "lldb",
      id: sessionId,
      target: {
        kind: "file",
        sha256: expectedSha256,
      },
    });

    await manager.close(sessionId);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

it("rejects session startup when LLDB bridge initialize handshake fails", async () => {
  const fakeBridge = new FakeLldbBridge(undefined, {
    initializeError: "debugger initialization handshake rejected",
  });
  const spawnProcess = vi.fn(async () => ({
    process: fakeBridge as unknown as import("node:child_process").ChildProcess,
    ownsProcessLifetime: true,
  }));
  const manager = new LldbSessionManager({
    platform: "darwin",
    spawnProcess: spawnProcess as unknown as typeof spawnOwnedProviderProcess,
  });

  const started = await manager.start();
  expect(started.ok).toBe(false);
  if (started.ok) return;
  expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
  expect(started.error.message).toContain(
    "debugger initialization handshake rejected",
  );
});

it("propagates cancellation and aborts an in-flight LLDB command", async () => {
  const fakeBridge = new FakeLldbBridge(undefined, {
    commandDelayMs: 200,
  });
  const spawnProcess = vi.fn(async () => ({
    process: fakeBridge as unknown as import("node:child_process").ChildProcess,
    ownsProcessLifetime: true,
  }));
  const manager = new LldbSessionManager({
    platform: "darwin",
    spawnProcess: spawnProcess as unknown as typeof spawnOwnedProviderProcess,
  });

  const started = await manager.start();
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const sessionId = started.value.session_id;

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);

  const executed = await manager.execute(
    sessionId,
    "process status",
    controller.signal,
  );
  expect(executed.ok).toBe(false);
  if (executed.ok) return;
  expect(executed.error._tag).toBe("AnalysisCancelledError");

  await manager.close(sessionId);
});
