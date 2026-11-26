import { createTestArtifactResourceScope } from "../fixtures/artifactResourceScope.js";
import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  failure: new Error("controlled manifest failure"),
  failManifest: true,
}));
vi.mock("write-file-atomic", async (importOriginal) => {
  const actual = await importOriginal<{
    default: typeof import("write-file-atomic");
  }>();
  return {
    default: async (...args: Parameters<typeof actual.default>) => {
      if (
        fault.failManifest &&
        typeof args[0] === "string" &&
        args[0].endsWith("/ownership.json")
      )
        throw fault.failure;
      return actual.default(...args);
    },
  };
});

import {
  GhidraHeadlessLauncher,
  GhidraLaunchError,
  type GhidraLaunchSession,
} from "../../src/ghidra/GhidraLauncher.js";
import { bindGhidraSessionFailure } from "../../src/ghidra/GhidraSessionError.js";
import { AnalysisCancelledError } from "../../src/domain/analysisErrorCore.js";
import { GhidraClient } from "../../src/ghidra/GhidraClient.js";
import {
  spawnOwnedProviderProcess,
  type SpawnedOwnedProviderProcess,
} from "../../src/process/ProviderProcess.js";
import {
  cleanupOwnedProcessGroup,
  type ProcessCleanupFailure,
} from "../../src/process/ProcessOwnership.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { ghidraFixturePath } from "../boundary/providers/ghidra/ghidraClient.fixture.js";

const owners: SpawnedOwnedProviderProcess[] = [];
const clients: GhidraClient[] = [];
let denyCleanup = true;
beforeEach(() => {
  denyCleanup = true;
  fault.failManifest = true;
});
afterEach(async () => {
  denyCleanup = false;
  for (const client of clients.splice(0)) await client.close();
  for (const owner of owners.splice(0))
    expect(await cleanupOwnedProcessGroup(owner.ownership)).toMatchObject({
      cleaned: true,
    });
});

const incomplete: ProcessCleanupFailure = {
  cleaned: false,
  reason: "mixed fixture outcomes",
  failures: [
    {
      pid: 123,
      reason: "process-identity-unavailable",
      diagnostic: "controlled identity uncertainty",
    },
  ],
  unverified: [{ pid: 456, diagnostic: "controlled observation unavailable" }],
};
const fixture = async (
  rollback: () => Promise<ProcessCleanupFailure>,
  afterSpawn?: () => void,
) => {
  const root = await createTestTempDirectory("rea-launch-rollback-");
  const launcher = new GhidraHeadlessLauncher({
    configurationDirectoryName: "ghidra_12.1.4_PUBLIC",
    environment: {},
    platform: process.platform,
    analyzeHeadlessPath: join(root, "support", "analyzeHeadless"),
    javaHome: join(root, "jdk"),
    bridgeScriptPath: join(root, "ReaGhidraBridge.java"),
    javaLaunch: async () => ({
      command: process.execPath,
      arguments: ["-e", "setInterval(()=>{},1000)"],
      environment: {},
    }),
    spawnProcess: async (options) => {
      const spawned = await spawnOwnedProviderProcess(options);
      owners.push(spawned);
      afterSpawn?.();
      return {
        ...spawned,
        cleanup: () =>
          denyCleanup
            ? rollback()
            : cleanupOwnedProcessGroup(spawned.ownership),
      };
    },
  });
  const session: GhidraLaunchSession = {
    runtimeRoot: root,
    transport: "unix-socket",
    endpointPath: join(root, "bridge.sock"),
    token: "fixture-token",
    runId: randomUUID(),
    targetPath: join(root, "unused-target"),
    targetSha256: "a".repeat(64),
    providerVersion: "test",
    profileDigest: "b".repeat(64),
  };
  return { launcher, session };
};

it.skipIf(process.platform === "win32").each([
  { completion: "undefined rejection", rejection: undefined, cancel: false },
  {
    completion: "error rejection",
    rejection: new Error("rollback rejected"),
    cancel: false,
  },
  {
    completion: "synchronous throw during cancellation",
    rejection: undefined,
    cancel: true,
  },
])(
  "retains the process and primary failure after $completion",
  async ({ rejection, cancel }) => {
    const controller = new AbortController();
    const { launcher, session } = await fixture(() => {
      if (cancel) {
        controller.abort(null);
        throw rejection;
      }
      return Promise.reject(rejection);
    });
    const result = await launcher.launch(session, {
      resourceScope: createTestArtifactResourceScope(),
      signal: controller.signal,
    });
    if (result.ok || !(result.error instanceof GhidraLaunchError))
      throw new Error("Expected launch failure");
    expect(controller.signal.aborted).toBe(cancel);
    expect(result.error.rollbackFailure).toEqual({
      kind: "rejected",
      cause: rejection,
    });
    const aggregate = result.error.cause;
    if (
      !(aggregate instanceof AggregateError) ||
      !(aggregate.cause instanceof GhidraLaunchError)
    )
      throw new Error("Expected launch and rollback failures");
    expect(aggregate.errors).toEqual([aggregate.cause, rejection]);
    expect(aggregate.cause.cause).toBe(fault.failure);
    expect(owners[0]?.process.exitCode).toBeNull();
    denyCleanup = false;
    expect(await result.error.partialLaunch?.cleanup?.()).toMatchObject({
      cleaned: true,
    });
  },
);

it.skipIf(process.platform === "win32")(
  "retains structured mixed-member rollback evidence through session projection",
  async () => {
    const { launcher, session } = await fixture(async () => incomplete);
    const result = await launcher.launch(session, {
      resourceScope: createTestArtifactResourceScope(),
    });
    if (result.ok || !(result.error instanceof GhidraLaunchError))
      throw new Error("Expected launch failure");
    expect(result.error.partialLaunch).toBeDefined();
    expect(result.error).toMatchObject({
      rollbackFailure: { kind: "incomplete", result: incomplete },
    });
    const projected = bindGhidraSessionFailure(() => ({}))(
      "start",
      result.error.message,
      result.error,
    );
    expect(projected.diagnostics).toMatchObject({
      failure_cause: {
        rollback_failure: { kind: "incomplete", result: incomplete },
      },
    });
    denyCleanup = false;
    expect(await result.error.partialLaunch?.cleanup?.()).toMatchObject({
      cleaned: true,
    });
  },
);

it
  .skipIf(process.platform === "win32")
  .each(["rejection", "late cancellation"] as const)(
  "client retains the failed runtime until retry after rollback %s",
  async (scenario) => {
    const controller = new AbortController();
    const { launcher } = await fixture(async () => {
      if (scenario === "rejection") throw undefined;
      controller.abort(null);
      return incomplete;
    });
    const target = await readFile(ghidraFixturePath);
    let runtimeRoot: string | undefined;
    const client = new GhidraClient({
      launcher: {
        launch: (session, options) => {
          runtimeRoot = session.runtimeRoot;
          return launcher.launch(session, options);
        },
      },
      targetPath: ghidraFixturePath,
      targetSha256: createHash("sha256").update(target).digest("hex"),
      providerVersion: "test",
      profileDigest: "b".repeat(64),
      startupTimeoutMs: 5000,
    });
    clients.push(client);
    const result = await client.start(controller.signal);
    if (result.ok) throw new Error("Expected failed startup");
    expect(controller.signal.aborted).toBe(scenario === "late cancellation");
    expect(result.error).toMatchObject({
      kind: "start",
      cleanupFailure: { cleanupIncomplete: true },
    });
    const failure = result.error.cause;
    const aggregate =
      failure instanceof GhidraLaunchError ? failure.cause : undefined;
    if (
      !(aggregate instanceof AggregateError) ||
      !(aggregate.cause instanceof GhidraLaunchError)
    )
      throw new Error("Expected the original launch failure");
    expect(aggregate.cause.cause).toBe(fault.failure);
    expect(result.error.diagnostics).toMatchObject({
      failure_cause: {
        cause: { cause: { cause: { message: fault.failure.message } } },
      },
    });
    const owned = owners[0]?.process;
    if (owned === undefined || runtimeRoot === undefined)
      throw new Error("Expected an admitted process and runtime root");
    expect(owned.exitCode).toBeNull();
    expect(owned.signalCode).toBeNull();
    await expect(access(runtimeRoot)).resolves.toBeUndefined();
    denyCleanup = false;
    expect(await client.close()).toMatchObject({ ok: true });
    expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
    expect(result.error.cleanupFailure?.cleanupIncomplete).toBe(false);
    await expect(access(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("bounds and redacts rollback evidence with explicit truncation", () => {
  const value = "sensitive-transport-token";
  const result: ProcessCleanupFailure = {
    cleaned: false,
    reason: value + "x".repeat(4096),
    failures: [
      {
        pid: 1,
        reason: "run-token-mismatch",
        diagnostic: value + "y".repeat(4096),
      },
    ],
    unverified: [{ pid: 2, diagnostic: value + "z".repeat(4096) }],
  };
  const launch = new GhidraLaunchError("primary", {
    rollbackFailure: { kind: "incomplete", result },
  });
  const projected = bindGhidraSessionFailure(
    () => ({}),
    (text) => text.replaceAll(value, "[REDACTED]"),
  )("start", "primary", launch);
  expect(JSON.stringify(projected.diagnostics)).not.toContain(value);
  expect(projected.diagnostics).toMatchObject({
    failure_cause: {
      rollback_failure: {
        result: {
          reason_truncated: true,
          failures: [{ diagnostic_truncated: true }],
          unverified: [{ diagnostic_truncated: true }],
        },
      },
    },
  });
});

it("bounds aggregate member evidence and retains complete producer facts", () => {
  const rows = Array.from({ length: 500 }, (_, pid) => ({
    pid,
    diagnostic: "\u0001".repeat(2000),
  }));
  const result: ProcessCleanupFailure = {
    cleaned: false,
    reason: "many controlled members",
    failures: rows.map((row) => ({
      ...row,
      reason: "process-identity-unavailable" as const,
    })),
    unverified: rows,
  };
  const launch = new GhidraLaunchError("primary", {
    rollbackFailure: { kind: "incomplete", result },
  });
  const projected = bindGhidraSessionFailure(() => ({}))(
    "start",
    "primary",
    launch,
  );
  const cause = projected.diagnostics["failure_cause"] as {
    rollback_failure: {
      result: {
        failures: unknown[];
        unverified: unknown[];
        failures_omitted?: number;
        unverified_omitted?: number;
      };
    };
  };
  const output = cause.rollback_failure.result;
  expect(output.failures.length + (output.failures_omitted ?? 0)).toBe(500);
  expect(output.unverified.length + (output.unverified_omitted ?? 0)).toBe(500);
  expect(Buffer.byteLength(JSON.stringify(projected.diagnostics))).toBeLessThan(
    10 * 1024,
  );
  expect(launch.rollbackFailure).toEqual({ kind: "incomplete", result });
});

it.skipIf(process.platform === "win32").each([null, "stop after spawn"])(
  "retains producer cancellation and exact process cleanup through failed rollback %j",
  async (reason) => {
    fault.failManifest = false;
    const controller = new AbortController();
    const { launcher, session } = await fixture(
      async () => incomplete,
      () => controller.abort(reason),
    );
    const result = await launcher.launch(session, {
      resourceScope: createTestArtifactResourceScope(),
      signal: controller.signal,
    });
    if (result.ok || !(result.error instanceof GhidraLaunchError))
      throw new Error("Expected incomplete rollback");
    expect(result.error.primaryFailure).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.primaryFailure?.cause).toBe(reason);
    expect(result.error.rollbackFailure).toEqual({
      kind: "incomplete",
      result: incomplete,
    });
    expect(result.error.partialLaunch).toBeDefined();
    denyCleanup = false;
    expect(await result.error.partialLaunch?.cleanup?.()).toMatchObject({
      cleaned: true,
    });
  },
);

it.skipIf(process.platform === "win32")(
  "client preserves an earlier manifest failure when the final caller cancels during rollback",
  async () => {
    const controller = new AbortController();
    const { launcher } = await fixture(async () => {
      controller.abort(null);
      return incomplete;
    });
    const target = await readFile(ghidraFixturePath);
    const client = new GhidraClient({
      launcher,
      targetPath: ghidraFixturePath,
      targetSha256: createHash("sha256").update(target).digest("hex"),
      providerVersion: "test",
      profileDigest: "b".repeat(64),
      startupTimeoutMs: 5000,
    });
    clients.push(client);
    const result = await client.start(controller.signal);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "start", cleanupFailure: { cleanupIncomplete: true } },
    });
    if (result.ok) throw new Error("Expected original startup failure");
    expect(JSON.stringify(result.error.diagnostics)).toContain(
      fault.failure.message,
    );
    denyCleanup = false;
    expect(await client.close()).toMatchObject({ ok: true });
    expect(result.error.cleanupFailure?.cleanupIncomplete).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "keeps the log coordinates of a started launch whose rollback succeeded",
  async () => {
    denyCleanup = false;
    const { launcher, session } = await fixture(async () => incomplete);
    const result = await launcher.launch(session, {
      resourceScope: createTestArtifactResourceScope(),
    });
    if (result.ok || !(result.error instanceof GhidraLaunchError))
      throw new Error("Expected launch failure");
    expect(result.error.partialLaunch).toBeUndefined();
    expect(result.error.logPaths).toEqual({
      ghidraLogPath: join(session.runtimeRoot, "ghidra.log"),
      scriptLogPath: join(session.runtimeRoot, "script.log"),
    });
  },
);
