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
} from "./ProcessInspectionCleanup.js";
import { ProcessOwnershipInspectionCancelled } from "./ProcessInspectionCancellation.js";

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
