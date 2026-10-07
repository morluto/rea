import type { ElectronApplication, Page } from "playwright-core";
import { z } from "zod";

import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import type {
  ElectronActiveObservationInput,
  ElectronActiveObservationResult,
} from "../domain/javascript/electronActiveObservation.js";

const OPERATION = "capture_electron_scenario" as const;

const hookEventSchema = z.strictObject({
  sequence: z.number().int().min(1),
  correlation_id: z.string().nullable(),
  kind: z.enum([
    "main-handler-invocation",
    "main-event-invocation",
    "utility-process-fork",
    "utility-process-message",
    "ipc-main-to-renderer",
    "ipc-utility-to-main",
    "ipc-renderer-send",
    "ipc-renderer-invoke",
    "ipc-renderer-post-message",
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
    "native-addon",
    "updater",
    "error",
  ]),
  event: z.string().nullable(),
  phase: z.enum(["attempted", "completed", "blocked", "failed", "observed"]),
  channel: z.string().nullable(),
  direction: z
    .enum([
      "renderer-to-main",
      "main-to-renderer",
      "main-to-utility",
      "utility-to-main",
    ])
    .nullable(),
  sender: z.string().nullable(),
  receiver: z.string().nullable(),
  frame: z.string().nullable(),
  target: z.string().nullable(),
  argument_shapes: z.array(z.string()),
  result_shape: z.string().nullable(),
  process_type: z.string().nullable(),
  source: z.string(),
  capture_method: z.enum(["api-wrapper", "event-emitter", "process-hook"]),
  artifact_path: z.string().nullable(),
  artifact_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  error: z.boolean(),
});

const hookSnapshotSchema = z.strictObject({
  events: z.array(hookEventSchema),
  observed: z.number().int().min(0),
  observed_ipc: z.number().int().min(0),
  observed_runtime: z.number().int().min(0),
  hook_error: z.boolean(),
});

const metricSchema = z.strictObject({
  pid: z.number().int().min(1),
  type: z.string().min(1),
  name: z.string().nullable(),
  service_name: z.string().nullable(),
});

const windowMetadataSchema = z.strictObject({
  window_id: z.string(),
  web_contents_id: z.string(),
  visible: z.boolean().nullable(),
  destroyed: z.boolean(),
});

type ElectronAction = ElectronActiveObservationInput["actions"][number];
type ElectronActions = ElectronActiveObservationResult["actions"];

export type ElectronHookSnapshot = z.infer<typeof hookSnapshotSchema>;
export type ElectronHookEvent = z.infer<typeof hookEventSchema>;
export type ElectronMetrics = z.infer<typeof metricSchema>[];
type ElectronWindowMetadata = z.infer<typeof windowMetadataSchema>;
type ElectronPageSnapshot = {
  readonly index: number;
  readonly url: string;
  readonly title: string;
};

/** Run explicit actions against provider-owned Electron windows. */
export const runElectronActions = async (
  application: ElectronApplication,
  input: ElectronActiveObservationInput,
  options: ExecutionOptions,
): Promise<ElectronActions> => {
  const actions: ElectronActions = [];
  for (const action of input.actions) {
    if (options.signal?.aborted === true)
      throw new BrowserObservationError(OPERATION, "cancelled");
    const actionStartedAt = Date.now();
    const windowIndex = actionWindowIndex(action);
    let selectedWindow: Page | undefined;
    try {
      selectedWindow =
        windowIndex === null
          ? undefined
          : await waitForWindow({
              application,
              windowIndex,
              signal: options.signal,
            });
      if (
        (action.kind === "click" ||
          action.kind === "renderer-reload" ||
          action.kind === "renderer-crash") &&
        selectedWindow === undefined
      )
        throw new BrowserObservationError(OPERATION, "window_not_found");

      await runAction({
        application,
        action,
        selectedWindow,
        options,
      });
      actions.push({
        step_id: action.step_id,
        kind: action.kind,
        window_index: windowIndex,
        target:
          selectedWindow === undefined ? null : `window:${String(windowIndex)}`,
        status: "completed",
        elapsed_ms: Date.now() - actionStartedAt,
        error: null,
      });
    } catch (cause: unknown) {
      actions.push({
        step_id: action.step_id,
        kind: action.kind,
        window_index: windowIndex,
        target:
          selectedWindow === undefined ? null : `window:${String(windowIndex)}`,
        status: options.signal?.aborted ? "cancelled" : "failed",
        elapsed_ms: Date.now() - actionStartedAt,
        error: safeActionErrorMessage(cause),
      });
      break;
    }
  }
  return actions;
};

type RunActionContext = {
  readonly application: ElectronApplication;
  readonly action: ElectronAction;
  readonly selectedWindow: Page | undefined;
  readonly options: ExecutionOptions;
};

const runAction = async ({
  application,
  action,
  selectedWindow,
  options,
}: RunActionContext): Promise<void> => {
  switch (action.kind) {
    case "click":
      if (selectedWindow === undefined)
        throw new BrowserObservationError(OPERATION, "window_not_found");
      await runWithExecutionLimits(
        selectedWindow.locator(action.selector).click({
          timeout: 0,
        }),
        options.signal,
      );
      return;
    case "wait": {
      const page =
        selectedWindow ??
        (await application.firstWindow({
          timeout: 0,
        }));
      await runWithExecutionLimits(
        page.waitForTimeout(action.duration_ms),
        options.signal,
      );
      return;
    }
    case "renderer-reload":
      if (selectedWindow === undefined)
        throw new BrowserObservationError(OPERATION, "window_not_found");
      await runWithExecutionLimits(
        selectedWindow.reload({
          timeout: 0,
        }),
        options.signal,
      );
      return;
    case "renderer-crash": {
      const crashed = await runWithExecutionLimits(
        application.evaluate(({ BrowserWindow }, index) => {
          const candidate = BrowserWindow.getAllWindows()[index];
          if (candidate === undefined || candidate.isDestroyed()) return false;
          candidate.webContents.forcefullyCrashRenderer();
          return true;
        }, action.window_index),
        options.signal,
      );
      if (!crashed)
        throw new BrowserObservationError(OPERATION, "window_not_found");
      return;
    }
    case "deep-link":
      await runWithExecutionLimits(
        emitDeepLink(application, action),
        options.signal,
      );
      return;
  }
};

const actionWindowIndex = (action: ElectronAction): number | null => {
  switch (action.kind) {
    case "click":
    case "renderer-reload":
    case "renderer-crash":
      return action.window_index;
    case "wait":
      return action.window_index ?? null;
    case "deep-link":
      return null;
  }
};

type WaitForWindowContext = {
  readonly application: ElectronApplication;
  readonly windowIndex: number;
  readonly signal: AbortSignal | undefined;
};

const waitForWindow = async ({
  application,
  windowIndex,
  signal,
}: WaitForWindowContext): Promise<Page> => {
  while (true) {
    if (signal?.aborted === true)
      throw new BrowserObservationError(OPERATION, "cancelled");
    const window = application.windows()[windowIndex];
    if (window !== undefined) return window;
    await runWithExecutionLimits(
      new Promise<void>((resolve) => setTimeout(resolve, 25)),
      signal,
    );
  }
};

const emitDeepLink = (
  application: ElectronApplication,
  action: Extract<ElectronAction, { kind: "deep-link" }>,
): Promise<boolean> =>
  application.evaluate(
    ({ app }, payload) => {
      if (payload.delivery === "open-url")
        return app.emit(
          "open-url",
          { preventDefault: () => undefined },
          payload.url,
        );
      return app.emit("second-instance", {}, [payload.url], "", {});
    },
    { delivery: action.delivery, url: action.url },
  );

/** Read the current Electron windows, metrics, and hook snapshot. */
// oxlint-disable-next-line max-lines-per-function -- one state read must share one capture boundary.
export const readApplicationState = async (
  application: ElectronApplication,
): Promise<{
  readonly windows: ReadonlyArray<{
    readonly window_id: string;
    readonly web_contents_id: string;
    readonly url: string;
    readonly title: string;
    readonly visible: boolean | null;
    readonly destroyed: boolean;
  }>;
  readonly metrics: ElectronMetrics;
  readonly electronVersion: string;
  readonly hookSnapshot: ElectronHookSnapshot;
}> => {
  const pages = application.windows();
  const pageSnapshotsPromise: Promise<ElectronPageSnapshot[]> = Promise.all(
    pages.map(async (page: Page, index): Promise<ElectronPageSnapshot> => ({
      index,
      url: page.url(),
      title: await page.title(),
    })),
  );
  const windowMetadataPromise: Promise<ElectronWindowMetadata[]> = application
    .evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(
        (window: {
          readonly id: number;
          readonly webContents: { readonly id: number };
          isDestroyed(): boolean;
          isVisible(): boolean;
        }) => ({
          window_id: `window:${String(window.id)}`,
          web_contents_id: `webContents:${String(window.webContents.id)}`,
          visible: window.isDestroyed() ? null : window.isVisible(),
          destroyed: window.isDestroyed(),
        }),
      ),
    )
    .then((value) => z.array(windowMetadataSchema).parse(value));
  const processMetricsPromise: Promise<ElectronMetrics> = application
    .evaluate(({ app }) =>
      app
        .getAppMetrics()
        .map(
          (metric: {
            readonly pid: number;
            readonly type: string;
            readonly name?: string;
            readonly serviceName?: string;
          }) => ({
            pid: metric.pid,
            type: metric.type,
            name: metric.name ?? null,
            service_name: metric.serviceName ?? null,
          }),
        ),
    )
    .then((value) => z.array(metricSchema).parse(value));
  const electronVersionPromise: Promise<string> = application
    .evaluate(() => process.versions.electron)
    .then((value) => z.string().parse(value));
  const hookSnapshotPromise: Promise<ElectronHookSnapshot> = application
    .evaluate(() => {
      const candidate = Reflect.get(globalThis, "__reaElectronActiveSnapshot");
      return typeof candidate === "function"
        ? candidate()
        : {
            events: [],
            observed: 0,
            observed_ipc: 0,
            observed_runtime: 0,
            hook_error: true,
          };
    })
    .then((value) => hookSnapshotSchema.parse(value));
  const [
    pageSnapshots,
    windowMetadata,
    processMetrics,
    electronVersion,
    hookSnapshot,
  ] = await Promise.all([
    pageSnapshotsPromise,
    windowMetadataPromise,
    processMetricsPromise,
    electronVersionPromise,
    hookSnapshotPromise,
  ]);
  return {
    windows: pageSnapshots.map((page) => {
      const metadata = windowMetadata[page.index];
      if (metadata === undefined)
        throw new BrowserObservationError(OPERATION, "window_metadata_missing");
      return {
        window_id: metadata.window_id,
        web_contents_id: metadata.web_contents_id,
        url: page.url,
        title: page.title,
        visible: metadata.visible,
        destroyed: metadata.destroyed,
      };
    }),
    metrics: processMetrics,
    electronVersion,
    hookSnapshot,
  };
};

/** Apply an optional lifecycle deadline and caller cancellation to an operation. */
export const runWithExecutionLimits = async <Value>(
  operation: Promise<Value>,
  signal: AbortSignal | undefined,
  deadline?: number,
): Promise<Value> => {
  if (signal?.aborted === true)
    throw new BrowserObservationError(OPERATION, "cancelled");
  if (signal === undefined && deadline === undefined) return operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const interruptions: Promise<never>[] = [];
  if (deadline !== undefined)
    interruptions.push(
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BrowserObservationError(OPERATION, "timeout")),
          Math.max(1, deadline - Date.now()),
        );
      }),
    );
  if (signal !== undefined)
    interruptions.push(
      new Promise<never>((_, reject) => {
        abortListener = () =>
          reject(new BrowserObservationError(OPERATION, "cancelled"));
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    );
  try {
    return interruptions.length === 0
      ? await operation
      : await Promise.race([operation, ...interruptions]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined)
      signal?.removeEventListener("abort", abortListener);
  }
};

const safeActionErrorMessage = (cause: unknown): string => {
  return cause instanceof Error ? cause.message : "Electron action failed";
};
