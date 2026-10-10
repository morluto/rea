import { afterEach, expect, it, vi } from "vitest";

import { electronActiveObservationInputSchema } from "../domain/javascript/electronActiveObservation.js";
import type { OwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  cleanupElectronProcesses,
  PlaywrightElectronActiveProvider,
} from "./PlaywrightElectronActiveProvider.js";

afterEach(() => vi.unstubAllEnvs());

it("passes the selected environment and ownership token to Electron launch", async () => {
  vi.stubEnv("LANG", "ambient-language");
  let launchedEnvironment: unknown;
  const provider = new PlaywrightElectronActiveProvider(
    {
      LANG: "selected-language",
      PATH: "/selected/bin",
      REA_PRIVATE_VALUE: "not-a-launch-setting",
    },
    async (options) => {
      launchedEnvironment = options?.env;
      throw new Error("launch boundary reached");
    },
  );
  const result = await provider.capture(
    electronActiveObservationInputSchema.parse({
      executable_path: process.execPath,
      application_path: process.execPath,
    }),
  );

  expect(result.ok).toBe(false);
  expect(launchedEnvironment).toEqual({
    LANG: "selected-language",
    PATH: "/selected/bin",
    REA_PROCESS_RUN_ID: expect.any(String),
  });
});

const ownership = {
  runId: "run",
  leaderPid: 4242,
  processGroupId: 4242,
  expectedParentPid: 1,
} satisfies OwnedProcessGroup;

it("does not signal a Windows Electron PID when lineage is unavailable", async () => {
  const terminateTree = vi.fn(async () => ({
    cleaned: true as const,
    signaled: true,
  }));
  const result = await cleanupElectronProcesses(
    ownership,
    {
      status: "unavailable",
      observedAt: "2026-10-10T00:00:00.000Z",
      runId: ownership.runId,
      launcherPid: ownership.leaderPid,
      processGroupId: ownership.processGroupId,
      reason: "owned launcher is not live",
    },
    { platform: "win32", terminateTree },
  );

  expect(terminateTree).not.toHaveBeenCalled();
  expect(result).toEqual({
    cleaned: false,
    reason:
      "owned Electron lineage was unavailable; helper cleanup was not proven",
  });
});

it("signals a Windows Electron tree only after lineage is verified", async () => {
  const terminateTree = vi.fn(async () => ({
    cleaned: true as const,
    signaled: true,
  }));
  const result = await cleanupElectronProcesses(
    ownership,
    {
      status: "verified",
      observedAt: "2026-10-10T00:00:00.000Z",
      lineage: {
        runId: ownership.runId,
        launcherPid: ownership.leaderPid,
        launcherParentPid: 1,
        processGroupId: ownership.processGroupId,
        descendants: [
          {
            pid: 4343,
            parentPid: ownership.leaderPid,
            processGroupId: ownership.processGroupId,
          },
        ],
      },
    },
    { platform: "win32", terminateTree },
  );

  expect(terminateTree).toHaveBeenNthCalledWith(1, 4242);
  expect(terminateTree).toHaveBeenNthCalledWith(2, 4343);
  expect(result).toEqual({ cleaned: true, signaled: true });
});
