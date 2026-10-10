import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import {
  nativeUiObservationInputSchema,
  nativeUiScenarioInputSchema,
  nativeUiSnapshotSchema,
  nativeUiResultSchema,
} from "../domain/native/nativeUiObservation.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  createNativeUiHelperRuntime,
  type NativeUiHelperRuntime,
} from "./NativeUiHelperRuntime.js";
import {
  NATIVE_UI_OUTPUT_BUDGET_BYTES,
  NATIVE_UI_OUTPUT_WEIGHT,
} from "./NativeUiOutputBudget.js";

const helper = fileURLToPath(
  new URL("../../bridge/native/ReaNativeUI.swift", import.meta.url),
);
const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: nativeUiSnapshotSchema }),
  z.strictObject({
    ok: z.literal(false),
    code: z.string(),
    message: z.string(),
  }),
]);
/** Narrow process seam preserves the native helper's OS and target failures. */
export type NativeUiHelper = (
  parameters: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Capture a selected existing app window and run explicitly selected scenarios. */
export const observeNativeUi = async (
  target: BinaryTarget,
  operation: "observe_native_ui" | "capture_native_ui_scenario",
  parameters: unknown,
  options: {
    environment: Readonly<NodeJS.ProcessEnv>;
    signal?: AbortSignal | undefined;
    invoke?: NativeUiHelper;
    runtime?: NativeUiHelperRuntime;
  },
): Promise<Result<z.infer<typeof nativeUiResultSchema>, AnalysisError>> => {
  const runtime =
    options.runtime ?? createNativeUiHelperRuntime(options.environment);
  try {
    return await observeWithHelper(target, operation, parameters, {
      ...options,
      invoke: options.invoke ?? runtime.invoke,
    });
  } finally {
    if (options.runtime === undefined) await runtime.close();
  }
};

const observeWithHelper = async (
  target: BinaryTarget,
  operation: "observe_native_ui" | "capture_native_ui_scenario",
  parameters: unknown,
  options: { signal?: AbortSignal | undefined; invoke: NativeUiHelper },
): Promise<Result<z.infer<typeof nativeUiResultSchema>, AnalysisError>> => {
  const parsed = (
    operation === "observe_native_ui"
      ? nativeUiObservationInputSchema
      : nativeUiScenarioInputSchema
  ).safeParse(parameters);
  if (!parsed.success)
    return err(new AnalysisInputError(operation, { cause: parsed.error }));
  if (target.kind !== "executable" || target.format !== "mach-o")
    return err(
      new AnalysisCapabilityUnavailableError(
        "native-macos",
        operation,
        "Native UI observation requires an active Mach-O executable or app target",
      ),
    );
  const input = parsed.data;
  if (!input.screenshot && !input.accessibility)
    return err(
      new AnalysisInputError(operation, {
        cause: new Error("Enable screenshot or accessibility capture"),
      }),
    );
  const steps =
    operation === "capture_native_ui_scenario"
      ? nativeUiScenarioInputSchema.parse(parameters).steps
      : [];
  const signal =
    options.signal === undefined
      ? AbortSignal.timeout(180_000)
      : AbortSignal.any([options.signal, AbortSignal.timeout(180_000)]);
  const invoke = options.invoke;
  let launchTime: number | undefined;
  let outputBytes = 0;
  const take = async (
    action?: unknown,
  ): Promise<Result<z.infer<typeof nativeUiSnapshotSchema>, AnalysisError>> => {
    if (signal.aborted) return err(new AnalysisCancelledError(operation));
    try {
      const response = responseSchema.parse(
        await invoke(
          {
            pid: input.pid,
            window_id: input.window_id,
            executable: target.path,
            sha256: target.sha256,
            ...(launchTime === undefined ? {} : { launch_time: launchTime }),
            screenshot: input.screenshot,
            accessibility: input.accessibility,
            max_nodes: input.max_nodes,
            ...(action === undefined ? {} : { action }),
          },
          signal,
        ),
      );
      if (!response.ok)
        return err(
          new AnalysisCapabilityUnavailableError(
            "native-macos",
            operation,
            `${response.code}: ${response.message}`,
          ),
        );
      if (
        response.result.window.pid !== input.pid ||
        response.result.window.window_id !== input.window_id ||
        response.result.window.executable !== target.path ||
        (launchTime !== undefined &&
          response.result.window.launch_time !== launchTime)
      )
        return err(
          new AnalysisCapabilityUnavailableError(
            "native-macos",
            operation,
            "Native helper returned a different target process or window",
          ),
        );
      launchTime = response.result.window.launch_time;
      outputBytes +=
        NATIVE_UI_OUTPUT_WEIGHT *
        Buffer.byteLength(JSON.stringify(response.result));
      if (outputBytes > NATIVE_UI_OUTPUT_BUDGET_BYTES)
        return err(
          new AnalysisCapabilityUnavailableError(
            "native-macos",
            operation,
            "Scenario captures exceeded the 64 MiB output budget",
          ),
        );
      return ok(response.result);
    } catch (cause) {
      return err(
        signal.aborted
          ? new AnalysisCancelledError(operation)
          : new ProviderAdapterError("native-macos", operation, {
              cause,
              diagnostics: {
                helper_path: helper,
                reason: cause instanceof Error ? cause.message : String(cause),
                remediation:
                  "Native helper failed, timed out, or returned malformed capture data; install compatible Xcode command-line tools and inspect local OS permissions",
              },
            }),
      );
    }
  };
  const initial = await take();
  if (!initial.ok) return initial;
  const results: z.infer<typeof nativeUiResultSchema>["steps"] = [];
  let before = initial.value;
  for (const [index, step] of steps.entries()) {
    if (signal.aborted) {
      results.push({
        index,
        kind: step.kind,
        before,
        after: null,
        outcome: "cancelled",
        reason: "Scenario cancelled before action",
      });
      break;
    }
    if (step.kind === "wait") {
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new Error("cancelled"));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, step.milliseconds);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      } catch (cause: unknown) {
        // Cancellation is recorded as a cancelled outcome.
        void cause;
        results.push({
          index,
          kind: step.kind,
          before,
          after: null,
          outcome: "cancelled",
          reason: "Scenario cancelled during wait",
        });
        break;
      }
    }
    const after = await take(step.kind === "wait" ? undefined : step);
    if (!after.ok) {
      results.push({
        index,
        kind: step.kind,
        before,
        after: null,
        outcome:
          after.error._tag === "AnalysisCancelledError"
            ? "cancelled"
            : "failed",
        reason: after.error.message,
      });
      break;
    }
    results.push({
      index,
      kind: step.kind,
      before,
      after: after.value,
      outcome: "completed",
      reason: null,
    });
    before = after.value;
  }
  return ok(
    nativeUiResultSchema.parse({
      target_sha256: target.sha256,
      initial: initial.value,
      steps: results,
      restore: "leave-as-is",
      limitations: [
        "Only the explicitly selected already-running process/window is admitted. REA starts no target process and does not change permissions, foreground applications, or restore application data.",
        "Click uses AXPress; scroll uses AXIncrement/AXDecrement; key-entry sets the selected element's AXValue. Unsupported elements fail without global event fallback.",
        "Each completed action is followed immediately by capture; delayed UI changes require explicit wait steps. A failed after-capture can follow a completed action, so failure does not prove absence of application effects.",
        "Scenarios can change app data, cause app network activity and persist changes. The caller explicitly chooses leave-as-is; automatic restoration is unsupported.",
        "Window matching uses exact PID and window ID for screenshots and unique accessibility geometry. Accessibility paths can change as the UI changes; stale or ambiguous paths fail. Screenshots are scaled to at most 2048 pixels; scenario output is budgeted at 64 MiB and execution is cancelled after 180 seconds.",
      ],
    }),
  );
};
