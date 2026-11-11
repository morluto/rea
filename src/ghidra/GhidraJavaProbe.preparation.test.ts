import { expect, it, vi } from "vitest";
import { probeGhidraJava } from "./GhidraJavaProbe.js";
import {
  AnalysisError,
  primaryAnalysisError,
} from "../domain/analysisErrorBase.js";
import { ArtifactResourceRetryFailure } from "../artifacts/ArtifactResourceScope.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  ProcessOwnershipInspectionCancelled,
} from "../process/ProcessInspectionCancellation.js";
import {
  prepareProcessOwnershipInspection,
  systemProcessOwnershipHost,
} from "../process/ProcessOwnershipObservation.js";
import type { OwnedProviderProcessSpawnOptions } from "../process/ProviderProcess.js";
import { failedInspectionDescriptor } from "../../tests/fixtures/processInspectionCleanup.js";
import { createInspectionResources } from "../../tests/fixtures/inspectionResources.js";

it.each([false, true])(
  "retains physical preparation ownership before Java launch (batch: %s)",
  async (batch) => {
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
    let failure: AnalysisError | undefined;
    try {
      const result = await probeGhidraJava(
        "/selected/java",
        {},
        { resourceOwner: resources.owner, launcher },
      );
      if (result.ok || !(result.error instanceof AnalysisError))
        throw new Error("Expected typed preparation failure");
      failure = result.error;
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
  },
);

it("keeps the owned command deadline primary when launcher inspection is stopped", async () => {
  const resources = createInspectionResources();
  const prepare = vi
    .spyOn(systemProcessOwnershipHost, "prepare")
    .mockResolvedValue(undefined);
  let stopped: ProcessOwnershipInspectionCancelled | undefined;
  const caller = new AbortController();
  try {
    const result = await probeGhidraJava(
      "/selected/java",
      {},
      {
        resourceOwner: resources.owner,
        timeoutMs: 20,
        signal: caller.signal,
        launcher: async (input) => {
          const signal = input.signal;
          if (signal === undefined)
            throw new Error("Expected owned deadline signal");
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else
              signal.addEventListener("abort", () => resolve(), { once: true });
          });
          stopped = new ProcessOwnershipInspectionCancelled(signal.reason);
          throw stopped;
        },
      },
    );
    expect(stopped).toBeInstanceOf(ProcessOwnershipInspectionCancelled);
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "GhidraJavaProbeFailure",
        code: "runtime_unavailable",
        processErrorCode: "ETIMEDOUT",
      },
    });
    if (result.ok || result.error instanceof AnalysisError)
      throw new Error("Expected unchanged runtime refusal");
    expect(result.error.inspectionFailure).toBe(stopped);
    expect(result.error.cancellation).toBeUndefined();
    expect(Object.keys(result.error)).not.toContain("inspectionFailure");
    expect(caller.signal.aborted).toBe(false);
  } finally {
    prepare.mockRestore();
    await resources.close();
  }
});
