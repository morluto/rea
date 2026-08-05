import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright-core";

import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import type { ElectronActiveObservationPort } from "../application/ElectronActiveObservationPort.js";
import {
  electronActiveObservationResultSchema,
  type ElectronActiveObservationInput,
  type ElectronActiveObservationResult,
} from "../domain/electronActiveObservation.js";
import {
  AnalysisError,
  BrowserObservationError,
  ProviderAdapterError,
} from "../domain/errors.js";
import { isPathContained } from "../domain/permissionPolicy.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  cleanupOwnedProcessGroup,
  cleanupWindowsProcessTree,
  observeOwnedProcessLineage,
  selectCapturedProcessGroupIds,
  verifyNoTokenOwnedProcesses,
  type OwnedProcessGroup,
  type ProcessCleanupResult,
  type ProcessLineageObservation,
} from "../process/ProcessOwnership.js";
import {
  runElectronActions,
  readApplicationState,
  runWithExecutionLimits,
  type ElectronHookEvent,
  type ElectronHookSnapshot,
  type ElectronMetrics,
} from "./PlaywrightElectronActiveActions.js";

const OPERATION = "capture_electron_scenario" as const;

/** Public identity for provider-owned Electron runtime experiments. */
export const PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY: ProviderIdentity =
  Object.freeze({
    id: "rea-playwright-electron-active",
    name: "REA Playwright active Electron observation provider",
    version: "1",
  });

const hookPath = fileURLToPath(
  new URL("../../scripts/electron-active-hook.cjs", import.meta.url),
);

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;
type ElectronPaths = {
  readonly executable: string;
  readonly application: string;
  readonly root: string;
};

const observableEventFamilies = [
  "app-lifecycle",
  "window-lifecycle",
  "web-contents-lifecycle",
  "navigation",
  "shell-attempt",
  "process-lifecycle",
  "permission",
  "popup-attempt",
  "download",
  "protocol",
  "preload",
  "preload-configuration",
  "renderer-ipc",
  "native-addon",
  "updater",
  "error",
  "ipc",
] as const;

const ipcEventKinds = new Set<ElectronHookEvent["kind"]>([
  "main-handler-invocation",
  "main-event-invocation",
  "utility-process-fork",
  "utility-process-message",
  "ipc-main-to-renderer",
  "ipc-utility-to-main",
  "ipc-renderer-send",
  "ipc-renderer-invoke",
  "ipc-renderer-post-message",
]);

const createCoverage = (hookSnapshot: ElectronHookSnapshot) => {
  const observedEventFamilies: string[] = [
    ...new Set(
      hookSnapshot.events.map(({ kind, process_type }) => {
        if (kind === "preload" && process_type === "main")
          return "preload-configuration";
        if (kind.startsWith("ipc-renderer") && process_type !== "renderer")
          return "ipc";
        return ipcEventKinds.has(kind) ? "ipc" : kind;
      }),
    ),
  ].sort();
  const unavailableEventFamilies = new Set(
    observableEventFamilies.filter(
      (family) => !observedEventFamilies.includes(family),
    ),
  );
  const observedRoles = [
    ...new Set(
      hookSnapshot.events.flatMap(({ process_type, kind }) => [
        ...(process_type === null ? [] : [process_type]),
        ...(kind === "window-lifecycle" ? ["window"] : []),
        ...(kind === "web-contents-lifecycle" || kind === "navigation"
          ? ["web_contents"]
          : []),
        ...(kind === "preload" && process_type === "preload"
          ? ["preload"]
          : []),
        ...(kind.startsWith("ipc-renderer") && process_type === "renderer"
          ? ["renderer"]
          : []),
      ]),
    ),
  ].sort();
  const rendererContextObserved = hookSnapshot.events.some(
    ({ process_type }) =>
      process_type === "renderer" || process_type === "preload",
  );
  if (!rendererContextObserved) {
    unavailableEventFamilies.add("preload");
    unavailableEventFamilies.add("renderer-ipc");
  }
  return {
    status: hookSnapshot.hook_error
      ? "hook_conflict"
      : hookSnapshot.truncated
        ? "capture_truncated"
        : "partial_attach",
    observed_event_families: observedEventFamilies,
    unavailable_event_families: [...unavailableEventFamilies].sort(),
    observed_roles: observedRoles,
    pre_capture_activity: "unavailable",
  } as const;
};

/** Launch an owned Electron application through the official Playwright API. */
export class PlaywrightElectronActiveProvider
  implements ElectronActiveObservationPort
{
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
    let outcome: Result<ElectronActiveObservationResult, AnalysisError>;
    const runId = randomUUID();
    try {
      if (options.signal?.aborted === true)
        throw new BrowserObservationError(OPERATION, "cancelled");
      const deadline = Date.now() + input.limits.max_duration_ms;
      const paths = await canonicalPaths(input);
      application = await electron.launch({
        executablePath: paths.executable,
        cwd: paths.root,
        env: safeElectronEnvironment(
          input.limits.max_ipc_events,
          input.limits.max_runtime_events,
          runId,
        ),
        args: ["-r", hookPath, paths.application, ...input.args],
        timeout: Math.max(1, deadline - Date.now()),
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
      };
      const actions = await runElectronActions(
        application,
        input,
        options,
        deadline,
      );
      const state = await runWithExecutionLimits(
        readApplicationState(application, input.limits.max_windows),
        options.signal,
        deadline,
      );
      outcome = ok(createResult(paths, input, actions, state));
    } catch (cause: unknown) {
      outcome = err(providerError(cause));
    }
    if (application !== undefined) {
      if (ownership !== undefined)
        lineage = await observeOwnedProcessLineage(ownership);
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
          providerError(
            new BrowserObservationError(OPERATION, "cleanup_failed", {
              cause: new Error(cleanup.reason),
            }),
          ),
        );
      if (closeError !== undefined) return err(providerError(closeError));
    }
    return outcome;
  }
}

const cleanupElectronProcesses = async (
  ownership: OwnedProcessGroup,
  lineage: ProcessLineageObservation | undefined,
): Promise<ProcessCleanupResult> => {
  if (process.platform === "win32") {
    const root = await cleanupWindowsProcessTree(ownership.leaderPid);
    if (!root.cleaned) return root;
    if (lineage?.status !== "verified")
      return {
        cleaned: false,
        reason:
          "owned Electron lineage was unavailable; helper cleanup was not proven",
      };
    for (const descendant of lineage.lineage.descendants) {
      const result = await cleanupWindowsProcessTree(descendant.pid);
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
  }
  const remaining = await verifyNoTokenOwnedProcesses(ownership.runId);
  if (!remaining.cleaned) return remaining;
  return { cleaned: true, signaled };
};

const createResult = (
  paths: ElectronPaths,
  input: ElectronActiveObservationInput,
  actions: ElectronActiveObservationResult["actions"],
  state: {
    readonly windows: ReadonlyArray<{
      readonly window_id: string;
      readonly web_contents_id: string;
      readonly url: string;
      readonly title: string;
      readonly visible: boolean | null;
      readonly destroyed: boolean;
    }>;
    readonly windowsTruncated: boolean;
    readonly metrics: ElectronMetrics;
    readonly electronVersion: string;
    readonly hookSnapshot: ElectronHookSnapshot;
  },
): ElectronActiveObservationResult => {
  const { hookSnapshot } = state;
  const ipcEvents = hookSnapshot.events.filter(({ kind }) =>
    ipcEventKinds.has(kind),
  );
  return electronActiveObservationResultSchema.parse({
    schema_version: 1,
    application: {
      executable_path: paths.executable,
      application_path: paths.application,
      electron_version: state.electronVersion,
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
    },
    actions,
    windows: state.windows.slice(0, input.limits.max_windows),
    windows_truncated: state.windowsTruncated,
    processes: {
      items: state.metrics.slice(0, input.limits.max_processes),
      truncated: state.metrics.length > input.limits.max_processes,
    },
    ipc: {
      events: ipcEvents.slice(0, input.limits.max_ipc_events),
      observed: hookSnapshot.observed_ipc,
      retained: Math.min(ipcEvents.length, input.limits.max_ipc_events),
      truncated:
        hookSnapshot.truncated ||
        ipcEvents.length > input.limits.max_ipc_events,
    },
    timeline: {
      events: hookSnapshot.events.slice(0, input.limits.max_runtime_events),
      observed: hookSnapshot.observed,
      retained: Math.min(
        hookSnapshot.events.length,
        input.limits.max_runtime_events,
      ),
      truncated:
        hookSnapshot.truncated ||
        hookSnapshot.events.length > input.limits.max_runtime_events,
    },
    coverage: createCoverage(hookSnapshot),
    limitations: [
      "IPC payloads are represented only by bounded value shapes; values are never retained, channels are capped at 1,024 characters, and argument-shape arrays at 32 entries.",
      "IPC direction and sender/receiver identifiers are observed only where Electron exposes them at the hooked boundary.",
      "The runtime timeline records bounded lifecycle, navigation, shell, permission, popup, download, protocol, preload, native-addon, process, and IPC events; activity before hook installation is unavailable.",
      "The preload and renderer process contexts are not instrumented by the main-process -r hook; preload configuration and contextBridge API-shape events are main-boundary observations, not proof of renderer-side execution.",
      "Process metrics are an Electron API snapshot and do not prove hostile-local-user isolation.",
      "External shell opens, external navigation, permission grants, downloads, popup windows, updater relaunches, and OS integration are blocked and recorded by the active hook; other application filesystem and network behavior is not sandboxed by this provider.",
      ...(state.windowsTruncated
        ? ["Windows beyond max_windows were not retained."]
        : []),
      ...(hookSnapshot.hook_error
        ? ["The active IPC hook could not be installed."]
        : []),
    ],
  });
};

const canonicalPaths = async (
  input: ElectronActiveObservationInput,
): Promise<ElectronPaths> => {
  const [executable, application, root] = await Promise.all([
    realpath(input.executable_path),
    realpath(input.application_path),
    realpath(input.application_root),
  ]);
  if (!isPathContained(root, application))
    throw new BrowserObservationError(OPERATION, "target_not_allowed");
  return { executable, application, root };
};

const safeElectronEnvironment = (
  maxIpcEvents: number,
  maxRuntimeEvents: number,
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
      .map((name) => [name, process.env[name]] as const)
      .filter(
        (entry): entry is readonly [string, string] => entry[1] !== undefined,
      ),
    ["REA_ELECTRON_ACTIVE_MAX_IPC_EVENTS", String(maxIpcEvents)] as const,
    [
      "REA_ELECTRON_ACTIVE_MAX_RUNTIME_EVENTS",
      String(maxRuntimeEvents),
    ] as const,
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
        },
      );
