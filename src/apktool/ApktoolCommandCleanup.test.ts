import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import { ApktoolCommandCleanup } from "./ApktoolCommandCleanup.js";
import {
  AnalysisError,
  primaryAnalysisError,
} from "../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  ProcessOwnershipInspectionCancelled,
} from "../process/ProcessInspectionCancellation.js";
import { failedInspectionDescriptor } from "../../tests/fixtures/processInspectionCleanup.js";

it.each(["direct", "batch", "command"] as const)(
  "retains exact descriptor cleanup and its workspace association (boundary: %s)",
  async (boundary) => {
    const batch = boundary === "batch";
    const descriptor = await failedInspectionDescriptor();
    const commands = new ApktoolCommandCleanup();
    const root = dirname(descriptor.failure.path);
    const reason = { source: "inspection caller" };
    const cause = batch
      ? new ProcessOwnershipIdentityBatchFailure(
          [
            { pid: 41, requestIndex: 0, cause: descriptor.failure },
            {
              pid: 42,
              requestIndex: 1,
              cause: new ProcessOwnershipInspectionCancelled(reason),
            },
          ],
          new Map(),
        )
      : boundary === "command"
        ? new OwnedCommandFailure("process", "inspection failed", null, null, {
            preparationFailure: descriptor.failure,
          })
        : descriptor.failure;
    const primary = new ProviderAdapterError(
      "apktool",
      "decode_android_resources",
      { cause },
    );
    const failure = commands.retainFailure(
      cause,
      primary,
      "decode_android_resources",
      root,
    );
    try {
      expect(primaryAnalysisError(failure)).toBe(primary);
      expect(primary.cause).toBe(cause);
      if (batch)
        expect(primary.secondaryFailures).toContainEqual(
          expect.objectContaining({
            _tag: "AnalysisCancelledError",
            cause: reason,
          }),
        );
      expect(commands.pendingFor(root)).toBe(true);
      expect(commands.pendingFor(root + "other")).toBe(false);
      expect(failure.cleanupResources).toEqual([descriptor.failure.path]);
      await expect(commands.close()).rejects.toBeInstanceOf(AnalysisError);
      expect(failure.cleanupIncomplete).toBe(true);
      expect(commands.pendingFor(root)).toBe(true);
      descriptor.allow();
      await commands.close();
      expect(commands.pendingFor(root)).toBe(false);
      expect(failure.cleanupIncomplete).toBe(false);
      expect(descriptor.failure.owner.handle.fd).toBe(-1);
    } finally {
      descriptor.allow();
      await commands.close();
      await descriptor.failure.owner.close();
    }
  },
);
