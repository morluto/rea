import {
  normalizeCaptureFailure,
  captureInspectionFailures,
  ProcessCaptureSamplingFailure,
} from "./ProcessCaptureError.js";
import { settleSamplingReads } from "./ProcessSamplingObservation.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { failedInspectionDescriptor } from "../../../tests/fixtures/processInspectionCleanup.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { primaryAnalysisError } from "../../domain/analysisErrorBase.js";
import { emptyProcessCapture } from "../../domain/process/processCapture.fixture.js";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import { ProcessCaptureResourceScope } from "./ProcessCaptureLifecycle.js";
import { captureProcessScenario } from "./ProcessHarness.js";

const control = vi.hoisted(() => ({
  physical: new Error("controlled terminal observation failure"),
  inspection: undefined as unknown,
}));
vi.mock("@lydell/node-pty", () => ({
  spawn: () => ({
    pid: 321,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => {
      throw control.physical;
    },
    write: () => undefined,
    resize: () => undefined,
    kill: () => {
      throw new Error("No cached PID signal authority");
    },
  }),
}));
vi.mock("../ProcessOwnershipObservation.js", async (original) => ({
  ...(await original<typeof import("../ProcessOwnershipObservation.js")>()),
  prepareProcessOwnershipInspection: async () => undefined,
  systemProcessOwnershipHost: {
    platform: "linux",
    captureBaseline: async () => [],
    listProcesses: async () => {
      throw new Error("Unexpected host inspection");
    },
    environment: async () => {
      throw new Error("Unexpected host inspection");
    },
    signalGroup: () => {
      throw new Error("Unexpected host signal");
    },
  },
}));
vi.mock("./ProcessSampling.js", () => ({
  startProcessSampler: (options: {
    resourceScope: ProcessCaptureResourceScope;
  }) => {
    for (const leaf of captureInspectionFailures(control.inspection))
      options.resourceScope.retainInspectionFailure(leaf);
    return async () => {
      throw control.inspection;
    };
  },
}));

it.each([false, true])(
  "finishes capture cleanup without replacing a physical failure (settled peers: %s)",
  async (peers) => {
    const file = await failedInspectionDescriptor();
    const second = peers ? await failedInspectionDescriptor() : undefined;
    control.inspection =
      second === undefined
        ? normalizeCaptureFailure(file.failure)
        : normalizeCaptureFailure(
            await settleSamplingReads([
              Promise.reject(file.failure),
              Promise.resolve("completed sampling sibling"),
              Promise.reject(second.failure),
            ]).catch((cause: unknown) => cause),
          );
    const root = await createTestTempDirectory("rea-capture-stop-failure-");
    const path = join(root, "selected");
    await writeFile(path, "inert selected executable bytes", { mode: 0o755 });
    const resources = new ProcessCaptureResourceScope();
    let observerRoot: string | undefined;
    onTestFinished(async () => {
      file.allow();
      second?.allow();
      await resources.close();
      if (observerRoot !== undefined)
        await rm(observerRoot, { recursive: true, force: true });
    });
    const query = vi.fn(async () => ({
      cleaned: true as const,
      signaled: false,
    }));
    const removed: string[] = [];
    const result = await captureProcessScenario(
      processScenarioSchema.parse({
        executable: path,
        working_directory: root,
        settle_ms: 0,
        normalization: { pids: false },
      }),
      undefined,
      "linux",
      {},
      async (_scenario, _signal, _before, observer) => {
        if (observer?.observerPaths?.length !== 1)
          throw new Error(
            "Expected this capture's exact allocated observer root",
          );
        observerRoot = observer.observerPaths[0];
        return {
          files: [],
          truncated: false,
          completeRoots: [],
          coverage: emptyProcessCapture().truncation_details.filesystem_before,
        };
      },
      {
        platform: "linux",
        cleanupProcessGroup: query,
        removeTemporaryRoot: async (path) => {
          await rm(path, { recursive: true, force: true });
          removed.push(path);
        },
      },
      undefined,
      resources,
    );
    if (result.ok) throw new Error("Expected controlled finalization failure");
    expect(primaryAnalysisError(result.error).cause).toBe(control.physical);
    expect(result.error.cleanupResources).toContain(file.path);
    expect(result.error.partialObservation).toMatchObject({
      observations: { target_pid: { state: "available", value: 321 } },
    });
    expect(query).not.toHaveBeenCalled();
    expect(removed).toEqual([]);
    expect(file.handle.fd).not.toBe(-1);
    file.allow();
    if (second !== undefined) {
      await expect(resources.close()).rejects.toMatchObject({
        cleanupIncomplete: true,
      });
      expect(file.handle.fd).toBe(-1);
      expect(second.handle.fd).not.toBe(-1);
      expect(query).not.toHaveBeenCalled();
      expect(removed).toEqual([]);
      if (!(control.inspection instanceof ProcessCaptureSamplingFailure))
        throw new Error("Expected actual settled sampling batch");
      expect(control.inspection.inspectionFailures[0]?.inspectionFailure).toBe(
        file.failure,
      );
      expect(control.inspection.inspectionFailures[1]?.inspectionFailure).toBe(
        second.failure,
      );
      expect(control.inspection.samplingFailure.outcomes[1]).toEqual({
        status: "fulfilled",
        value: "completed sampling sibling",
      });
      second.allow();
    }
    await resources.close();
    expect(second?.handle.fd ?? -1).toBe(-1);
    expect(query).toHaveBeenCalledOnce();
    expect(file.handle.fd).toBe(-1);
    expect(removed).toEqual([observerRoot]);
    await expect(stat(removed[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.error.cleanupIncomplete).toBe(false);
  },
);
