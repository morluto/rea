import { expect, it } from "vitest";
import { failedInspectionDescriptor } from "../../../tests/fixtures/processInspectionCleanup.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { TestReverseEngineeringService } from "../../../tests/support/reverseEngineeringService.js";
import { primaryAnalysisError } from "../../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  ProcessOwnershipInspectionCancelled,
} from "../../process/ProcessInspectionCancellation.js";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

it.each([false, true])(
  "retains reverse inspection cleanup and physical failure (batch: %s)",
  async (batch) => {
    const file = await failedInspectionDescriptor();
    const reason = { selection: "recorded cancellation" };
    const preparation = batch
      ? new ProcessOwnershipIdentityBatchFailure(
          [
            { pid: 41, requestIndex: 0, cause: file.failure },
            {
              pid: 42,
              requestIndex: 1,
              cause: new ProcessOwnershipInspectionCancelled(reason),
            },
          ],
          new Map(),
        )
      : file.failure;
    const root = await createTestTempDirectory("rea-reverse-inspection-");
    const path = join(root, "artifact");
    await writeFile(path, "inert artifact");
    const service = new TestReverseEngineeringService({
      runOwned: async () => {
        throw preparation;
      },
    });
    const result = await service.executeRizinCommand({ path, command: "iI" });
    if (result.ok) throw new Error("Expected inspection failure");
    const primary = primaryAnalysisError(result.error);
    expect(primary).toBeInstanceOf(ProviderAdapterError);
    expect(primary.cause).toBe(preparation);
    expect(primary.secondaryFailures.map((failure) => failure.cause)).toEqual(
      batch ? [reason] : [],
    );
    expect(result.error.cleanupResources).toContain(file.path);
    await expect(service.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect(file.handle.fd).not.toBe(-1);
    file.allow();
    await service.close();
    expect(file.handle.fd).toBe(-1);
    expect(result.error.cleanupIncomplete).toBe(false);
  },
);

it("preserves reverse inspection cancellation without consulting ambient signal state", async () => {
  const reason = new Error("exact inspection caller value");
  const preparation = new ProcessOwnershipInspectionCancelled(reason);
  const root = await createTestTempDirectory(
    "rea-reverse-cancelled-inspection-",
  );
  const path = join(root, "artifact");
  await writeFile(path, "inert artifact");
  const service = new TestReverseEngineeringService({
    runOwned: async () => {
      throw new OwnedCommandFailure(
        "cancelled",
        "inspection cancelled",
        null,
        null,
        { preparationFailure: preparation, cancellation: { reason } },
      );
    },
  });
  const result = await service.executeRizinCommand({ path, command: "iI" });
  if (result.ok) throw new Error("Expected inspection cancellation");
  expect(primaryAnalysisError(result.error)._tag).toBe(
    "AnalysisCancelledError",
  );
  expect(primaryAnalysisError(result.error).cause).toBe(reason);
  await service.close();
});
