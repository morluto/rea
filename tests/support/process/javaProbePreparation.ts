import { expect, vi } from "vitest";

import {
  primaryAnalysisError,
  type AnalysisError,
} from "../../../src/domain/analysisErrorBase.js";
import type { RetainedResourceScope } from "../../../src/ports/AnalysisProvider.js";
import type { OwnedProviderProcessSpawnOptions } from "../../../src/process/ProviderProcess.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  ProcessOwnershipInspectionCancelled,
} from "../../../src/process/ProcessInspectionCancellation.js";
import {
  prepareProcessOwnershipInspection,
  systemProcessOwnershipHost,
} from "../../../src/process/ProcessOwnershipObservation.js";
import { ArtifactResourceRetryFailure } from "../../../src/resources/ArtifactResourceScope.js";
import { createInspectionResources } from "../../fixtures/inspectionResources.js";
import { failedInspectionDescriptor } from "../../fixtures/processInspectionCleanup.js";

export const expectJavaProbePreparationCleanup = async (
  batch: boolean,
  probe: (options: {
    resourceOwner: RetainedResourceScope;
    launcher: (input: OwnedProviderProcessSpawnOptions) => Promise<never>;
  }) => Promise<AnalysisError>,
): Promise<void> => {
  const descriptor = await failedInspectionDescriptor();
  const resources = createInspectionResources();
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
    : descriptor.failure;
  const prepare = vi
    .spyOn(systemProcessOwnershipHost, "prepare")
    .mockRejectedValue(cause);
  // macOS prepares before launcher admission; other hosts prepare inside it.
  // Keep that real admission step while recording that Java never starts.
  const startJava = vi.fn(() => {
    throw new Error("Java must not start");
  });
  const launcher = async (input: OwnedProviderProcessSpawnOptions) => {
    await prepareProcessOwnershipInspection(input.signal);
    return startJava();
  };
  try {
    const failure = await probe({ resourceOwner: resources.owner, launcher });
    const primary = primaryAnalysisError(failure);
    expect(primary).toMatchObject({
      _tag: "ProviderAdapterError",
      diagnostics: { stage: "ownership_preparation" },
    });
    expect(primary.cause).toBe(cause);
    if (batch)
      expect(primary.secondaryFailures).toContainEqual(
        expect.objectContaining({
          _tag: "AnalysisCancelledError",
          cause: reason,
        }),
      );
    expect(primary.capturedOutput).toBeUndefined();
    expect(primary.diagnostics).not.toHaveProperty("compiler_outcome");
    expect(startJava).not.toHaveBeenCalled();
    expect(failure.cleanupResources).toEqual([descriptor.failure.path]);
    await expect(resources.close()).rejects.toBeInstanceOf(
      ArtifactResourceRetryFailure,
    );
    expect(failure.cleanupIncomplete).toBe(true);
    descriptor.allow();
    await resources.close();
    expect(failure.cleanupIncomplete).toBe(false);
    expect(descriptor.failure.owner.handle.fd).toBe(-1);
  } finally {
    prepare.mockRestore();
    descriptor.allow();
    await resources.close();
    await descriptor.failure.owner.close();
  }
};
