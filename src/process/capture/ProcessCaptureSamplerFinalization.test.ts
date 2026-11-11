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
    const failure = options.resourceScope.retainInspectionFailure(
      control.inspection,
    );
    if (failure === undefined)
      throw new Error("Expected actual inspection descriptor failure");
    return async () => {
      throw failure;
    };
  },
}));

it("finishes capture cleanup when sampler stop rejects without replacing an earlier physical failure", async () => {
  const file = await failedInspectionDescriptor();
  control.inspection = file.failure;
  const root = await createTestTempDirectory("rea-capture-stop-failure-");
  const path = join(root, "selected");
  await writeFile(path, "inert selected executable bytes", { mode: 0o755 });
  const resources = new ProcessCaptureResourceScope();
  let observerRoot: string | undefined;
  onTestFinished(async () => {
    file.allow();
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
  await resources.close();
  expect(query).toHaveBeenCalledOnce();
  expect(file.handle.fd).toBe(-1);
  expect(removed).toEqual([observerRoot]);
  await expect(stat(removed[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  expect(result.error.cleanupIncomplete).toBe(false);
});
