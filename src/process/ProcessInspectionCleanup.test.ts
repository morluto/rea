import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { DarwinProcessOwnershipInspectionError } from "./DarwinProcessRunTokenReader.js";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { primaryAnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  OwnedRegularFileOperationFailure,
  RegularFileCleanupFailure,
  withOwnedFileHandle,
} from "../filesystem/OwnedRegularFile.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import {
  processInspectionCancellationError,
  retainProcessInspectionCleanup,
} from "../providers/OwnedCommandCleanup.js";
import { failedInspectionDescriptor } from "../../tests/fixtures/processInspectionCleanup.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  processInspectionCancellations,
  processInspectionCleanupFailures,
  rethrowProcessInspectionFailure,
} from "./ProcessInspectionCleanup.js";
import {
  ProcessOwnershipInspectionCancelled,
  ProcessOwnershipIdentityBatchFailure,
} from "./ProcessInspectionCancellation.js";

it.each([
  "literal cancellation",
  "opaque cancellation",
  "physical read",
] as const)(
  "keeps direct inspection failure facts and the exact descriptor owner: %s",
  async (kind) => {
    const foreign = await failedInspectionDescriptor();
    const reason = kind === "literal cancellation" ? false : foreign.failure;
    const root = await createTestTempDirectory("rea-direct-inspection-");
    const path = join(root, "identity");
    await writeFile(path, "inert identity");
    const handle = await open(
      path,
      kind === "physical read" ? constants.O_WRONLY : constants.O_RDONLY,
    );
    const owner = new OwnedFileHandle(handle);
    const controller = new AbortController();
    const close = handle.close.bind(handle);
    let allowClose = false;
    vi.spyOn(handle, "close").mockImplementation(async () => {
      if (!allowClose)
        throw new Error("controlled direct descriptor close failure");
      await close();
    });
    const resources = new ArtifactResourceScope();
    let observedReadFailure: unknown;
    try {
      const failure: unknown = await withOwnedFileHandle(
        path,
        owner,
        { signal: controller.signal },
        async (descriptor) => {
          if (kind !== "physical read") controller.abort(reason);
          try {
            for await (const chunk of readFileHandleChunks(descriptor, {
              signal: controller.signal,
              cancellationFailure: (value) =>
                new ProcessOwnershipInspectionCancelled(value),
            }))
              void chunk;
          } catch (cause: unknown) {
            observedReadFailure = cause;
            if (kind === "physical read") {
              controller.abort(new ProcessOwnershipInspectionCancelled(reason));
              throw new OwnedRegularFileOperationFailure(cause);
            }
            throw cause;
          }
        },
      ).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(RegularFileCleanupFailure);
      if (!(failure instanceof RegularFileCleanupFailure)) throw failure;
      expect(failure.owner).toBe(owner);
      expect(failure.outcome).toEqual({
        kind: "failed",
        cause: observedReadFailure,
      });
      if (kind === "physical read")
        expect(observedReadFailure).toMatchObject({ code: "EBADF" });
      else
        expect(observedReadFailure).toBeInstanceOf(
          ProcessOwnershipInspectionCancelled,
        );
      const expectedReasons = kind === "physical read" ? [] : [reason];
      expect(processInspectionCleanupFailures(failure)).toEqual([failure]);
      expect(
        processInspectionCancellationError(failure, "inspect"),
      ).toBeUndefined();
      const primary = new AnalysisOutputError(
        "inspect",
        "direct descriptor cleanup failed",
        { cause: failure },
      );
      const projected = retainProcessInspectionCleanup(
        failure,
        primary,
        resources,
        "inspect",
      );
      expect(primaryAnalysisError(projected)).toBe(primary);
      expect(primary.cause).toBe(failure);
      expect(primary.secondaryFailures.map((fact) => fact.cause)).toEqual(
        expectedReasons,
      );
      expect(
        processInspectionCancellations(failure).map((fact) => fact.reason),
      ).toEqual(expectedReasons);
      if (expectedReasons.length > 0)
        expect(primary.secondaryFailures[0]?.cause).toBe(reason);
      expect(resources.cleanupResources).toEqual([path]);
      expect(handle.fd).toBeGreaterThanOrEqual(0);
      await expect(resources.close()).rejects.toBeDefined();
      expect(projected.cleanupIncomplete).toBe(true);
      allowClose = true;
      await resources.close();
      expect(handle.fd).toBe(-1);
      expect(projected.cleanupIncomplete).toBe(false);
      expect(foreign.handle.fd).toBeGreaterThanOrEqual(0);
      expect(
        processInspectionCancellations(
          new Error("opaque cause", { cause: observedReadFailure }),
        ),
      ).toEqual([]);
    } finally {
      allowClose = true;
      await resources.close();
      await owner.close();
    }
  },
);

it.each([
  "descriptor",
  "mixed batch",
  "cancelled",
  "retained Darwin",
  "Darwin cancellation",
] as const)(
  "rethrows the actual known %s inspection fact before mandatory fallback",
  async (kind) => {
    const descriptor = await failedInspectionDescriptor();
    const reason = { caller: "mandatory inspection stopped" };
    const observations = new Map([
      [200, { state: "unavailable" as const, reason: "not fully observed" }],
    ]);
    const failure =
      kind === "descriptor"
        ? descriptor.failure
        : kind === "mixed batch"
          ? new ProcessOwnershipIdentityBatchFailure(
              [
                { pid: 100, requestIndex: 0, cause: descriptor.failure },
                {
                  pid: 200,
                  requestIndex: 1,
                  cause: new ProcessOwnershipInspectionCancelled(reason),
                },
              ],
              observations,
            )
          : kind === "cancelled"
            ? new ProcessOwnershipInspectionCancelled(descriptor.failure)
            : kind === "retained Darwin"
              ? new DarwinProcessOwnershipInspectionError(
                  "recorded helper close failed",
                  {
                    cleanupOwner: descriptor.failure.owner,
                    cleanupFailure: new ProviderCleanupError(
                      "fixture",
                      [descriptor.path],
                      { reason: "descriptor close remains denied" },
                    ),
                  },
                )
              : new DarwinProcessOwnershipInspectionError(
                  "recorded helper cancelled",
                  { cancellation: { reason } },
                );
    let observed: unknown;
    try {
      rethrowProcessInspectionFailure(failure);
    } catch (cause: unknown) {
      observed = cause;
    }
    expect(observed).toBe(failure);
    if (failure instanceof ProcessOwnershipIdentityBatchFailure) {
      expect(failure.observations).toBe(observations);
      expect(failure.origin).toBe("physical");
      expect(failure.physicalFailures[0]?.cause).toBe(descriptor.failure);
      expect(failure.cancellations[0]?.cancellation.reason).toBe(reason);
    }
    expect(descriptor.handle.fd).toBeGreaterThanOrEqual(0);
    expect(
      rethrowProcessInspectionFailure(
        new Error("opaque wrapper", { cause: failure }),
      ),
    ).toBeUndefined();
    descriptor.allow();
    await descriptor.failure.owner.close();
    expect(descriptor.handle.fd).toBe(-1);
  },
);
