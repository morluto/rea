import { afterEach, expect, it, vi } from "vitest";
import { dirname } from "node:path";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisErrorProjectionSchema } from "../contracts/errorSchemas.js";
import {
  primaryAnalysisError,
  type AnalysisError,
} from "../domain/analysisErrorBase.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import type { ElectronFuseImage } from "../electron/ElectronFuseReader.js";
import {
  electronActiveObservationInputSchema,
  type ElectronActiveObservationResult,
  type ElectronActivePartialObservation,
} from "../domain/javascript/electronActiveObservation.js";
import * as ownershipObservation from "../process/ProcessOwnershipObservation.js";
import * as electronActions from "./PlaywrightElectronActiveActions.js";
import * as electronCleanup from "./ElectronProcessCleanup.js";
import { PlaywrightElectronActiveProvider } from "./PlaywrightElectronActiveProvider.js";

afterEach(() => vi.restoreAllMocks());

// Authored launch, fuse and OS hosts exercise production finalization without
// running Electron or granting signal authority to a real process.
const emptyHookSnapshot = () => ({
  events: [],
  retention_budget_bytes: 0,
  estimated_retained_bytes: 0,
  event_serialized_byte_upper_bound: 0,
  retained: 0,
  dropped: 0,
  dropped_ipc: 0,
  dropped_runtime: 0,
  dropped_event_families: [],
  dropped_event_roles: [],
  observed: 0,
  observed_ipc: 0,
  observed_runtime: 0,
  hook_error: false,
});

const stubElectronOwnershipInspection = (): void => {
  vi.spyOn(
    ownershipObservation,
    "prepareProcessOwnershipInspection",
  ).mockResolvedValue(undefined);
  if (
    ownershipObservation.systemProcessOwnershipHost.captureBaseline !==
    undefined
  )
    vi.spyOn(
      ownershipObservation.systemProcessOwnershipHost,
      "captureBaseline",
    ).mockResolvedValue([]);
  vi.spyOn(
    ownershipObservation,
    "observeOwnedProcessLineage",
  ).mockImplementation(async (owner) => ({
    status: "verified",
    observedAt: "2026-10-30T00:00:00Z",
    lineage: {
      runId: owner.runId,
      launcherPid: owner.leaderPid,
      launcherParentPid: process.pid,
      processGroupId: owner.processGroupId,
      descendants: [],
    },
  }));
};

const readUnknownFixtureFuses = async (): Promise<ElectronFuseImage> => ({
  sha256: "0".repeat(64),
  bytes: 0,
  format: "pe",
  slices: [],
});

const retainedProducerFact = "authored earlier producer observation";
const retainedObservationFailure = (
  capture: ElectronActiveObservationResult,
  cause: Error,
  cleanupDiagnostic: string,
): BrowserObservationError => {
  const partialObservation: ElectronActivePartialObservation = {
    kind: "electron-active-observation",
    capture: {
      ...capture,
      limitations: [
        ...capture.limitations.filter(
          (value) => !value.includes(cleanupDiagnostic),
        ),
        retainedProducerFact,
      ],
    },
  };
  return new BrowserObservationError(
    "capture_electron_scenario",
    "protocol_error",
    { cause, partialObservation },
  );
};

it.each([
  "process",
  "transport",
  "observation",
  "cancellation",
  "compound",
] as const)(
  "preserves unrelated cleanup observations after a %s failure",
  async (failureStage) => {
    const processFailed =
      failureStage === "process" || failureStage === "compound";
    const observationFailed =
      failureStage === "observation" || failureStage === "compound";
    stubElectronOwnershipInspection();
    const state = {
      windows: [],
      metrics: [],
      electronVersion: "44.0.0",
      hookSnapshot: emptyHookSnapshot(),
    };
    vi.spyOn(electronActions, "readApplicationState").mockResolvedValue(state);
    const readFinal = vi
      .spyOn(electronActions, "readFinalApplicationState")
      .mockResolvedValue(state);
    const unverified = [
      { pid: 900, diagnostic: "authored withheld environment" },
    ];
    const cleanup = vi
      .spyOn(electronCleanup, "cleanupElectronProcesses")
      .mockResolvedValue({
        cleaned: true,
        signaled: false,
        unverified,
      });
    const controller = new AbortController();
    const cancellation = new Error("authored caller cancellation");
    const observationFailure = new Error("authored final state unavailable");
    let closeDenied = false;
    const application = {
      process: () => ({ pid: 424242 }),
      close: vi.fn(async () => {
        if (closeDenied) throw new Error("authored close failure");
      }),
      windows: () => [],
    };
    const provider = new PlaywrightElectronActiveProvider(
      {},
      async () =>
        application as unknown as Awaited<
          ReturnType<typeof import("playwright-core")._electron.launch>
        >,
      readUnknownFixtureFuses,
    );
    const input = {
      ...electronActiveObservationInputSchema.parse({
        executable_path: process.execPath,
        application_path: process.execPath,
      }),
      application_root: dirname(process.execPath),
    };
    let published: AnalysisError | undefined;
    let historical: string | undefined;
    try {
      const control = await provider.capture(input, {
        signal: controller.signal,
      });
      if (!control.ok) throw control.error;
      expect(
        control.value.limitations.some(
          (value) =>
            value.includes(String(unverified[0]!.pid)) &&
            value.includes(unverified[0]!.diagnostic),
        ),
      ).toBe(true);
      if (processFailed)
        cleanup.mockResolvedValueOnce({
          cleaned: false,
          reason: "authored owned helper remains",
          unverified,
        });
      if (failureStage === "transport") closeDenied = true;
      if (observationFailed)
        readFinal.mockRejectedValueOnce(
          retainedObservationFailure(
            control.value,
            observationFailure,
            unverified[0]!.diagnostic,
          ),
        );
      if (failureStage === "cancellation")
        readFinal.mockImplementationOnce(async () => {
          controller.abort(cancellation);
          return state;
        });
      const result = await provider.capture(input, {
        signal: controller.signal,
      });
      if (result.ok) throw new Error("Expected a failed observation");
      published = result.error;
      const partial = result.error.partialObservation;
      expect(partial).toMatchObject({
        kind: "electron-active-observation",
        capture: {
          application: {
            cleanup: processFailed ? "unverified" : "terminated-owned-process",
          },
          limitations: expect.arrayContaining(control.value.limitations),
        },
      });
      expect(
        analysisErrorProjectionSchema.parse(projectAnalysisError(result.error)),
      ).toMatchObject({
        details: {
          partial_observation: {
            kind: "electron-active-observation",
            capture: {
              limitations: expect.arrayContaining(control.value.limitations),
            },
          },
        },
      });
      expect(result.error.cleanupIncomplete).toBe(
        processFailed || failureStage === "transport",
      );
      if (observationFailed) {
        expect(primaryAnalysisError(result.error).cause).toBe(
          observationFailure,
        );
        expect(partial).toMatchObject({
          capture: {
            limitations: expect.arrayContaining([retainedProducerFact]),
          },
        });
      }
      if (failureStage === "cancellation") {
        expect(result.error.cause).toBe(cancellation);
        expect(result.error).toMatchObject({ reason: "cancelled" });
      }
      historical = JSON.stringify(result.error.partialObservation);
    } finally {
      closeDenied = false;
      await provider.close();
    }
    expect(published?.cleanupIncomplete).toBe(false);
    expect(JSON.stringify(published?.partialObservation)).toBe(historical);
  },
);
