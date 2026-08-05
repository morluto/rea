import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright-core";
import { z } from "zod";

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
import { err, ok, type Result } from "../domain/result.js";

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

const hookEventSchema = z.strictObject({
  sequence: z.number().int().min(1),
  kind: z.enum([
    "main-handler-invocation",
    "main-event-invocation",
    "utility-process-fork",
    "utility-process-message",
    "ipc-main-to-renderer",
    "ipc-utility-to-main",
    "app-lifecycle",
    "window-lifecycle",
    "web-contents-lifecycle",
    "navigation",
    "shell-attempt",
    "process-lifecycle",
  ]),
  event: z.string().max(128).nullable(),
  phase: z.enum(["attempted", "completed", "blocked", "failed", "observed"]),
  channel: z.string().max(1_024).nullable(),
  direction: z
    .enum([
      "renderer-to-main",
      "main-to-renderer",
      "main-to-utility",
      "utility-to-main",
    ])
    .nullable(),
  sender: z.string().max(256).nullable(),
  receiver: z.string().max(256).nullable(),
  target: z.string().max(256).nullable(),
  argument_shapes: z.array(z.string().max(64)).max(32),
  result_shape: z.string().max(64).nullable(),
  process_type: z.string().max(128).nullable(),
  error: z.boolean(),
});
const hookSnapshotSchema = z.strictObject({
  events: z.array(hookEventSchema).max(10_000),
  observed: z.number().int().min(0),
  observed_ipc: z.number().int().min(0),
  observed_runtime: z.number().int().min(0),
  truncated: z.boolean(),
  hook_error: z.boolean(),
});
const metricSchema = z.strictObject({
  pid: z.number().int().min(1),
  type: z.string().min(1).max(128),
});

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;
type ElectronWindow = Awaited<ReturnType<ElectronApplication["firstWindow"]>>;
type ElectronPaths = {
  readonly executable: string;
  readonly application: string;
  readonly root: string;
};
type ElectronActions = ElectronActiveObservationResult["actions"];
type ElectronHookSnapshot = z.infer<typeof hookSnapshotSchema>;
type ElectronHookEvent = z.infer<typeof hookEventSchema>;
type ElectronMetrics = z.infer<typeof metricSchema>[];

const ipcEventKinds = new Set<ElectronHookEvent["kind"]>([
  "main-handler-invocation",
  "main-event-invocation",
  "utility-process-fork",
  "utility-process-message",
  "ipc-main-to-renderer",
  "ipc-utility-to-main",
]);

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
    let outcome: Result<ElectronActiveObservationResult, AnalysisError>;
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
        ),
        args: ["-r", hookPath, paths.application, ...input.args],
        timeout: Math.max(1, deadline - Date.now()),
      });
      const window = await application.firstWindow({
        timeout: Math.min(
          input.limits.action_timeout_ms,
          Math.max(1, deadline - Date.now()),
        ),
      });
      const actions = await runActions(window, input, options.signal, deadline);
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
      try {
        await runWithExecutionLimits(
          application.close(),
          undefined,
          Date.now() + 5_000,
        );
      } catch (cause: unknown) {
        return err(providerError(cause));
      }
    }
    return outcome;
  }
}

const runActions = async (
  window: ElectronWindow,
  input: ElectronActiveObservationInput,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<ElectronActions> => {
  const actions: ElectronActions = [];
  for (const action of input.actions) {
    if (signal?.aborted === true)
      throw new BrowserObservationError(OPERATION, "cancelled");
    const actionStartedAt = Date.now();
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new BrowserObservationError(OPERATION, "timeout");
      if (action.kind === "click") {
        await runWithExecutionLimits(
          window.locator(action.selector).click({
            timeout: Math.min(input.limits.action_timeout_ms, remaining),
          }),
          signal,
          deadline,
        );
      } else {
        await runWithExecutionLimits(
          window.waitForTimeout(Math.min(action.duration_ms, remaining)),
          signal,
          deadline,
        );
        if (action.duration_ms > remaining)
          throw new BrowserObservationError(OPERATION, "timeout");
      }
      actions.push({
        step_id: action.step_id,
        kind: action.kind,
        status: "completed",
        elapsed_ms: Date.now() - actionStartedAt,
        error: null,
      });
    } catch (cause: unknown) {
      actions.push({
        step_id: action.step_id,
        kind: action.kind,
        status: signal?.aborted ? "cancelled" : "failed",
        elapsed_ms: Date.now() - actionStartedAt,
        error: safeErrorMessage(cause),
      });
      break;
    }
  }
  return actions;
};

const readApplicationState = async (
  application: ElectronApplication,
  maxWindows: number,
) => {
  const pages = application.windows();
  const [windows, processMetrics, electronVersion, hookSnapshot] =
    await Promise.all([
      Promise.all(
        pages.slice(0, maxWindows).map(async (page) => ({
          url: page.url().slice(0, 65_536),
          title: (await page.title()).slice(0, 16_384),
        })),
      ),
      application.evaluate(({ app }) =>
        app
          .getAppMetrics()
          .map((metric: { readonly pid: number; readonly type: string }) => ({
            pid: metric.pid,
            type: metric.type,
          })),
      ),
      application.evaluate(({ app }) => app.getVersion()),
      application.evaluate(() => {
        const candidate = Reflect.get(
          globalThis,
          "__reaElectronActiveSnapshot",
        );
        return typeof candidate === "function"
          ? candidate()
          : {
              events: [],
              observed: 0,
              observed_ipc: 0,
              observed_runtime: 0,
              truncated: false,
              hook_error: true,
            };
      }),
    ]);
  return {
    windows,
    windowsTruncated: pages.length > maxWindows,
    metrics: z.array(metricSchema).parse(processMetrics),
    electronVersion: z.string().parse(electronVersion),
    hookSnapshot: hookSnapshotSchema.parse(hookSnapshot),
  };
};

const createResult = (
  paths: ElectronPaths,
  input: ElectronActiveObservationInput,
  actions: ElectronActions,
  state: {
    readonly windows: ReadonlyArray<{
      readonly url: string;
      readonly title: string;
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
    limitations: [
      "IPC payloads are represented only by bounded value shapes; values are never retained.",
      "IPC direction and sender/receiver identifiers are observed only where Electron exposes them at the hooked boundary.",
      "The runtime timeline records bounded lifecycle, navigation, shell, process, and IPC events; activity before hook installation is unavailable.",
      "Process metrics are an Electron API snapshot and do not prove hostile-local-user isolation.",
      "External shell opens are blocked by the active hook; other application filesystem and network behavior is not sandboxed by this provider.",
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
  const outside = relative(root, application);
  if (
    outside === ".." ||
    outside.startsWith(`..${"/"}`) ||
    outside.startsWith("/")
  )
    throw new BrowserObservationError(OPERATION, "target_not_allowed");
  return { executable, application, root };
};

const safeElectronEnvironment = (
  maxIpcEvents: number,
  maxRuntimeEvents: number,
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
  ]);

const runWithExecutionLimits = async <Value>(
  operation: Promise<Value>,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<Value> => {
  if (signal?.aborted === true)
    throw new BrowserObservationError(OPERATION, "cancelled");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BrowserObservationError(OPERATION, "timeout")),
      Math.max(1, deadline - Date.now()),
    );
  });
  const cancellation =
    signal === undefined
      ? timeout
      : Promise.race([
          timeout,
          new Promise<never>((_, reject) => {
            abortListener = () =>
              reject(new BrowserObservationError(OPERATION, "cancelled"));
            signal.addEventListener("abort", abortListener, { once: true });
          }),
        ]);
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined)
      signal?.removeEventListener("abort", abortListener);
  }
};

const safeErrorMessage = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : "Electron action failed").slice(
    0,
    1_024,
  );

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
