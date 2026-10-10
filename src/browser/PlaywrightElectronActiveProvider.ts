import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright-core";

import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import type { ElectronActiveObservationPort } from "../application/javascript/ElectronActiveObservationPort.js";
import type {
  ElectronActiveObservationInput,
  ElectronActiveObservationResult,
} from "../domain/javascript/electronActiveObservation.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  cleanupOwnedProcessGroup,
  cleanupWindowsProcessTree,
  verifyNoTokenOwnedProcesses,
  type OwnedProcessGroup,
  type ProcessCleanupResult,
  type ProcessLineageObservation,
  type OwnershipSweepUnverifiedProcess,
} from "../process/ProcessOwnership.js";
import {
  observeOwnedProcessLineage,
  prepareProcessOwnershipInspection,
  systemProcessOwnershipHost,
} from "../process/ProcessOwnershipObservation.js";
import { selectCapturedProcessGroupIds } from "../process/ProcessOwnershipProcessTree.js";
import {
  runElectronActions,
  readApplicationState,
  runWithExecutionLimits,
} from "./PlaywrightElectronActiveActions.js";
import { projectElectronActiveCapture } from "./PlaywrightElectronActiveProjection.js";

const OPERATION = "capture_electron_scenario" as const;
const STARTUP_TIMEOUT_MS = 60_000;

import { PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY } from "./providerIdentities.js";

const hookPath = fileURLToPath(
  new URL("../../scripts/electron-active-hook.cjs", import.meta.url),
);

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;
type ElectronPaths = {
  readonly executable: string;
  readonly application: string;
  readonly root: string;
};

/** Launch an owned Electron application through the official Playwright API. */
export class PlaywrightElectronActiveProvider implements ElectronActiveObservationPort {
  constructor(
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly launch: typeof electron.launch = (options) =>
      electron.launch(options),
  ) {}

  identity(): ProviderIdentity {
    return PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY;
  }

  async capture(
    input: ElectronActiveObservationInput,
    options: ExecutionOptions = {},
  ): Promise<Result<ElectronActiveObservationResult, AnalysisError>> {
    let application: ElectronApplication | undefined;
    let ownership: OwnedProcessGroup | undefined;
    let lineage: ProcessLineageObservation | undefined;
    let capture: ElectronActiveObservationResult | undefined;
    let paths: ElectronPaths | undefined;
    let initialState:
      | Awaited<ReturnType<typeof readApplicationState>>
      | undefined;
    let actions: ElectronActiveObservationResult["actions"] = [];
    let outcome: Result<ElectronActiveObservationResult, AnalysisError>;
    const runId = randomUUID();
    try {
      if (options.signal?.aborted === true)
        throw new BrowserObservationError(OPERATION, "cancelled");
      await prepareProcessOwnershipInspection(options.signal);
      const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS;
      paths = await canonicalPaths(input);
      const captureBaseline =
        await systemProcessOwnershipHost.captureBaseline?.(options.signal);
      if (options.signal?.aborted)
        throw new BrowserObservationError(OPERATION, "cancelled");
      application = await this.launch({
        executablePath: paths.executable,
        cwd: paths.root,
        env: safeElectronEnvironment(this.environment, runId),
        args: ["-r", hookPath, paths.application, ...input.args],
        timeout: Math.max(1, startupDeadline - Date.now()),
      });
      const leaderPid = application.process().pid;
      if (
        typeof leaderPid !== "number" ||
        !Number.isSafeInteger(leaderPid) ||
        leaderPid <= 0
      )
        throw new BrowserObservationError(
          OPERATION,
          "process_ownership_unavailable",
        );
      ownership = {
        runId,
        leaderPid,
        processGroupId: leaderPid,
        expectedParentPid: process.pid,
        expectedCommand: paths.executable,
        sweepTokenOwnedProcesses: true,
        ...(captureBaseline === undefined ? {} : { captureBaseline }),
      };
      lineage = await observeOwnedProcessLineage(ownership);
      initialState = await readApplicationState(application);
      actions = await runElectronActions(application, input, options);
      const state = await runWithExecutionLimits(
        readApplicationState(application),
        undefined,
        options.signal?.aborted ? Date.now() + 5_000 : undefined,
      );
      capture = projectElectronActiveCapture(paths, actions, state);
      outcome = options.signal?.aborted
        ? err(
            new BrowserObservationError(OPERATION, "cancelled", {
              partialObservation: {
                kind: "electron-active-observation",
                capture,
              },
            }),
          )
        : ok(capture);
    } catch (cause: unknown) {
      if (
        options.signal?.aborted &&
        paths !== undefined &&
        initialState !== undefined
      ) {
        const retainedCapture = projectElectronActiveCapture(
          paths,
          actions,
          initialState,
        );
        capture = {
          ...retainedCapture,
          limitations: [
            ...retainedCapture.limitations,
            `Final Electron state was unavailable after cancellation: ${cause instanceof Error ? cause.message : String(cause)}. Windows, metrics, IPC, and timeline are the snapshot collected before actions and may omit their effects.`,
          ],
        };
      }
      outcome = err(
        options.signal?.aborted === true
          ? new BrowserObservationError(OPERATION, "cancelled", {
              cause,
              ...(capture === undefined
                ? {}
                : {
                    partialObservation: {
                      kind: "electron-active-observation" as const,
                      capture,
                    },
                  }),
            })
          : providerError(cause),
      );
    }
    if (application !== undefined) {
      if (ownership !== undefined) {
        const currentLineage = await observeOwnedProcessLineage(ownership);
        if (currentLineage.status === "verified" || lineage === undefined)
          lineage = currentLineage;
      }
      let closeError: unknown;
      try {
        await runWithExecutionLimits(
          application.close(),
          undefined,
          Date.now() + 5_000,
        );
      } catch (cause: unknown) {
        closeError = cause;
      }
      const cleanup =
        ownership === undefined
          ? ({
              cleaned: false,
              reason: "owned Electron process identity was unavailable",
            } satisfies ProcessCleanupResult)
          : await cleanupElectronProcesses(ownership, lineage);
      if (!cleanup.cleaned)
        return err(
          new BrowserObservationError(OPERATION, "cleanup_failed", {
            cause: outcome.ok ? new Error(cleanup.reason) : outcome.error,
            detail: `Electron cleanup could not be verified: ${cleanup.reason}.${capture !== undefined ? " Collected observations are retained in partial_observation." : ""}${outcome.ok ? "" : ` Capture also failed: ${outcome.error.message}.`} Inspect the reported process resources before launching another capture.`,
            cleanup: {
              reason: cleanup.reason,
              resources:
                ownership === undefined
                  ? ["owned_process_group"]
                  : [
                      "owned_process_group",
                      `run:${ownership.runId}`,
                      `process-group:${String(ownership.processGroupId)}`,
                    ],
            },
            ...(capture !== undefined
              ? {
                  partialObservation: {
                    kind: "electron-active-observation" as const,
                    capture: {
                      ...capture,
                      application: {
                        ...capture.application,
                        cleanup: "unverified" as const,
                      },
                    },
                  },
                }
              : {}),
          }),
        );
      if (closeError !== undefined)
        return err(
          new BrowserObservationError(OPERATION, "cleanup_failed", {
            cause: outcome.ok ? closeError : outcome.error,
            detail: `Electron transport teardown failed after process cleanup: ${closeError instanceof Error ? closeError.message : String(closeError)}.${capture !== undefined ? " Collected observations are retained in partial_observation." : ""}${outcome.ok ? "" : ` Capture also failed: ${outcome.error.message}.`}`,
            ...(capture !== undefined
              ? {
                  partialObservation: {
                    kind: "electron-active-observation" as const,
                    capture,
                  },
                }
              : {}),
          }),
        );
      if (outcome.ok && cleanup.unverified !== undefined)
        outcome = ok({
          ...outcome.value,
          limitations: [
            ...outcome.value.limitations,
            ...cleanup.unverified.map(
              ({ pid, diagnostic }) =>
                `Ownership of unrelated process ${String(pid)} could not be verified; it was left untouched: ${diagnostic}`,
            ),
          ],
        });
    }
    return outcome;
  }
}

/** Clean up an Electron launch. Windows signals a process only after lineage is verified. */
export const cleanupElectronProcesses = async (
  ownership: OwnedProcessGroup,
  lineage: ProcessLineageObservation | undefined,
  host: {
    readonly platform: NodeJS.Platform;
    readonly terminateTree: typeof cleanupWindowsProcessTree;
  } = {
    platform: process.platform,
    terminateTree: cleanupWindowsProcessTree,
  },
): Promise<ProcessCleanupResult> => {
  if (host.platform === "win32") {
    // An empty Windows process table is not ownership proof for this PID.
    if (lineage?.status !== "verified")
      return {
        cleaned: false,
        reason:
          "owned Electron lineage was unavailable; helper cleanup was not proven",
      };
    const root = await host.terminateTree(ownership.leaderPid);
    if (!root.cleaned) return root;
    for (const descendant of lineage.lineage.descendants) {
      const result = await host.terminateTree(descendant.pid);
      if (!result.cleaned) return result;
    }
    return root;
  }
  if (lineage?.status !== "verified") {
    const root = await cleanupOwnedProcessGroup(ownership);
    return root.cleaned
      ? {
          cleaned: false,
          reason:
            "owned Electron lineage was unavailable; helper cleanup was not proven",
        }
      : root;
  }
  const groupIds = selectCapturedProcessGroupIds(
    ownership.leaderPid,
    lineage.lineage.descendants.map(({ pid, processGroupId }) => ({
      pid,
      process_group_id: processGroupId,
    })),
  );
  let signaled = false;
  const unverified: OwnershipSweepUnverifiedProcess[] = [];
  for (const processGroupId of groupIds) {
    const cleanupOwnership: OwnedProcessGroup =
      processGroupId === ownership.processGroupId
        ? { ...ownership, leaderPid: processGroupId, processGroupId }
        : {
            runId: ownership.runId,
            leaderPid: processGroupId,
            processGroupId,
          };
    const result = await cleanupOwnedProcessGroup(cleanupOwnership);
    if (!result.cleaned) return result;
    signaled ||= result.signaled;
    unverified.push(...(result.unverified ?? []));
  }
  const remaining = await verifyNoTokenOwnedProcesses(
    ownership.runId,
    undefined,
    ownership.captureBaseline,
    {
      leaderPid: ownership.leaderPid,
      processGroupId: ownership.processGroupId,
      ...(ownership.sampledProcessGroupIds === undefined
        ? {}
        : { sampledProcessGroupIds: ownership.sampledProcessGroupIds }),
    },
  );
  if (!remaining.cleaned) return remaining;
  unverified.push(...(remaining.unverified ?? []));
  return {
    cleaned: true,
    signaled,
    ...(unverified.length === 0
      ? {}
      : {
          unverified: [
            ...new Map(
              unverified.map((item) => [
                `${String(item.pid)}:${item.diagnostic}`,
                item,
              ]),
            ).values(),
          ],
        }),
  };
};

const canonicalPaths = async (
  input: ElectronActiveObservationInput,
): Promise<ElectronPaths> => {
  const [executable, application] = await Promise.all([
    realpath(input.executable_path),
    realpath(input.application_path),
  ]);
  const root =
    input.application_root === undefined
      ? dirname(application)
      : await realpath(input.application_root);
  return { executable, application, root };
};

const safeElectronEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  runId: string,
): Record<string, string> =>
  Object.fromEntries([
    ...[
      "HOME",
      "LANG",
      "PATH",
      "TMP",
      "TMPDIR",
      "USER",
      "DISPLAY",
      "WAYLAND_DISPLAY",
    ]
      .map((name) => [name, environment[name]] as const)
      .filter(
        (entry): entry is readonly [string, string] => entry[1] !== undefined,
      ),
    ["REA_PROCESS_RUN_ID", runId] as const,
  ]);

const providerError = (cause: unknown): AnalysisError =>
  cause instanceof AnalysisError
    ? cause
    : new ProviderAdapterError(
        PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY.id,
        OPERATION,
        {
          cause,
          diagnostics: {
            message: cause instanceof Error ? cause.message : String(cause),
          },
        },
      );
