import { validateJadxConfiguration } from "./JadxConfiguration.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { ArtifactResourceRetryFailure } from "../artifacts/ArtifactResourceScope.js";
import { expect, it, vi } from "vitest";
import { inspectJadxJava, type JadxJavaProbeOptions } from "./JadxJavaProbe.js";
import {
  AnalysisError,
  primaryAnalysisError,
} from "../domain/analysisErrorBase.js";
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
  "retains physical preparation instead of reporting a Java refusal (batch: %s)",
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
    try {
      const result: unknown = await inspectJadxJava(
        "/selected/java",
        {},
        { resourceOwner: resources.owner, launcher },
      ).catch((cause: unknown) => cause);
      expect(result).toBeInstanceOf(AnalysisError);
      if (!(result instanceof AnalysisError)) throw result;
      const primary = primaryAnalysisError(result);
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
      expect(result.cleanupResources).toEqual([descriptor.failure.path]);
      await expect(resources.close()).rejects.toBeInstanceOf(
        ArtifactResourceRetryFailure,
      );
      expect(result.cleanupIncomplete).toBe(true);
      descriptor.allow();
      await resources.close();
      expect(result.cleanupIncomplete).toBe(false);
      expect(descriptor.failure.owner.handle.fd).toBe(-1);
    } finally {
      prepare.mockRestore();
      descriptor.allow();
      await resources.close();
      await descriptor.failure.owner.close();
    }
  },
);

it("preserves the actual inspection cancellation record and opaque caller reason", async () => {
  const resources = createInspectionResources();
  const reason = new ProviderCleanupError("foreign", ["/foreign/resource"], {});
  const inspection = new ProcessOwnershipInspectionCancelled(reason);
  const prepare = vi
    .spyOn(systemProcessOwnershipHost, "prepare")
    .mockRejectedValue(inspection);
  const startJava = vi.fn(() => {
    throw new Error("Java must not start");
  });
  const launcher = async (input: OwnedProviderProcessSpawnOptions) => {
    await prepareProcessOwnershipInspection(input.signal);
    return startJava();
  };
  try {
    const result: unknown = await inspectJadxJava(
      "/selected/java",
      {},
      { resourceOwner: resources.owner, launcher },
    ).catch((cause: unknown) => cause);
    expect(result).toMatchObject({ _tag: "AnalysisCancelledError" });
    if (!(result instanceof AnalysisError)) throw result;
    expect(result.cause).toBe(reason);
    expect(Reflect.get(result, "inspectionFailure")).toBe(inspection);
    expect(result.cleanupResources).toEqual([]);
    expect(result.secondaryFailures).toEqual([]);
    expect(reason.cleanupIncomplete).toBe(true);
    expect(startJava).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    await resources.close();
  }
});

it.each(["probe", "configuration"] as const)(
  "keeps owned deadline policy and exact inspection facts through %s",
  async (boundary) => {
    const resources = createInspectionResources();
    const prepare = vi
      .spyOn(systemProcessOwnershipHost, "prepare")
      .mockResolvedValue(undefined);
    const caller = new AbortController();
    let stopped: ProcessOwnershipInspectionCancelled | undefined;
    const options: JadxJavaProbeOptions = {
      resourceOwner: resources.owner,
      signal: caller.signal,
      timeoutMs: 20,
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
    };
    try {
      const result: unknown = await (
        boundary === "probe"
          ? inspectJadxJava("/selected/java", {}, options)
          : validateJadxConfiguration(
              {
                jar: "/unused/engine.jar",
                java: "/selected/java",
                jvmArguments: [],
              },
              {},
              "inspect_android_package",
              options,
            )
      ).catch((cause: unknown) => cause);
      expect(stopped).toBeInstanceOf(ProcessOwnershipInspectionCancelled);
      if (boundary === "probe") {
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "version_unresolved",
            kind: "java_probe",
            diagnostics: { failure: "probe_terminated", deadline_ms: 20 },
            inspectionFailure: stopped,
          },
        });
        if (
          typeof result !== "object" ||
          result === null ||
          !("error" in result)
        )
          throw new Error("Expected runtime refusal");
        const refusal = result.error;
        if (typeof refusal !== "object" || refusal === null)
          throw new Error("Expected refusal facts");
        expect(Reflect.get(refusal, "inspectionFailure")).toBe(stopped);
        expect(Object.keys(refusal)).not.toContain("inspectionFailure");
        expect(refusal).not.toHaveProperty("cancellation");
      } else {
        expect(result).toMatchObject({
          _tag: "AnalysisCapabilityUnavailableError",
          diagnostics: { failure_code: "version_unresolved" },
        });
        if (
          !(result instanceof AnalysisError) ||
          !(result.cause instanceof Error)
        )
          throw new Error("Expected projected configuration refusal");
        expect(result.cause.cause).toBe(stopped);
        expect(result.secondaryFailures).toEqual([]);
      }
      expect(caller.signal.aborted).toBe(false);
    } finally {
      prepare.mockRestore();
      await resources.close();
    }
  },
);
