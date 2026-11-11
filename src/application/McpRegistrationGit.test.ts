import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { failedInspectionDescriptor } from "../../tests/fixtures/processInspectionCleanup.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  ProcessOwnershipInspectionCancelled,
} from "../process/ProcessInspectionCancellation.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import * as owned from "../process/OwnedCommand.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import { resolveKiloRegistrationWorktree } from "./McpRegistrationGit.js";
import { resolveMcpRegistrationClients } from "./McpRegistrationCatalog.js";
import * as locations from "./McpRegistrationLocations.js";
import type { McpRegistrationLocationContext } from "./McpRegistrationLocations.js";

let resources: ArtifactResourceScope;
beforeEach(() => {
  resources = new ArtifactResourceScope();
  vi.spyOn(owned, "prepareOwnedCommand").mockResolvedValue(undefined);
  vi.spyOn(owned, "runOwnedCommand").mockRejectedValue(
    new Error("An inert Git outcome must be selected by the fixture"),
  );
});
afterEach(async () => {
  try {
    await resources.close();
  } finally {
    vi.mocked(owned.prepareOwnedCommand).mockRestore();
    vi.mocked(owned.runOwnedCommand).mockRestore();
  }
});

const context = async (
  signal?: AbortSignal,
): Promise<McpRegistrationLocationContext> => {
  const root = await createTestTempDirectory("rea-registration-git-");
  await mkdir(join(root, ".git"));
  return {
    cwd: root,
    home: root,
    platform: process.platform,
    environment: {},
    setup: [],
    resources,
    ...(signal === undefined ? {} : { signal }),
  };
};

it.each(["process", "timeout", "output-limit"] as const)(
  "keeps observed %s failure primary when cancellation arrives during Git completion",
  async (reason) => {
    const abort = new AbortController();
    const opaque = { operator: "cancel", detail: new Error("opaque reason") };
    const failure = new owned.OwnedCommandFailure(
      reason,
      "Physical Git observation failed",
      null,
      null,
      { cancellation: { reason: opaque }, cause: new Error("physical cause") },
    );
    vi.mocked(owned.runOwnedCommand).mockImplementation(async () => {
      abort.abort(opaque);
      throw failure;
    });
    const observed: unknown = await resolveKiloRegistrationWorktree(
      await context(abort.signal),
    ).catch((cause: unknown) => cause);
    expect(observed).toBeInstanceOf(ConfigurationError);
    if (!(observed instanceof ConfigurationError))
      throw new Error("Physical Git failure lost its primary classification");
    expect(observed.cause).toBe(failure);
    expect(observed.secondaryFailures).toHaveLength(1);
    expect(observed.secondaryFailures[0]).toBeInstanceOf(
      AnalysisCancelledError,
    );
    expect(observed.secondaryFailures[0]?.cause).toBe(opaque);
    expect(failure.cancellation?.reason).toBe(opaque);
  },
);

it("retains primary cancellation and its opaque caller reason", async () => {
  const opaque = { operator: "cancel", detail: new Error("opaque reason") };
  vi.mocked(owned.runOwnedCommand).mockRejectedValue(
    new owned.OwnedCommandFailure(
      "cancelled",
      "Git observation cancelled",
      null,
      null,
      {
        cancellation: { reason: opaque },
      },
    ),
  );
  const observed: unknown = await resolveKiloRegistrationWorktree(
    await context(),
  ).catch((cause: unknown) => cause);
  expect(observed).toBeInstanceOf(AnalysisCancelledError);
  if (!(observed instanceof AnalysisCancelledError))
    throw new Error("Primary cancellation lost its classification");
  expect(observed.cause).toBe(opaque);
});

it("retains the exact incomplete UTF-8 snapshot behind the Git observation failure", async () => {
  const snapshot: ProviderProcessSnapshot = {
    stdout: { text: "\uFFFD", invalidUtf8: true, bytes: 1, observedBytes: 1 },
    stderr: { text: "native diagnostic", bytes: 17, observedBytes: 17 },
    exitCode: 0,
    signal: null,
  };
  vi.mocked(owned.runOwnedCommand).mockResolvedValue(snapshot);
  const observed: unknown = await resolveKiloRegistrationWorktree(
    await context(),
  ).catch((cause: unknown) => cause);
  expect(observed).toBeInstanceOf(ConfigurationError);
  if (!(observed instanceof ConfigurationError))
    throw new Error(
      "Incomplete Git observation lost its configuration failure",
    );
  expect(observed.cause).toBeInstanceOf(Error);
  if (!(observed.cause instanceof Error))
    throw new Error("Incomplete Git observation lost its immediate failure");
  expect(observed.cause.cause).toBe(snapshot);
});

it("preserves an incomplete Git observation and a late cancellation through selection", async () => {
  const controller = new AbortController();
  const reason = { operator: "cancel incomplete observation" };
  const snapshot: ProviderProcessSnapshot = {
    stdout: { text: "\uFFFD", invalidUtf8: true, bytes: 1, observedBytes: 1 },
    stderr: { text: "native diagnostic", bytes: 17, observedBytes: 17 },
    exitCode: 0,
    signal: null,
  };
  vi.mocked(owned.runOwnedCommand).mockImplementation(async () => {
    controller.abort(reason);
    return snapshot;
  });
  const selected = await context(controller.signal);
  const result = await resolveMcpRegistrationClients(
    {
      agents: ["kilo-code"],
      global: false,
      cwd: selected.cwd,
      home: selected.home,
      platform: selected.platform,
      environment: selected.environment,
      signal: controller.signal,
    },
    resources,
  );
  if (result.ok) throw new Error("Incomplete observation must fail");
  expect(result.error).toBeInstanceOf(ConfigurationError);
  expect(result.error.cause).toBeInstanceOf(Error);
  expect((result.error.cause as Error).cause).toBe(snapshot);
  expect(result.error.secondaryFailures).toEqual([
    expect.objectContaining({ _tag: "AnalysisCancelledError", cause: reason }),
  ]);
});

it("preserves a native location access failure and late cancellation through selection", async () => {
  const controller = new AbortController();
  const reason = { operator: "cancel location discovery" };
  const physical = new Error("client path could not be inspected");
  const failure = new ConfigurationError("Selected path unavailable", {
    cause: physical,
  });
  const present = vi
    .spyOn(locations, "present")
    .mockImplementationOnce(async () => {
      controller.abort(reason);
      throw failure;
    });
  try {
    const selected = await context(controller.signal);
    const result = await resolveMcpRegistrationClients(
      {
        agents: ["kilo-code"],
        global: true,
        cwd: selected.cwd,
        home: selected.home,
        platform: selected.platform,
        environment: selected.environment,
        signal: controller.signal,
      },
      resources,
    );
    if (result.ok) throw new Error("Location access failure was lost");
    expect(result.error).toBe(failure);
    expect(result.error.cause).toBe(physical);
    expect(result.error.secondaryFailures).toEqual([
      expect.objectContaining({
        _tag: "AnalysisCancelledError",
        cause: reason,
      }),
    ]);
  } finally {
    present.mockRestore();
  }
});

it.each(["descriptor", "batch"] as const)(
  "retains actual %s inspection cleanup through Git discovery and retry",
  async (kind) => {
    const descriptor = await failedInspectionDescriptor();
    const reason = { operator: "cancel during Git preparation" };
    const controller = new AbortController();
    const failure =
      kind === "descriptor"
        ? descriptor.failure
        : new ProcessOwnershipIdentityBatchFailure(
            [
              { pid: process.pid, requestIndex: 0, cause: descriptor.failure },
              {
                pid: process.pid,
                requestIndex: 1,
                cause: new ProcessOwnershipInspectionCancelled(reason),
              },
            ],
            new Map(),
          );
    vi.mocked(owned.prepareOwnedCommand).mockImplementation(async () => {
      controller.abort(reason);
      throw failure;
    });
    const observed: unknown = await resolveKiloRegistrationWorktree(
      await context(controller.signal),
    ).catch((cause: unknown) => cause);
    expect(observed).toBeInstanceOf(ConfigurationError);
    if (!(observed instanceof ConfigurationError))
      throw new Error("Physical inspection failure lost configuration context");
    expect(observed.cause).toBe(failure);
    expect(observed.cleanupIncomplete).toBe(true);
    expect(observed.cleanupResources).toContain(descriptor.path);
    expect(observed.secondaryFailures).toEqual([
      expect.objectContaining({
        _tag: "AnalysisCancelledError",
        cause: reason,
      }),
    ]);
    expect(resources.hasPending).toBe(true);
    await expect(resources.close()).rejects.toBeDefined();
    expect(observed.cleanupIncomplete).toBe(true);
    expect(descriptor.handle.fd).toBeGreaterThanOrEqual(0);
    descriptor.allow();
    await resources.close();
    expect(descriptor.handle.fd).toBe(-1);
    expect(resources.hasPending).toBe(false);
    expect(observed.cleanupIncomplete).toBe(false);
  },
);

it("keeps plain producer-owned inspection cancellation primary during Git preparation", async () => {
  const reason = { operator: "cancel Git inspection" };
  vi.mocked(owned.prepareOwnedCommand).mockRejectedValue(
    new ProcessOwnershipInspectionCancelled(reason),
  );
  const observed: unknown = await resolveKiloRegistrationWorktree(
    await context(),
  ).catch((cause: unknown) => cause);
  expect(observed).toBeInstanceOf(AnalysisCancelledError);
  if (!(observed instanceof AnalysisCancelledError))
    throw new Error("Inspection cancellation lost its producer origin");
  expect(observed.cause).toBe(reason);
  expect(resources.hasPending).toBe(false);
});
