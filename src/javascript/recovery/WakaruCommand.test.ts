import { createTestArtifactResourceScope } from "../../../tests/fixtures/artifactResourceScope.js";
import {
  ProcessOwnershipInspectionCancelled,
  ProcessOwnershipIdentityBatchFailure,
} from "../../process/ProcessInspectionCancellation.js";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnOwnedProviderProcess } from "../../process/ProviderProcess.js";
import {
  execFileOutput,
  ExecFileOutputCancelledError,
} from "../../process/ExecFileOutput.js";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  AnalysisError,
  primaryAnalysisError,
} from "../../domain/analysisErrorBase.js";
import {
  resolveWakaruCommand,
  runWakaruCommand,
  type WakaruLauncher,
} from "./WakaruCommand.js";
import { prlimitArgumentVector } from "../../process/LinuxResourceLimits.js";
import { RECOVERY_LIMITS } from "./WakaruRelease.js";

it("names the Wakaru configuration requirement when it is not configured", async () => {
  const refusal: unknown = await resolveWakaruCommand({}).catch(
    (cause: unknown) => cause,
  );

  if (!(refusal instanceof AnalysisCapabilityUnavailableError))
    throw new Error("Expected a capability refusal");
  expect(refusal.reason).toContain("REA_WAKARU_COMMAND");
  expect(projectAnalysisError(refusal)).toMatchObject({
    code: "capability_unavailable",
    message: refusal.reason,
    remediation: { action: refusal.reason },
  });
});

it("projects the fixed Wakaru deadline without an editable setting", async () => {
  const refusal: unknown = await runWakaruCommand({
    resources: createTestArtifactResourceScope(),
    command: "/selected/wakaru",
    limiter: "/usr/bin/prlimit",
    arguments: ["--version"],
    cwd: "/tmp/unused",
    environment: {},
    deadline: performance.now() - 1,
    launcher: async () => {
      throw new Error("An expired budget must not launch");
    },
  }).catch((cause: unknown) => cause);
  if (!(refusal instanceof AnalysisTimeoutError))
    throw new Error("Expected the Wakaru deadline");
  expect(refusal).toMatchObject({
    operation: "recover_javascript_sources",
    timeoutMs: RECOVERY_LIMITS.timeoutMs,
  });
  const projected = projectAnalysisError(refusal);
  expect(projected).toMatchObject({
    code: "provider_timeout",
    details: { timeout_ms: RECOVERY_LIMITS.timeoutMs },
    recovery: {
      kind: "inspect_timeout_state",
      operation: "recover_javascript_sources",
      timeout_ms: RECOVERY_LIMITS.timeoutMs,
    },
  });
  expect(projected.details?.limit).toBeUndefined();
});

it("preserves caller cancellation before acquiring an expired execution budget", async () => {
  await expect(
    runWakaruCommand({
      resources: createTestArtifactResourceScope(),
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: performance.now() - 1,
      signal: AbortSignal.abort(),
      launcher: async () => {
        throw new Error("A cancelled request must not launch");
      },
    }),
  ).rejects.toMatchObject({ _tag: "AnalysisCancelledError" });
});

it.each([null, false, { request: "cancel launch" }])(
  "preserves the opaque reason when cancellation interrupts launcher acquisition (%j)",
  async (reason) => {
    const controller = new AbortController();
    await expect(
      runWakaruCommand({
        resources: createTestArtifactResourceScope(),
        command: "/selected/wakaru",
        limiter: "/usr/bin/prlimit",
        arguments: ["--version"],
        cwd: "/tmp/unused",
        environment: {},
        deadline: performance.now() + 5_000,
        signal: controller.signal,
        launcher: async (options) => {
          controller.abort(reason);
          throw new ProcessOwnershipInspectionCancelled(options.signal?.reason);
        },
      }),
    ).rejects.toMatchObject({
      _tag: "AnalysisCancelledError",
      cause: reason,
    });
  },
);

it.each(["direct", "batch"] as const)(
  "preserves %s ownership cancellation without requiring signal state",
  async (kind) => {
    const reason = { caller: "ownership cancellation" };
    const cancelled = new ProcessOwnershipInspectionCancelled(reason);
    const failure =
      kind === "direct"
        ? cancelled
        : new ProcessOwnershipIdentityBatchFailure(
            [{ pid: 42, requestIndex: 0, cause: cancelled }],
            new Map([
              [
                44,
                {
                  state: "unavailable" as const,
                  reason: "completed sibling observation",
                },
              ],
            ]),
          );
    const projected = await runWakaruCommand({
      resources: createTestArtifactResourceScope(),
      command: "/selected/wakaru",
      limiter: "/unused/prlimit",
      arguments: [],
      cwd: "/unused",
      environment: {},
      deadline: performance.now() + 30_000,
      launcher: async () => {
        throw failure;
      },
    }).catch((cause: unknown) => cause);
    expect(projected).toMatchObject({
      _tag: "AnalysisCancelledError",
      cause: reason,
    });
    if (
      !(projected instanceof AnalysisError) ||
      !("inspectionFailure" in projected)
    )
      throw new Error("Missing ownership inspection origin");
    expect(projected.inspectionFailure).toBe(failure);
  },
);

it.each(["identity", "name"] as const)(
  "keeps a physical launch failure despite %s cancellation resemblance",
  async (kind) => {
    const controller = new AbortController();
    const physical = new Error("physical launch refusal", { cause: null });
    physical.name = "AbortError";
    const failure = await runWakaruCommand({
      resources: createTestArtifactResourceScope(),
      command: "/selected/wakaru",
      limiter: "/unused/prlimit",
      arguments: [],
      cwd: "/unused",
      environment: {},
      deadline: performance.now() + 30_000,
      signal: controller.signal,
      launcher: async () => {
        controller.abort(kind === "identity" ? physical : null);
        throw physical;
      },
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      _tag: "ProviderAdapterError",
      cause: physical,
    });
    if (!(failure instanceof AnalysisError)) throw failure;
    expect(failure.cause).toBe(physical);
  },
);

it.each(["recorded", "live"] as const)(
  "preserves cancellation reported by the %s ownership preparation command",
  async (mode) => {
    const controller = new AbortController();
    const reason = { caller: "cancel ownership preparation" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        runWakaruCommand({
          resources: createTestArtifactResourceScope(),
          command: "/selected/wakaru",
          limiter: "/unused/prlimit",
          arguments: ["--version"],
          cwd: tmpdir(),
          environment: {},
          deadline: performance.now() + 10_000,
          signal: controller.signal,
          launcher: async () => {
            try {
              if (mode === "recorded") {
                controller.abort(reason);
                throw new ExecFileOutputCancelledError(reason);
              }
              timer = setTimeout(() => controller.abort(reason), 100);
              await execFileOutput(
                process.execPath,
                ["-e", "setInterval(() => {}, 1000)"],
                {
                  signal: controller.signal,
                  stopSignal: "SIGTERM",
                },
              );
              throw new Error("Expected preparation cancellation");
            } catch (cause) {
              // A launcher reports its owner's typed inspection cancellation;
              // the lower command's caller reason remains opaque.
              throw ProcessOwnershipInspectionCancelled.from(cause) ?? cause;
            }
          },
        }),
      ).rejects.toMatchObject({
        _tag: "AnalysisCancelledError",
        cause: reason,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  },
);

it("preserves a real launch failure when the caller cancels after it", async () => {
  const controller = new AbortController();
  const reason = { caller: "cancel after launch failure" };
  const missing = join(tmpdir(), `rea-missing-wakaru-${randomUUID()}`);
  const failure: unknown = await runWakaruCommand({
    resources: createTestArtifactResourceScope(),
    command: "/selected/wakaru",
    limiter: missing,
    arguments: ["--version"],
    cwd: tmpdir(),
    environment: {},
    deadline: performance.now() + 30_000,
    signal: controller.signal,
    launcher: async (options) => {
      try {
        return await spawnOwnedProviderProcess(options);
      } catch (cause) {
        controller.abort(reason);
        throw cause;
      }
    },
  }).catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    _tag: "ProviderAdapterError",
    cause: { code: "ENOENT" },
    secondaryFailures: [{ _tag: "AnalysisCancelledError", cause: reason }],
  });
});

const commandFixture = (
  emit: (producer: ReturnType<typeof createProducer>) => void,
) => {
  const producer = createProducer();
  const launcher: WakaruLauncher = async (options) => {
    setImmediate(() => emit(producer));
    return {
      process: producer,
      ownership: {
        runId: options.runId,
        leaderPid: 12345,
        processGroupId: 12345,
        expectedParentPid: process.pid,
      },
      cleanup: async () => ({ cleaned: true, signaled: false }),
    };
  };
  return {
    producer,
    context: {
      resources: createTestArtifactResourceScope(),
      command: "/selected/wakaru",
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: performance.now() + 5_000,
      launcher,
    },
  };
};

const createProducer = () =>
  Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => false,
  });

it("retains stdout and stderr delivered after launcher exit", async () => {
  const { context } = commandFixture((producer) => {
    producer.stdout.write("first");
    producer.emit("exit", 0, null);
    setImmediate(() => {
      producer.stdout.end("last");
      producer.stderr.end("diagnostic");
      producer.emit("close", 0, null);
    });
  });
  await expect(runWakaruCommand(context)).resolves.toMatchObject({
    exit_code: 0,
    signal: null,
    stdout: "firstlast",
    stderr: "diagnostic",
  });
});

it("checks the diagnostic byte limit against output delivered after exit", async () => {
  const { context } = commandFixture((producer) => {
    producer.emit("exit", 0, null);
    setImmediate(() => {
      producer.stderr.end(Buffer.alloc(RECOVERY_LIMITS.reportBytes + 1, 97));
      producer.stdout.end();
      producer.emit("close", 0, null);
    });
  });
  const failure = await runWakaruCommand(context).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toMatchObject({
    _tag: "AnalysisOutputError",
    operation: "recover_javascript_sources",
    capturedOutput: {
      truncated: true,
      exit_code: 0,
    },
  });
  expect(
    (failure as { capturedOutput: { stderr: string } }).capturedOutput.stderr
      .length,
  ).toBe(RECOVERY_LIMITS.reportBytes);
});

it.each([false, true])(
  "retains output and exact cancellation during final cleanup (cleanup fails: %s)",
  async (cleanupFails) => {
    const reason = { caller: "cancel during final cleanup" };
    const controller = new AbortController();
    const { context } = commandFixture((producer) => {
      producer.stdout.end("finished output");
      producer.stderr.end("finished diagnostic");
      producer.emit("exit", 0, null);
      producer.emit("close", 0, null);
    });
    const launcher = context.launcher;
    const failure = await runWakaruCommand({
      ...context,
      signal: controller.signal,
      launcher: async (options) => ({
        ...(await launcher(options)),
        cleanup: async () => {
          controller.abort(reason);
          return cleanupFails
            ? { cleaned: false as const, reason: "owned cleanup refused" }
            : { cleaned: true as const, signaled: false };
        },
      }),
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      cleanupIncomplete: cleanupFails,
      capturedOutput: {
        stdout: "finished output",
        stderr: "finished diagnostic",
        exit_code: 0,
      },
    });
    const primary = primaryAnalysisError(
      failure as Parameters<typeof primaryAnalysisError>[0],
    );
    expect(primary).toMatchObject({
      _tag: "AnalysisCancelledError",
      cause: reason,
    });
    expect(primary.cause).toBe(reason);
  },
);

it("enforces the shared deadline while exited output streams remain open", async () => {
  const { context, producer } = commandFixture((process) => {
    process.emit("exit", 0, null);
  });
  try {
    await expect(
      runWakaruCommand({ ...context, deadline: performance.now() + 50 }),
    ).rejects.toMatchObject({
      _tag: "AnalysisTimeoutError",
      operation: "recover_javascript_sources",
    });
    expect(producer.stderr.listenerCount("data")).toBe(0);
  } finally {
    producer.stdout.destroy();
    producer.stderr.destroy();
  }
});

it("pins both Wakaru ceilings through the shared prlimit vector", async () => {
  let observed: readonly string[] | undefined;
  const producer = createProducer();
  const command = "/selected/wakaru";
  await expect(
    runWakaruCommand({
      resources: createTestArtifactResourceScope(),
      command,
      limiter: "/usr/bin/prlimit",
      arguments: ["--version"],
      cwd: "/tmp/unused",
      environment: {},
      deadline: performance.now() + 5_000,
      launcher: async (options) => {
        observed = options.arguments;
        setImmediate(() => {
          producer.stdout.end();
          producer.stderr.end();
          producer.emit("exit", 0, null);
          producer.emit("close", 0, null);
        });
        return {
          process: producer,
          ownership: {
            runId: options.runId,
            leaderPid: 12345,
            processGroupId: 12345,
            expectedParentPid: process.pid,
          },
          cleanup: async () => ({ cleaned: true, signaled: false }),
        };
      },
    }),
  ).resolves.toMatchObject({ exit_code: 0 });
  expect(observed).toEqual([
    ...prlimitArgumentVector(
      {
        address_space_bytes: RECOVERY_LIMITS.addressSpaceBytes,
        file_bytes: RECOVERY_LIMITS.outputBytes,
        cpu_seconds: RECOVERY_LIMITS.cpuSeconds,
      },
      command,
    ),
    "--version",
  ]);
});

it("honors cancellation while waiting for output after exit", async () => {
  const controller = new AbortController();
  const { context, producer } = commandFixture((process) => {
    process.emit("exit", 0, null);
    setImmediate(() => controller.abort());
  });
  try {
    await expect(
      runWakaruCommand({ ...context, signal: controller.signal }),
    ).rejects.toMatchObject({
      _tag: "AnalysisCancelledError",
    });
    expect(producer.stderr.listenerCount("data")).toBe(0);
  } finally {
    producer.stdout.destroy();
    producer.stderr.destroy();
  }
});
