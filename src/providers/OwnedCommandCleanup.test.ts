import { systemProcessOwnershipHost } from "../process/ProcessOwnershipObservation.js";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import {
  processInspectionCancellationError,
  retainOwnedCommandCleanup,
  retainProcessInspectionCleanup,
} from "./OwnedCommandCleanup.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { primaryAnalysisError } from "../domain/analysisErrorBase.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import {
  OwnedCommandFailure,
  prepareOwnedCommand,
} from "../process/OwnedCommand.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  ProcessOwnershipInspectionCancelled,
} from "../process/ProcessInspectionCancellation.js";
import { RetainedCommandCleanup } from "../process/RetainedCommandCleanup.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { failedInspectionDescriptor } from "../../tests/fixtures/processInspectionCleanup.js";

it.each([false, true])(
  "retains the exact descriptor preparation owner (command wrapper: %s)",
  async (wrapped) => {
    const file = await failedInspectionDescriptor();
    const retained: {
      close(): Promise<void>;
      readonly cleanupResources?: readonly string[] | undefined;
    }[] = [];
    const cause = wrapped
      ? new OwnedCommandFailure("process", "inspection failed", null, null, {
          preparationFailure: file.failure,
        })
      : file.failure;
    const errors = retainOwnedCommandCleanup(
      cause,
      { retain: (owner) => retained.push(owner), run: (work) => work() },
      "fixture",
      "inspect",
    );
    expect(errors).toHaveLength(1);
    expect(retained).toHaveLength(1);
    expect(errors[0]?.cleanupIncomplete).toBe(true);
    expect(errors[0]?.cleanupResources).toEqual([file.path]);
    await expect(retained[0]!.close()).rejects.toBeDefined();
    expect(file.handle.fd).toBeGreaterThanOrEqual(0);
    file.allow();
    await retained[0]!.close();
    expect(file.handle.fd).toBe(-1);
    expect(errors[0]?.cleanupIncomplete).toBe(false);
  },
);

it("drains every exact mixed-batch owner and keeps partial observations and physical primary", async () => {
  const first = await failedInspectionDescriptor();
  const second = await failedInspectionDescriptor();
  const reason = { caller: "stop identity inspection" };
  const observations = new Map([
    [42, { state: "unavailable" as const, reason: "identity unknown" }],
  ]);
  const batch = new ProcessOwnershipIdentityBatchFailure(
    [
      { pid: 41, requestIndex: 0, cause: first.failure },
      { pid: 41, requestIndex: 1, cause: second.failure },
      {
        pid: 42,
        requestIndex: 2,
        cause: new ProcessOwnershipInspectionCancelled(reason),
      },
    ],
    observations,
    [{ pid: 41, requestIndex: 0, cause: first.failure }],
  );
  const resources = new ArtifactResourceScope();
  onTestFinished(async () => {
    first.allow();
    second.allow();
    await resources.close();
  });
  const primary = new AnalysisOutputError(
    "inspect",
    "mixed identity batch failed",
    { cause: batch },
  );
  const error = retainProcessInspectionCleanup(
    batch,
    primary,
    resources,
    "inspect",
  );
  expect(primaryAnalysisError(error)).toBe(primary);
  expect(primary.cause).toBe(batch);
  expect(batch.observations).toBe(observations);
  expect(batch.origin).toBe("physical");
  expect(error.cleanupIncomplete).toBe(true);
  expect(resources.cleanupResources).toEqual([first.path, second.path]);
  first.allow();
  await expect(resources.close()).rejects.toBeDefined();
  expect(first.handle.fd).toBe(-1);
  expect(second.handle.fd).toBeGreaterThanOrEqual(0);
  expect(resources.cleanupResources).toEqual([second.path]);
  expect(error.cleanupResources).toEqual([second.path]);
  const firstCloses = first.closes();
  second.allow();
  await resources.close();
  expect(first.closes()).toBe(firstCloses);
  expect(second.handle.fd).toBe(-1);
  expect(error.cleanupIncomplete).toBe(false);
});

it.each(["descriptor", "batch", "darwin", "command"] as const)(
  "retains a scratch folder until its %s inspection owner confirms close",
  async (kind) => {
    const root = await createTestTempDirectory("rea-inspection-scratch-");
    const folder = join(root, "scratch");
    await mkdir(folder);
    const file = await failedInspectionDescriptor(folder);
    const failure =
      kind === "descriptor"
        ? file.failure
        : kind === "command"
          ? new OwnedCommandFailure(
              "process",
              "inspection failed",
              null,
              null,
              { preparationFailure: file.failure },
            )
          : kind === "batch"
            ? new ProcessOwnershipIdentityBatchFailure(
                [{ pid: 42, requestIndex: 0, cause: file.failure }],
                new Map(),
              )
            : new DarwinProcessOwnershipInspectionError(
                "helper cleanup failed",
                {
                  cleanupOwner: file.failure.owner,
                  cleanupFailure: new ProviderCleanupError(
                    "fixture",
                    [file.path],
                    {},
                  ),
                },
              );
    const owner = new RetainedCommandCleanup(folder, failure);
    expect(owner.hasPendingCommandResources).toBe(true);
    await expect(owner.close()).rejects.toBeDefined();
    await expect(access(folder)).resolves.toBeUndefined();
    expect(file.handle.fd).toBeGreaterThanOrEqual(0);
    file.allow();
    await owner.close();
    expect(file.handle.fd).toBe(-1);
    await expect(access(folder)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("does not acquire foreign owners from opaque cancellation reasons or generic causes", async () => {
  const foreign = await failedInspectionDescriptor();
  const cancellation = new ProcessOwnershipInspectionCancelled(
    foreign.failure,
    { cause: foreign.failure },
  );
  const allCancelled = new ProcessOwnershipIdentityBatchFailure(
    [{ pid: 42, requestIndex: 0, cause: cancellation }],
    new Map(),
  );
  expect(allCancelled.origin).toBe("cancelled");
  for (const cause of [
    cancellation,
    allCancelled,
    new Error("opaque failure", { cause: foreign.failure }),
    new OwnedCommandFailure("cancelled", "caller stopped", null, null, {
      cancellation: { reason: foreign.failure },
      cause: foreign.failure,
    }),
  ]) {
    const retained: unknown[] = [];
    expect(
      retainOwnedCommandCleanup(
        cause,
        { retain: (owner) => retained.push(owner), run: (work) => work() },
        "fixture",
        "inspect",
      ),
    ).toEqual([]);
    expect(retained).toEqual([]);
    expect(foreign.handle.fd).toBeGreaterThanOrEqual(0);
  }
});

it.each([undefined, NaN, false])(
  "keeps the all-cancel batch and exact caller reason %s",
  (reason) => {
    const batch = new ProcessOwnershipIdentityBatchFailure(
      [
        {
          pid: 42,
          requestIndex: 0,
          cause: new ProcessOwnershipInspectionCancelled(reason),
        },
      ],
      new Map([[43, { state: "unavailable", reason: "unknown" }]]),
    );
    const error = processInspectionCancellationError(batch, "inspect");
    expect(error?.inspectionFailure).toBe(batch);
    expect(error?.cause).toBe(reason);
    expect(error?.diagnostics).toEqual({
      retained_observation_count: 1,
      rejected_request_count: 1,
    });
    expect(
      processInspectionCancellationError(
        new Error("opaque", { cause: batch }),
        "inspect",
      ),
    ).toBeUndefined();
  },
);

it("retains only explicit mixed cancellations once without an ambient abort", async () => {
  const file = await failedInspectionDescriptor();
  const batch = new ProcessOwnershipIdentityBatchFailure(
    [
      { pid: 42, requestIndex: 0, cause: file.failure },
      {
        pid: 43,
        requestIndex: 1,
        cause: new ProcessOwnershipInspectionCancelled(undefined),
      },
      {
        pid: 44,
        requestIndex: 2,
        cause: new ProcessOwnershipInspectionCancelled(undefined),
      },
      {
        pid: 45,
        requestIndex: 3,
        cause: new ProcessOwnershipInspectionCancelled(NaN),
      },
      {
        pid: 46,
        requestIndex: 4,
        cause: new ProcessOwnershipInspectionCancelled(NaN),
      },
    ],
    new Map(),
  );
  expect(processInspectionCancellationError(batch, "inspect")).toBeUndefined();
  const primary = new AnalysisOutputError("inspect", "physical", {
    cause: batch,
  });
  const resources = new ArtifactResourceScope();
  const projected = retainProcessInspectionCleanup(
    batch,
    primary,
    resources,
    "inspect",
  );
  expect(primaryAnalysisError(projected)).toBe(primary);
  expect(primary.secondaryFailures.map((failure) => failure.cause)).toEqual([
    undefined,
    NaN,
  ]);
  expect(
    primary.secondaryFailures.every(
      (failure) =>
        "inspectionFailure" in failure && failure.inspectionFailure === batch,
    ),
  ).toBe(true);
  expect(projected.cleanupResources).toEqual([file.path]);
  expect(projected.cleanupIncomplete).toBe(true);
  file.allow();
  await resources.close();
  expect(projected.cleanupIncomplete).toBe(false);
  expect(file.handle.fd).toBe(-1);
});

it("preserves Darwin cancellation output and does not invent cleanup authority", () => {
  const cleanup = new ProviderCleanupError("fixture", ["exact helper"], {
    reason: "failed close",
  });
  const cause = new DarwinProcessOwnershipInspectionError("cancelled helper", {
    cancellation: { reason: false },
    cleanupFailure: cleanup,
    capturedOutput: {
      stdout: "partial",
      stderr: "",
      truncated: false,
    },
  });
  const error = processInspectionCancellationError(cause, "inspect");
  expect(error?.inspectionFailure).toBe(cause);
  expect(error?.cause).toBe(false);
  expect(error?.capturedOutput).toEqual(cause.capturedOutput);
  const retained: unknown[] = [];
  expect(
    retainOwnedCommandCleanup(
      cause,
      { retain: (owner) => retained.push(owner), run: (work) => work() },
      "fixture",
      "inspect",
    ),
  ).toEqual([cleanup]);
  expect(retained).toEqual([]);
  expect(cleanup.cleanupIncomplete).toBe(true);
});

it("keeps executed-command cancellation outside the inspection factory and binder", () => {
  const command = new OwnedCommandFailure(
    "cancelled",
    "execution stopped",
    null,
    null,
    {
      cancellation: { reason: false },
      cause: new ProcessOwnershipInspectionCancelled(false),
    },
  );
  expect(
    processInspectionCancellationError(command, "inspect"),
  ).toBeUndefined();
  const primary = new AnalysisOutputError("inspect", "physical execution");
  const error = retainProcessInspectionCleanup(
    command,
    primary,
    new ArtifactResourceScope(),
    "inspect",
  );
  expect(error).toBe(primary);
  expect(primary.secondaryFailures).toEqual([]);
});

it("preserves the actual plain preparation fact through the command and adapter owners", async () => {
  const platform = Object.getOwnPropertyDescriptor(
    systemProcessOwnershipHost,
    "platform",
  )!;
  Object.defineProperty(systemProcessOwnershipHost, "platform", {
    value: "darwin",
    configurable: true,
  });
  const fact = new ProcessOwnershipInspectionCancelled(false);
  const prepare = vi
    .spyOn(systemProcessOwnershipHost, "prepare")
    .mockRejectedValue(fact);
  onTestFinished(() => {
    prepare.mockRestore();
    Object.defineProperty(systemProcessOwnershipHost, "platform", platform);
  });
  const command: unknown = await prepareOwnedCommand().catch(
    (failure: unknown) => failure,
  );
  expect(command).toBeInstanceOf(OwnedCommandFailure);
  if (!(command instanceof OwnedCommandFailure)) throw command;
  expect(command.preparationFailure).toBe(fact);
  const error = processInspectionCancellationError(command, "inspect");
  expect(error?.inspectionFailure).toBe(fact);
  expect(error?.cause).toBe(false);
});
