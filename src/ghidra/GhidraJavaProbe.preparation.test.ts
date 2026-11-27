import { expect, it, vi } from "vitest";
import { probeGhidraJava } from "./GhidraJavaProbe.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { ProcessOwnershipInspectionCancelled } from "../process/ProcessInspectionCancellation.js";
import {
  prepareProcessOwnershipInspection,
  systemProcessOwnershipHost,
} from "../process/ProcessOwnershipObservation.js";
import { expectJavaProbePreparationCleanup } from "../../tests/support/process/javaProbePreparation.js";
import { createInspectionResources } from "../../tests/fixtures/inspectionResources.js";
import { spawnFailure } from "../../tests/support/process/spawnFailure.js";

it.each([false, true])(
  "retains physical preparation ownership before Java launch (batch: %s)",
  (batch) =>
    expectJavaProbePreparationCleanup(batch, async (options) => {
      const result = await probeGhidraJava("/selected/java", {}, options);
      if (result.ok || !(result.error instanceof AnalysisError))
        throw new Error("Expected typed preparation failure");
      return result.error;
    }),
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

it("reports EMFILE during macOS ownership helper preparation as a resource constraint", async () => {
  const resources = createInspectionResources();
  const emfile = spawnFailure("EMFILE", "/usr/bin/swiftc");
  const prepare = vi
    .spyOn(systemProcessOwnershipHost, "prepare")
    .mockRejectedValue(
      new DarwinProcessOwnershipInspectionError("helper capacity exhausted", {
        cause: emfile,
      }),
    );
  try {
    const result = await probeGhidraJava(
      "/selected/java",
      {},
      {
        resourceOwner: resources.owner,
        launcher: async (input) => {
          await prepareProcessOwnershipInspection(input.signal);
          throw new Error("Java must not start");
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected resource constraint failure");
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      retryable: true,
      diagnostics: {
        system_code: "EMFILE",
        java_executable: "/selected/java",
      },
    });
  } finally {
    prepare.mockRestore();
    await resources.close();
  }
});

it("keeps caller cancellation primary when macOS helper preparation is cancelled with a spawn EMFILE reason", async () => {
  const resources = createInspectionResources();
  const reason = spawnFailure("EMFILE", "/usr/bin/swiftc");
  const prepare = vi
    .spyOn(systemProcessOwnershipHost, "prepare")
    .mockRejectedValue(
      new DarwinProcessOwnershipInspectionError(
        "helper compilation cancelled",
        {
          cause: reason,
          cancellation: { reason },
        },
      ),
    );
  try {
    const result = await probeGhidraJava(
      "/selected/java",
      {},
      {
        resourceOwner: resources.owner,
        launcher: async (input) => {
          await prepareProcessOwnershipInspection(input.signal);
          throw new Error("Java must not start");
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected cancelled probe failure");
    expect(result.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      cause: reason,
    });
  } finally {
    prepare.mockRestore();
    await resources.close();
  }
});
