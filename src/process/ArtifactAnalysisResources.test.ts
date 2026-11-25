import { unknownTarget } from "../domain/targetIdentity.js";
import { AnalysisCleanupLease } from "../resources/AnalysisCleanupLease.js";
import {
  artifactResourceDialect,
  createArtifactAnalysisResources,
} from "../providers/artifactResourceFailure.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import {
  ArtifactResourceRetryFailure,
  ArtifactResourceScope,
} from "../resources/ArtifactResourceScope.js";
import { withArtifactRegularFile } from "../resources/ArtifactFileOperation.js";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";
import { withVerifierCleanup } from "../../scripts/lib/verifier-cleanup.mjs";
import { OwnedCommandFailure } from "./OwnedCommand.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { readStableArtifact } from "../resources/readStableArtifact.js";
import { ArtifactReaderFailure } from "../resources/ArtifactReader.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { createEvidence } from "../domain/evidence.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { UnclassifiedProviderFailure } from "../domain/unclassifiedProviderFailure.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok } from "../domain/result.js";
import { ArtifactAnalysisResources } from "./ArtifactAnalysisResources.js";
import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";
import {
  type LinuxResourceLimits,
  readLinuxResourceLimits,
} from "./LinuxResourceLimits.js";
import { ProviderProcessSupervisor } from "./ProviderProcess.js";
import type {
  AnalysisError,
  AnalysisPartialObservation,
} from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";
import { finalizedResult, runOwned } from "../providers/runOwned.js";

/** Providers finalize these resources through runOwned with their release as the close. */
const finish = async <T>(
  resources: ArtifactAnalysisResources,
  result: Result<T, AnalysisError>,
  partial: (value: T) => AnalysisPartialObservation,
  operation = resources.operation,
  signal?: AbortSignal,
): Promise<Result<T, AnalysisError>> =>
  finalizedResult(
    await runOwned(async () => result, {
      providerId: resources.providerId,
      operation,
      signal,
      close: () => resources.release(),
      partial,
    }),
  );

it.runIf(process.platform !== "win32")(
  "offers a resolved-file retry from the shared selected-artifact boundary",
  async () => {
    const root = await createTestTempDirectory("rea-selected-artifact-");
    const target = join(root, "target.bin");
    const selected = join(root, "selected");
    await writeFile(target, "fixture");
    await symlink(target, selected);
    const resources = createArtifactAnalysisResources(
      "fixture-provider",
      "decode_signal_recording",
      readStableArtifact,
      readLinuxResourceLimits,
      { message: "busy", details: {} },
    );
    try {
      const result = await resources.run(async () =>
        ok(
          await resources.readSelectedArtifact({
            path: selected,
            maximumBytes: 1024,
            allowanceName: "fixture input allowance",
            observedOutput: undefined,
          }),
        ),
      );
      if (result.ok) throw new Error("Expected selected symlink refusal");
      const projected = projectAnalysisError(result.error);
      expect(projected.remediation.action).toContain(target);
      expect(projected).not.toHaveProperty("recovery");
    } finally {
      await resources.close();
    }
  },
);

it.each(["command", "limiter"])(
  "attributes post-run %s read failure to its exact artifact and retains producer output",
  async (failedPath) => {
    const source = new ArtifactReaderFailure("path", "Artifact was replaced");
    const reads: string[] = [];
    const resources = createArtifactAnalysisResources(
      "fixture-provider",
      "fixture-operation",
      async (path) => {
        reads.push(path);
        if (path === failedPath) throw source;
        return { bytes: Buffer.from("executable"), sha256: "unchanged" };
      },
      readLinuxResourceLimits,
      { message: "busy", details: {} },
    );
    const output = {
      stdout: "completed observation",
      stderr: "producer warning",
      truncated: true,
      exit_code: 0,
      signal: null,
    };
    try {
      const result = await resources.run(async () =>
        ok(
          await resources.readCommandAfterRun(
            "command",
            { path: "limiter", sha256: "unchanged" },
            output,
            "inspect_signal_decoders",
          ),
        ),
      );
      if (result.ok) throw new Error("Expected failed post-run verification");
      expect(result.error).toMatchObject({
        _tag: "AnalysisArtifactChangedError",
        operation: "inspect_signal_decoders",
        path: failedPath,
        capturedOutput: output,
      });
      expect(result.error.cause).toBe(source);
      expect(reads).toEqual(
        failedPath === "command" ? ["command"] : ["command", "limiter"],
      );
    } finally {
      await resources.close();
    }
  },
);

it("projects the specific reason and member evidence for retained cleanup", async () => {
  const producer = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    // The leader exited. Its remaining members still need verification.
    exitCode: 0,
    signalCode: null,
    kill: () => true,
  });
  const owner = new ProviderProcessSupervisor({
    process: producer,
    ownsProcessLifetime: true,
    ownership: {
      runId: "rea-tshark-run-1",
      leaderPid: 4242,
      processGroupId: 4242,
    },
    cleanup: async () => ({
      cleaned: false as const,
      reason: "process ownership token could not be read for 1 live process",
      failures: [
        {
          pid: 101,
          reason: "environment-unreadable" as const,
          diagnostic: "sysctl_errno_22",
        },
      ],
      unverified: [
        { pid: 900, diagnostic: "platform_binary_environment_withheld" },
      ],
    }),
  });
  const resources = createArtifactAnalysisResources(
    "fixture-provider",
    "fixture-operation",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  resources.retain({ path: "runtime-root", close: async () => {} }, owner);

  const result = await finish(
    resources,
    err(new ProviderAdapterError("fixture-provider", "fixture-operation")),
    () => {
      throw new Error("unexpected success observation");
    },
  );
  owner.dispose();

  if (result.ok) throw new Error("expected cleanup failure");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      resources: [
        "rea-tshark-run-1",
        "runtime-root",
        "pid:4242",
        "process-group:4242",
      ],
      diagnostics: {
        cleanup_error: {
          details: {
            diagnostics: {
              reason:
                "process ownership token could not be read for 1 live process",
              failures: [
                {
                  pid: 101,
                  reason: "environment-unreadable",
                  diagnostic: "sysctl_errno_22",
                },
              ],
              unverified: [
                {
                  pid: 900,
                  diagnostic: "platform_binary_environment_withheld",
                },
              ],
            },
          },
        },
      },
    },
  });
});

it("preserves the primary error and resolves cleanup status after retry", async () => {
  let closes = 0;
  const resources = createArtifactAnalysisResources(
    "fixture-provider",
    "fixture-operation",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  resources.retain({
    path: "runtime-root",
    close: async () => {
      closes++;
      if (closes === 1) throw new Error("temporary close failure");
    },
  });
  const primary = new AnalysisOutputError(
    "fixture-operation",
    "producer returned malformed output",
    {
      partialObservation: createEvidence(
        unknownTarget("not-observed"),
        {
          id: "fixture",
          name: "Fixture",
          version: null,
        },
        {
          operation: "inspect_signal_decoders",
          parameters: {},
          result: { decoders: [] },
          confidence: "observed",
        },
      ),
    },
  );

  const result = await finish(resources, err(primary), () => {
    throw new Error("unexpected success observation");
  });

  if (result.ok) throw new Error("expected cleanup failure");
  expect(result.error.cause).toBeInstanceOf(AggregateError);
  expect((result.error.cause as AggregateError).errors).toEqual([
    primary,
    expect.any(ProviderCleanupError),
  ]);
  expect(result.error.partialObservation).toEqual(primary.partialObservation);
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.diagnostics).toMatchObject({
    primary_error: { code: "unreadable_output" },
  });

  await resources.release();

  expect(result.error.cleanupIncomplete).toBe(false);
  expect(closes).toBe(2);
  await resources.close();
});

it("resolves each returned cleanup error with its own retained root", async () => {
  let closesA = 0;
  let closesB = 0;
  const resources = createArtifactAnalysisResources(
    "fixture-provider",
    "fixture-operation",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  resources.retain({
    path: "runtime-root-a",
    close: async () => {
      closesA++;
      if (closesA === 1) throw new Error("root A close failure");
    },
  });
  const first = await finish(
    resources,
    err(new AnalysisOutputError("fixture-operation", "primary failure")),
    () => {
      throw new Error("unexpected success observation");
    },
  );
  if (first.ok) throw new Error("expected root A cleanup failure");

  resources.retain({
    path: "runtime-root-b",
    close: async () => {
      closesB++;
      if (closesB === 1) throw new Error("root B close failure");
    },
  });
  const partial = createEvidence(
    unknownTarget("not-observed"),
    { id: "fixture", name: "Fixture", version: null },
    {
      operation: "fixture-operation",
      parameters: {},
      result: { state: "partial" },
      confidence: "observed",
    },
  );
  const second = await finish(resources, ok("completed"), () => partial);

  if (second.ok) throw new Error("expected root B cleanup failure");
  expect(second.error.partialObservation).toEqual(partial);
  expect(first.error.cleanupIncomplete).toBe(false);
  expect(second.error.cleanupIncomplete).toBe(true);

  await resources.release();
  expect(second.error.cleanupIncomplete).toBe(false);
  await resources.close();
});

it("resolves an artifact cleanup error when its scope owner later closes", async () => {
  let closes = 0;
  const readArtifact: typeof readStableArtifact = async (
    _path,
    _maximumBytes,
    _signal,
    _fileSystem,
    scope,
  ) => {
    if (scope === undefined) throw new Error("expected scoped artifact read");
    if (closes === 0) {
      const owner = {
        kind: "lease",
        resource: "fixture descriptor",
        lease: new AnalysisCleanupLease(async () => {
          closes++;
          if (closes === 1) throw new Error("descriptor remains open");
        }, ["fixture descriptor"]),
      } as const;
      expect(await scope.release(owner)).toMatchObject({ kind: "failed" });
      throw new ArtifactResourceRetryFailure(
        [{ owner, lease: owner.lease }],
        "Descriptor close failed",
        {
          cleanup: {
            reason: "descriptor remains open",
            resources: ["fixture descriptor"],
          },
        },
      );
    }
    return { bytes: Buffer.alloc(0), sha256: "0".repeat(64) };
  };
  const resources = createArtifactAnalysisResources(
    "fixture-provider",
    "fixture-operation",
    readArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  const first = await resources.run(async () =>
    ok(await resources.read("fixture", 1)),
  );

  if (first.ok) throw new Error("expected descriptor cleanup failure");
  expect(first.error.cleanupIncomplete).toBe(true);

  const retried = await resources.run(async () =>
    ok(await resources.read("fixture", 1)),
  );

  if (!retried.ok) throw retried.error;
  expect(retried.value).toEqual({
    bytes: Buffer.alloc(0),
    sha256: "0".repeat(64),
  });
  expect(first.error.cleanupIncomplete).toBe(false);
  expect(closes).toBe(2);
  await resources.close();
});

it("keeps a runtime root until its descriptor cleanup owner is released", async () => {
  let descriptorCloses = 0;
  let rootCloses = 0;
  const readArtifact: typeof readStableArtifact = async (
    _path,
    _maximumBytes,
    _signal,
    _fileSystem,
    scope,
  ) => {
    if (scope === undefined) throw new Error("expected scoped artifact read");
    if (descriptorCloses === 0) {
      const owner = {
        kind: "lease",
        resource: "fixture descriptor",
        lease: new AnalysisCleanupLease(async () => {
          descriptorCloses++;
          if (descriptorCloses === 1)
            throw new Error("descriptor remains open");
        }, ["fixture descriptor"]),
      } as const;
      expect(await scope.release(owner)).toMatchObject({ kind: "failed" });
      throw new ArtifactResourceRetryFailure(
        [{ owner, lease: owner.lease }],
        "Descriptor close failed",
        {
          cleanup: {
            reason: "descriptor remains open",
            resources: ["fixture descriptor"],
          },
        },
      );
    }
    return { bytes: Buffer.alloc(0), sha256: "0".repeat(64) };
  };
  const resources = createArtifactAnalysisResources(
    "fixture-provider",
    "fixture-operation",
    readArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  const first = await resources.run(async () =>
    ok(await resources.read("fixture", 1)),
  );
  if (first.ok) throw new Error("expected descriptor cleanup failure");
  resources.retain({
    path: "runtime-root",
    close: async () => {
      rootCloses++;
    },
  });

  const outer = await finish(resources, first, () => {
    throw new Error("unexpected success observation");
  });

  if (outer.ok) throw new Error("expected combined cleanup failure");
  expect(rootCloses).toBe(0);
  expect(outer.error.cleanupResources).toEqual([
    "fixture descriptor",
    "runtime-root",
  ]);
  expect(outer.error.cause).toBeInstanceOf(AggregateError);
  expect((outer.error.cause as AggregateError).errors[0]).toBe(first.error);
  expect(first.error.cleanupIncomplete).toBe(true);

  const retried = await resources.run(async () =>
    ok(await resources.read("fixture", 1)),
  );
  if (!retried.ok) throw retried.error;
  expect(retried.value).toEqual({
    bytes: Buffer.alloc(0),
    sha256: "0".repeat(64),
  });
  expect(first.error.cleanupIncomplete).toBe(false);
  await resources.release();
  expect(rootCloses).toBe(1);
  expect(outer.error.cleanupIncomplete).toBe(false);
  await resources.close();
});

const classifyFixtureCommand = (
  resources: ArtifactAnalysisResources,
  failure: OwnedCommandFailure,
  limits: Parameters<ArtifactAnalysisResources["commandContext"]>[0],
  effectiveLimits?: LinuxResourceLimits,
) =>
  classifyProviderFailure(failure, {
    providerId: resources.providerId,
    operation: resources.operation,
    command: () =>
      resources.commandContext(limits, effectiveLimits, resources.operation),
    unclassified: (cause) => {
      throw cause;
    },
  });

it.each([
  null,
  "opaque reason",
  new ProviderCleanupError("foreign", ["foreign-resource"], {
    reason: "caller cleanup",
  }),
])(
  "preserves opaque cancellation through admission and command classification: %s",
  async (reason) => {
    const resources = createArtifactAnalysisResources(
      "fixture",
      "inspect_signal_decoders",
      readStableArtifact,
      readLinuxResourceLimits,
      { message: "busy", details: {} },
    );
    let calls = 0;
    try {
      const result = await resources.run(async () => {
        calls += 1;
        return ok("unexpected");
      }, AbortSignal.abort(reason));
      if (result.ok) throw new Error("Expected cancelled admission");
      expect(calls).toBe(0);
      const failure = new OwnedCommandFailure(
        "cancelled",
        "cancelled command",
        null,
        null,
        {
          cause: new Error("physical collection interruption"),
          cancellation: { reason },
        },
      );
      const command = classifyFixtureCommand(resources, failure, {
        command_timeout_ms: 100,
        output_bytes: 1024,
      });
      for (const error of [result.error, command]) {
        expect(error).toMatchObject({ _tag: "AnalysisCancelledError" });
        expect(error.cause).toBe(reason);
        expect(error.cleanupResources).toEqual([]);
      }
      if (reason instanceof ProviderCleanupError)
        expect(reason.cleanupIncomplete).toBe(true);
    } finally {
      await resources.close();
    }
  },
);

it.each([false, true])(
  "preserves artifact cancellation and independent failed cleanup (failed close: %s)",
  async (failedClose) => {
    const reason = { request: "artifact cancellation" };
    const root = await createTestTempDirectory("rea-resource-cancel-");
    const path = join(root, "descriptor");
    await writeFile(path, "authored bytes");
    let mayClose = false;
    const readArtifact: typeof readStableArtifact = async (
      _path,
      _limit,
      _signal,
      _fs,
      scope,
    ) => {
      const primary = new ArtifactReaderFailure("cancelled", "read cancelled", {
        cause: reason,
      });
      if (!failedClose) throw primary;
      if (scope === undefined) throw new Error("Expected retained file scope");
      return withArtifactRegularFile(
        path,
        scope,
        _signal,
        async ({ handle: file }) => {
          const close = file.close.bind(file);
          file.close = async () => {
            if (!mayClose) throw new Error("injected descriptor close failure");
            await close();
          };
          throw primary;
        },
      );
    };
    const resources = createArtifactAnalysisResources(
      "fixture",
      "inspect_signal_decoders",
      readArtifact,
      readLinuxResourceLimits,
      { message: "busy", details: {} },
    );
    try {
      const result = await resources.run(async () =>
        ok(await resources.read("fixture", 1)),
      );
      if (result.ok) throw new Error("Expected cancelled artifact read");
      const primary = failedClose ? result.error.cleanupPrimary : result.error;
      expect(primary).toMatchObject({ _tag: "AnalysisCancelledError" });
      expect(primary?.cause).toBe(reason);
      expect(result.error.cleanupIncomplete).toBe(failedClose);
      mayClose = true;
      await resources.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(primary?.cause).toBe(reason);
    } finally {
      mayClose = true;
      await resources.close();
    }
  },
);

it.each([
  [30_000, "Increase producer_limits.command_timeout_ms above 30000"],
  [MAX_NODE_TIMER_DELAY_MS, "no higher deadline is supported"],
] as const)(
  "reports the per-call producer deadline at %i ms",
  async (deadline, recovery) => {
    const resources = createArtifactAnalysisResources(
      "fixture",
      "inspect_packet_fields",
      readStableArtifact,
      readLinuxResourceLimits,
      { message: "busy", details: {} },
    );
    try {
      const timeout = classifyFixtureCommand(
        resources,
        new OwnedCommandFailure("timeout", "command timed out"),
        { command_timeout_ms: deadline, output_bytes: 1024 },
      );
      expect(projectAnalysisError(timeout)).toMatchObject({
        code: "provider_timeout",
        message: expect.stringContaining(`${String(deadline)} ms`),
        remediation: { action: expect.stringContaining(recovery) },
      });
    } finally {
      await resources.close();
    }
  },
);

it.each([
  {
    signal: "SIGXCPU",
    resource: "cpu",
    effective: {
      address_space_bytes: 1_073_741_824,
      file_bytes: 67_108_864,
      cpu_seconds: 30,
    },
  },
  {
    signal: "SIGXFSZ",
    resource: "file-size",
    effective: undefined,
  },
] as const)(
  "keeps retry uncertainty and inherited limit facts for $signal",
  async ({ signal, resource, effective }) => {
    const resources = createArtifactAnalysisResources(
      "fixture",
      "inspect_packet_fields",
      readStableArtifact,
      readLinuxResourceLimits,
      { message: "busy", details: {} },
    );
    const empty = { text: "", bytes: 0, observedBytes: 0 };
    const failure = new OwnedCommandFailure("process", "producer signal", {
      stdout: empty,
      stderr: empty,
      exitCode: null,
      signal,
    });
    try {
      const projected = projectAnalysisError(
        classifyFixtureCommand(
          resources,
          failure,
          { command_timeout_ms: 30_000, output_bytes: 4_194_304 },
          effective,
        ),
      );
      expect(projected).toMatchObject({
        retryable: true,
        details: { resource, reported_limits: effective ?? null },
      });
      const action = projected.remediation.action;
      if (effective === undefined) {
        expect(action).toMatch(/inherited limit.*not reported/iu);
      } else {
        expect(action).toContain(
          `${String(effective.address_space_bytes)} bytes of address space`,
        );
        expect(action).toContain(
          `${String(effective.file_bytes)} bytes per file`,
        );
        expect(action).toContain(
          `${String(effective.cpu_seconds)} CPU seconds`,
        );
      }
      expect(action).toContain("tighter inherited limit");
      expect(action).toContain(
        `producer_limits.${signal === "SIGXFSZ" ? "file_bytes" : "cpu_seconds"}`,
      );
      expect(action).toContain(
        "cannot raise a tighter inherited soft or hard limit",
      );
      expect(action).toMatch(/unchanged retry.*may succeed.*may fail/iu);
      expect(action).not.toMatch(/unchanged request.*fails/iu);
    } finally {
      await resources.close();
    }
  },
);

it("retains a physical command failure when the owner also observed late cancellation", async () => {
  const resources = createArtifactAnalysisResources(
    "fixture",
    "inspect_signal_decoders",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  const reason = { request: "late cancellation" };
  const failure = new OwnedCommandFailure(
    "process",
    "physical failure",
    null,
    null,
    { cancellation: { reason } },
  );
  try {
    const error = classifyFixtureCommand(resources, failure, {
      command_timeout_ms: 100,
      output_bytes: 1024,
    });
    expect(error).toBeInstanceOf(UnclassifiedProviderFailure);
    expect(error).toMatchObject({
      providerId: "fixture",
      examined: { failure_kind: "protocol", reason: "physical failure" },
    });
    expect(projectAnalysisError(error).code).toBe("execution_failure");
    expect(error.cause).toBe(failure);
  } finally {
    await resources.close();
  }
});

it("preserves typed caller cancellation through failed workspace cleanup and retry", async () => {
  let denied = true;
  const resources = createArtifactAnalysisResources(
    "fixture",
    "inspect_signal_decoders",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  const reason = { request: "cancelled before workspace cleanup" };
  const primary = new AnalysisCancelledError("inspect_signal_decoders", {
    cause: reason,
  });
  resources.retain({
    path: "workspace",
    close: async () => {
      if (denied) throw new Error("workspace close denied");
    },
  });
  try {
    const result = await finish(resources, err(primary), () => {
      throw new Error("Must not produce success Evidence");
    });
    if (result.ok) throw new Error("Expected retained workspace");
    expect(result.error.cleanupPrimary).toBe(primary);
    expect(result.error.cleanupPrimary?.cause).toBe(reason);
    await expect(resources.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    denied = false;
    await resources.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.cleanupPrimary?.cause).toBe(reason);
  } finally {
    denied = false;
    await resources.close();
  }
});

it("observes cancellation after pending descriptor cleanup before admitting replacement work", async () => {
  let closes = 0;
  const descriptorCleanup = phaseGate();
  const readArtifact: typeof readStableArtifact = async (
    _path,
    _limit,
    _signal,
    _fs,
    scope,
  ) => {
    if (scope === undefined) throw new Error("Expected file scope");
    const retained = {
      kind: "lease",
      resource: "descriptor",
      lease: new AnalysisCleanupLease(async () => {
        closes++;
        if (closes === 1) throw new Error("descriptor close denied");
        await descriptorCleanup.hold();
      }, ["descriptor"]),
    } as const;
    await scope.release(retained);
    throw new ArtifactResourceRetryFailure(
      [{ owner: retained, lease: retained.lease }],
      "descriptor cleanup failed",
      {
        cleanup: {
          reason: "descriptor close denied",
          resources: ["descriptor"],
        },
      },
    );
  };
  const resources = createArtifactAnalysisResources(
    "fixture",
    "inspect_signal_decoders",
    readArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  let calls = 0;
  const caller = new AbortController();
  let pending: ReturnType<typeof resources.run> | undefined;
  await withVerifierCleanup(async () => {
    const first = await resources.run(async () =>
      ok(await resources.read("fixture", 1)),
    );
    expect(first).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    const reason = { request: "cancel while old descriptor closes" };
    pending = resources.run(async () => {
      calls++;
      return ok("Must not run");
    }, caller.signal);
    await descriptorCleanup.reached(pending, "descriptor cleanup");
    caller.abort(reason);
    descriptorCleanup.release();
    const result = await pending;
    if (result.ok) throw new Error("Expected cancelled replacement");
    expect(result.error.cause).toBe(reason);
    expect(calls).toBe(0);
    if (!first.ok) expect(first.error.cleanupIncomplete).toBe(false);
  }, [
    () => caller.abort(),
    descriptorCleanup.release,
    async () => {
      await pending;
    },
    () => resources.close(),
  ]);
});

it.each([false, true])(
  "keeps an existing physical primary across cleanup-time cancellation (failed close: %s)",
  async (failsClose) => {
    const resources = createArtifactAnalysisResources(
      "fixture",
      "inspect_signal_decoders",
      readStableArtifact,
      readLinuxResourceLimits,
      { message: "busy", details: {} },
    );
    const caller = new AbortController();
    const primary = new AnalysisOutputError(
      "inspect_signal_decoders",
      "physical producer report failure",
    );
    let denied = failsClose;
    resources.retain({
      path: "workspace",
      close: async () => {
        caller.abort({ request: "late cancellation" });
        if (denied) throw new Error("workspace close denied");
      },
    });
    try {
      const result = await finish(
        resources,
        err(primary),
        () => {
          throw new Error("Failed work must not produce success Evidence");
        },
        "inspect_signal_decoders",
        caller.signal,
      );
      if (result.ok) throw new Error("Expected original physical failure");
      expect(failsClose ? result.error.cleanupPrimary : result.error).toBe(
        primary,
      );
      // The recorded failure stays primary and keeps the late cancellation.
      expect(primary.secondaryFailures).toEqual([
        expect.objectContaining({
          _tag: "AnalysisCancelledError",
          cause: { request: "late cancellation" },
        }),
      ]);
      denied = false;
      await resources.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(failsClose ? result.error.cleanupPrimary : result.error).toBe(
        primary,
      );
    } finally {
      denied = false;
      await resources.close();
    }
  },
);

it("keeps cleanup with no reported capability unresolved instead of clearing it from an empty scope", async () => {
  const resources = createArtifactAnalysisResources(
    "fixture",
    "inspect_signal_decoders",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  const source = new ArtifactReaderFailure("io", "unverified cleanup", {
    cleanup: {
      reason: "no cleanup capability reported",
      resources: ["unverified-resource"],
    },
  });
  const result = await resources.run(async () => {
    throw source;
  });
  if (result.ok) throw new Error("Expected unresolved cleanup");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual(["unverified-resource"]);
  let calls = 0;
  const blocked = await resources.run(async () => {
    calls++;
    return ok("Must not run");
  });
  expect(blocked).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(calls).toBe(0);
  await expect(resources.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  expect(result.error.cleanupIncomplete).toBe(true);
  // No OS resource was supplied. An unresolved observation never grants cleanup authority.
});

it("retains producer output when a completed read is cancelled during failed close", async () => {
  const root = await createTestTempDirectory("rea-completed-read-cancel-");
  const path = join(root, "descriptor");
  await writeFile(path, "authored bytes");
  const caller = new AbortController();
  const reason = { request: "cancel during close" };
  const scope = new ArtifactResourceScope();
  const resources = createArtifactAnalysisResources(
    "fixture",
    "inspect_signal_decoders",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  let mayClose = false;
  const output = {
    stdout: "completed producer output",
    stderr: "",
    truncated: false,
    exit_code: 0,
  };
  try {
    const cause: unknown = await withArtifactRegularFile(
      path,
      scope,
      caller.signal,
      async ({ handle: file }) => {
        const close = file.close.bind(file);
        file.close = async () => {
          caller.abort(reason);
          if (!mayClose) throw new Error("controlled descriptor close failure");
          await close();
        };
        return await file.readFile();
      },
    ).catch((cause: unknown) => cause);
    if (!(cause instanceof ArtifactReaderFailure))
      throw new Error("Expected retained artifact failure");
    const error = classifyProviderFailure(
      cause,
      artifactResourceDialect(resources, {
        kind: "integrity",
        operation: "inspect_signal_decoders",
        path,
        capturedOutput: output,
      }),
    );
    const primary = error.cleanupPrimary;
    expect(primary).toMatchObject({
      _tag: "AnalysisCancelledError",
      cause: reason,
      capturedOutput: output,
    });
    expect(error.capturedOutput).toEqual(output);
    expect(error.cleanupIncomplete).toBe(true);
    await expect(scope.close()).rejects.toMatchObject({
      reason: "unavailable",
    });
    mayClose = true;
    await scope.close();
    expect(error.cleanupIncomplete).toBe(false);
    expect(error.cleanupPrimary).toBe(primary);
    expect(error.capturedOutput).toEqual(output);
    expect(projectAnalysisError(error)).toMatchObject(
      projectAnalysisError(primary!),
    );
  } finally {
    mayClose = true;
    await scope.close();
    await resources.close();
  }
});

it("keeps aggregate cleanup live through partial recovery without reclosing healthy roots", async () => {
  const resources = createArtifactAnalysisResources(
    "fixture",
    "inspect_signal_decoders",
    readStableArtifact,
    readLinuxResourceLimits,
    { message: "busy", details: {} },
  );
  const denied = new Set(["first", "second"]);
  const closes = new Map<string, number>();
  for (const path of ["first", "healthy", "second"])
    resources.retain({
      path,
      close: async () => {
        closes.set(path, (closes.get(path) ?? 0) + 1);
        if (denied.has(path)) throw new Error(`Close denied: ${path}`);
      },
    });
  try {
    const original: unknown = await resources
      .release()
      .catch((cause: unknown) => cause);
    expect(original).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["first", "second"],
    });
    expect(closes.get("healthy")).toBe(1);
    expect(resources.pendingPaths).toEqual(["first", "second"]);
    denied.delete("first");
    const retry: unknown = await resources
      .release()
      .catch((cause: unknown) => cause);
    expect(original).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["second"],
    });
    expect(retry).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["second"],
    });
    expect(resources.pendingPaths).toEqual(["second"]);
    denied.clear();
    await resources.close();
    for (const error of [original, retry])
      expect(error).toMatchObject({
        cleanupIncomplete: false,
        cleanupResources: [],
      });
    expect(closes).toEqual(
      new Map([
        ["first", 2],
        ["healthy", 1],
        ["second", 3],
      ]),
    );
  } finally {
    denied.clear();
    await resources.close();
  }
});
