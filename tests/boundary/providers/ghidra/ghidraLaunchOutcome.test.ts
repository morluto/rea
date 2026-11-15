import { createTestArtifactResourceScope } from "../../../fixtures/artifactResourceScope.js";
import { DarwinProcessOwnershipInspectionError } from "../../../../src/process/DarwinProcessRunTokenReader.js";
import { primaryAnalysisError } from "../../../../src/domain/analysisErrorBase.js";
import { open } from "node:fs/promises";
import { ArtifactResourceScope } from "../../../../src/artifacts/ArtifactResourceScope.js";
import { OwnedFileHandle } from "../../../../src/filesystem/OwnedFileHandle.js";
import {
  RegularFileCleanupFailure,
  withOwnedFileHandle,
} from "../../../../src/filesystem/OwnedRegularFile.js";
import {
  ProcessOwnershipInspectionCancelled,
  ProcessOwnershipIdentityBatchFailure,
} from "../../../../src/process/ProcessInspectionCancellation.js";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AnalysisCancelledError } from "../../../../src/domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../../../src/domain/providerCleanupError.js";
import {
  GhidraHeadlessLauncher,
  GhidraLaunchError,
} from "../../../../src/ghidra/GhidraLauncher.js";
import { GhidraLaunchSupportError } from "../../../../src/ghidra/GhidraJavaLaunch.js";
import { ExecFileOutputCancelledError } from "../../../../src/process/ExecFileOutput.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const launch = async (
  javaLaunch: NonNullable<
    ConstructorParameters<typeof GhidraHeadlessLauncher>[0]["javaLaunch"]
  >,
  signal: AbortSignal,
  spawnFailure?: unknown,
  resourceScope?: ArtifactResourceScope,
) => {
  const root = await createTestTempDirectory("rea-ghidra-launch-outcome-");
  const spawnProcess = vi.fn(async () => {
    if (spawnFailure !== undefined) throw spawnFailure;
    throw new Error("Unexpected spawn after Java failure");
  });
  const launcher = new GhidraHeadlessLauncher({
    environment: {},
    platform: "linux",
    analyzeHeadlessPath: join(root, "support", "analyzeHeadless"),
    configurationDirectoryName: "ghidra_12.1.4_PUBLIC",
    javaHome: join(root, "jdk"),
    bridgeScriptPath: join(root, "bridge.java"),
    javaLaunch,
    spawnProcess,
  });
  const result = await launcher.launch(
    {
      runtimeRoot: root,
      transport: "unix-socket",
      endpointPath: join(root, "bridge.sock"),
      token: "fixture-token",
      runId: "fixture-launch-outcome",
      targetPath: join(root, "unused-target"),
      targetSha256: "a".repeat(64),
      providerVersion: "test",
      profileDigest: "b".repeat(64),
    },
    {
      signal,
      resourceScope: resourceScope ?? createTestArtifactResourceScope(),
    },
  );
  expect(spawnProcess).toHaveBeenCalledTimes(
    spawnFailure === undefined ? 0 : 1,
  );
  return result;
};

it.each(["physical", "support"] as const)(
  "preserves %s Java launch failure when cancellation arrives before catch",
  async (kind) => {
    const controller = new AbortController();
    const physical = new Error("controlled earlier physical failure");
    const failure =
      kind === "support"
        ? new GhidraLaunchSupportError("-envvars", physical)
        : physical;
    const result = await launch(async () => {
      controller.abort(null);
      throw failure;
    }, controller.signal);
    if (result.ok) throw new Error("Expected launch failure");
    expect(result.error).toBeInstanceOf(GhidraLaunchError);
    expect(result.error.cause).toBe(failure);
  },
);

it.each([null, "caller stopped helper", new Error("opaque caller reason")])(
  "preserves the LaunchSupport producer's cancellation reason %j",
  async (reason) => {
    const result = await launch(async () => {
      throw new GhidraLaunchSupportError(
        "-envvars",
        new ExecFileOutputCancelledError(reason),
      );
    }, new AbortController().signal);
    if (result.ok) throw new Error("Expected helper cancellation");
    const primary =
      result.error instanceof GhidraLaunchError
        ? result.error.primaryFailure
        : result.error;
    expect(primary).toBeInstanceOf(AnalysisCancelledError);
    expect(primary?.cause).toBe(reason);
  },
);

it("does not adopt a caller error's cleanup resources at initial cancellation", async () => {
  const controller = new AbortController();
  const reason = new ProviderCleanupError("foreign", ["caller-resource"], {
    reason: "caller-owned",
  });
  controller.abort(reason);
  const result = await launch(async () => {
    throw new Error("Unexpected Java launch");
  }, controller.signal);
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error).toMatchObject({
    _tag: "AnalysisCancelledError",
    cause: reason,
    cleanupIncomplete: false,
  });
  expect(reason.cleanupIncomplete).toBe(true);
});

it("wraps an opaque typed caller reason at the real spawn preparation checkpoint", async () => {
  const root = await createTestTempDirectory("rea-ghidra-preparation-cancel-");
  const controller = new AbortController();
  const reason = new ProviderCleanupError("foreign", ["foreign-resource"], {
    reason: "caller-owned",
  });
  const launcher = new GhidraHeadlessLauncher({
    environment: {},
    platform: process.platform,
    analyzeHeadlessPath: join(root, "support", "analyzeHeadless"),
    configurationDirectoryName: "ghidra_12.1.4_PUBLIC",
    javaHome: join(root, "jdk"),
    bridgeScriptPath: join(root, "bridge.java"),
    javaLaunch: async () => {
      controller.abort(reason);
      return {
        command: join(root, "must-not-spawn"),
        arguments: [],
        environment: {},
      };
    },
  });
  const result = await launcher.launch(
    {
      runtimeRoot: root,
      transport: "unix-socket",
      endpointPath: join(root, "bridge.sock"),
      token: "fixture-token",
      runId: "fixture-preparation-cancel",
      targetPath: join(root, "unused-target"),
      targetSha256: "a".repeat(64),
      providerVersion: "test",
      profileDigest: "b".repeat(64),
    },
    {
      resourceScope: createTestArtifactResourceScope(),
      signal: controller.signal,
    },
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      primaryFailure: {
        _tag: "AnalysisCancelledError",
        cause: reason,
        cleanupIncomplete: false,
      },
      cleanupFailure: undefined,
    },
  });
  expect(reason.cleanupIncomplete).toBe(true);
});

it.each(["direct", "batch"] as const)(
  "preserves %s typed spawn cancellation independently of a later signal",
  async (kind) => {
    const reason = new ProviderCleanupError("foreign", ["caller-resource"], {
      reason: "opaque caller value",
    });
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
    const result = await launch(
      async () => ({
        command: "/must-not-run",
        arguments: [],
        environment: {},
      }),
      new AbortController().signal,
      failure,
    );
    if (result.ok) throw new Error("Expected spawn cancellation");
    expect(result.error).toMatchObject({
      primaryFailure: {
        _tag: "AnalysisCancelledError",
        cause: reason,
        cleanupIncomplete: false,
      },
      cleanupFailure: undefined,
    });
    if (!(result.error instanceof GhidraLaunchError)) throw result.error;
    expect(result.error.cause).toBe(failure);
    const primary = result.error.primaryFailure;
    if (primary === undefined || !("inspectionFailure" in primary))
      throw new Error("Missing ownership inspection origin");
    expect(primary.inspectionFailure).toBe(failure);
    expect(reason.cleanupIncomplete).toBe(true);
  },
);

it.each(["identity", "name"] as const)(
  "keeps physical spawn failure despite %s cancellation resemblance",
  async (kind) => {
    const controller = new AbortController();
    const physical = new Error("physical spawn refusal", { cause: null });
    physical.name = "AbortError";
    const result = await launch(
      async () => {
        controller.abort(kind === "identity" ? physical : null);
        return { command: "/must-not-run", arguments: [], environment: {} };
      },
      controller.signal,
      physical,
    );
    if (result.ok) throw new Error("Expected physical spawn failure");
    expect(result.error).toBeInstanceOf(GhidraLaunchError);
    expect(result.error.cause).toBe(physical);
    if (!(result.error instanceof GhidraLaunchError)) throw result.error;
    expect(result.error.primaryFailure).toBeUndefined();
  },
);

it("retains every preparation descriptor and the exact mixed batch through partial cleanup retry", async () => {
  const root = await createTestTempDirectory("rea-ghidra-preparation-owners-");
  const scope = new ArtifactResourceScope();
  const physical = new Error("physical identity read failure");
  const reason = { caller: "later cancellation" };
  const observations = new Map([
    [
      44,
      {
        state: "unavailable" as const,
        reason: "completed sibling observation",
      },
    ],
  ]);
  const sources: RegularFileCleanupFailure[] = [];
  const calls = [0, 0];
  let denySecond = true;
  try {
    for (let index = 0; index < 2; index++) {
      const path = join(root, `identity-${index}`);
      const handle = await open(path, "w+");
      const owner = new OwnedFileHandle(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        calls[index]!++;
        if (calls[index] === 1 || (index === 1 && denySecond))
          throw new Error(`close denied ${index}`);
        await close();
      });
      const source = await withOwnedFileHandle(path, owner, {}, async () => {
        throw physical;
      }).catch((cause: unknown) => cause);
      if (!(source instanceof RegularFileCleanupFailure)) throw source;
      sources.push(source);
    }
    const batch = new ProcessOwnershipIdentityBatchFailure(
      [
        ...sources.map((cause, requestIndex) => ({
          pid: 42 + requestIndex,
          requestIndex,
          cause,
        })),
        {
          pid: 45,
          requestIndex: 2,
          cause: new ProcessOwnershipInspectionCancelled(reason),
        },
      ],
      observations,
    );
    const result = await launch(
      async () => ({
        command: "/must-not-run",
        arguments: [],
        environment: {},
      }),
      new AbortController().signal,
      batch,
      scope,
    );
    if (result.ok || !(result.error instanceof GhidraLaunchError))
      throw new Error("Expected physical launch failure");
    expect(result.error.cause).toBe(batch);
    expect(batch.observations).toBe(observations);
    expect(result.error.primaryFailure).toMatchObject({
      _tag: "ProviderAdapterError",
      cause: batch,
    });
    const cleanup = result.error.cleanupFailure;
    expect(cleanup?.cleanupIncomplete).toBe(true);
    expect(cleanup?.cleanupResources).toEqual(sources.map(({ path }) => path));
    await expect(scope.close()).rejects.toBeDefined();
    expect(calls).toEqual([2, 2]);
    expect(cleanup?.cleanupIncomplete).toBe(true);
    denySecond = false;
    await scope.close();
    expect(calls).toEqual([2, 3]);
    expect(cleanup?.cleanupIncomplete).toBe(false);
    expect(batch.observations).toBe(observations);
  } finally {
    denySecond = false;
    await scope.close();
    for (const source of sources) await source.owner.close();
  }
});

it("keeps the cancellation primary through retained Darwin preparation cleanup and retry", async () => {
  const scope = new ArtifactResourceScope();
  const reason = { caller: "cancel helper preparation" };
  const cleanup = new ProviderCleanupError(
    "process-ownership",
    ["held-helper"],
    { reason: "authored close denial" },
  );
  let denied = true;
  const source = new DarwinProcessOwnershipInspectionError("cancelled helper", {
    cancellation: { reason },
    cleanupFailure: cleanup,
    cleanupOwner: {
      close: async () => {
        if (denied) throw cleanup;
        cleanup.resolveCleanup();
      },
    },
  });
  try {
    const result = await launch(
      async () => ({
        command: "/must-not-run",
        arguments: [],
        environment: {},
      }),
      new AbortController().signal,
      source,
      scope,
    );
    if (result.ok || !(result.error instanceof GhidraLaunchError))
      throw new Error("Expected retained preparation cancellation");
    expect(result.error.cause).toBe(source);
    expect(result.error.primaryFailure?.cause).toBe(reason);
    const retained = result.error.cleanupFailure;
    if (retained === undefined) throw new Error("Missing preparation cleanup");
    expect(primaryAnalysisError(retained).cause).toBe(reason);
    await expect(scope.close()).rejects.toBeDefined();
    expect(retained.cleanupIncomplete).toBe(true);
    denied = false;
    await scope.close();
    expect(retained.cleanupIncomplete).toBe(false);
    expect(primaryAnalysisError(retained).cause).toBe(reason);
  } finally {
    denied = false;
    await scope.close();
  }
});
