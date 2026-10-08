import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  nativeCallObservationInputSchema,
  nativeCallObservationResultSchema,
  type NativeCallObservationInput,
  type NativeCallObservationResult,
} from "../domain/native/nativeCallObservation.js";
import { err, ok, type Result } from "../domain/result.js";
import type { NativeCallTrace, NativeCallTracer } from "./LldbCallTracer.js";

const OPERATION = "observe_native_calls";

/** What every call observation leaves unobserved or approximated. */
export const NATIVE_CALL_OBSERVATION_LIMITATIONS = [
  "Only entries are observed; return values, floating-point and stack-passed arguments are not captured.",
  "Registers are the raw integer argument registers at entry. For Objective-C methods the first two hold the receiver and the selector.",
  "Receiver classes come from LLDB's Objective-C runtime reader without running target code; they are null for class methods and for receivers LLDB cannot classify.",
  "Calls that never reach a symbol's entry, such as inlined code or objc_direct methods called directly, are not observed.",
  "The target is launched directly under LLDB, not through LaunchServices; LLDB disables ASLR for it, so load addresses can equal file addresses.",
  "The observation window is checked about once a second, and recording pauses the process at every entry, which slows it.",
] as const;

/** Launch the active Mach-O under LLDB, record requested call entries, then stop it. */
export const observeNativeCalls = async (
  target: BinaryTarget,
  parameters: Readonly<Record<string, JsonValue>>,
  tracer: NativeCallTracer,
  signal?: AbortSignal,
  readTargetDigest: typeof fileSha256 = fileSha256,
): Promise<Result<NativeCallObservationResult, AnalysisError>> => {
  if (target.kind !== "executable" || target.format !== "mach-o")
    return err(
      new AnalysisCapabilityUnavailableError(
        "native-macos",
        OPERATION,
        "Native call observation launches a Mach-O executable; the active target is not one",
      ),
    );
  const parsed = nativeCallObservationInputSchema.safeParse(parameters);
  if (!parsed.success)
    return err(new AnalysisInputError(OPERATION, { cause: parsed.error }));
  // Observe the bytes the session's other Evidence describes.
  let digest: string;
  try {
    digest = await readTargetDigest(target.path, signal);
  } catch (cause: unknown) {
    if (signal?.aborted === true || isAbortError(cause))
      return err(new AnalysisCancelledError(OPERATION));
    return err(
      new ProviderAdapterError("native-macos", OPERATION, {
        diagnostics: {
          reason: "Unable to verify the selected target digest",
          detail: cause instanceof Error ? cause.message : String(cause),
        },
      }),
    );
  }
  if (digest !== target.sha256)
    return err(
      new EvidenceIntegrityError(
        "Native call observation target digest changed after session binding",
      ),
    );
  if (signal?.aborted === true)
    return err(new AnalysisCancelledError(OPERATION));
  const traced = await tracer.trace(
    {
      executable: target.path,
      architecture: target.architecture,
      expectedSha256: target.sha256,
      input: parsed.data,
    },
    signal,
  );
  if (!traced.ok) return traced;
  return ok(projectNativeCalls(target, parsed.data, traced.value));
};

const isAbortError = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === "AbortError";

/** Join the request, the tracer's run and REA's own checks into the result contract. */
export const projectNativeCalls = (
  target: Pick<BinaryTarget, "path" | "sha256"> & {
    readonly architecture: string;
  },
  input: NativeCallObservationInput,
  trace: NativeCallTrace,
): NativeCallObservationResult => {
  const { run } = trace;
  const unresolved = run.breakpoints
    .filter(({ location_count: count }) => count === 0)
    .map(({ index }) => index);
  const eventLimit = run.outcome === "event-limit";
  const resourceLimit = run.outcome === "resource-limit";
  const breakpointLocationLimit = run.breakpoint_locations_truncated === true;
  const partial =
    eventLimit ||
    resourceLimit ||
    breakpointLocationLimit ||
    run.outcome === "duration-elapsed" ||
    run.outcome === "stop-limit" ||
    unresolved.length > 0;
  return nativeCallObservationResultSchema.parse({
    target: {
      path: target.path,
      sha256: target.sha256,
      architecture: target.architecture,
      arguments: input.arguments,
      environment: input.environment,
      working_directory: input.working_directory ?? null,
      launch_identity: {
        loaded_image_sha256: run.target_identity.loaded_image_sha256,
        file_device: run.target_identity.file_device,
        file_inode: run.target_identity.file_inode,
        selected_file_sha256: run.target_identity.selected_file_sha256,
        module_path: run.target_identity.module_path,
        module_uuid: run.target_identity.module_uuid,
        stable: run.target_identity.stable,
      },
    },
    debugger: trace.debugger,
    process: {
      pid: run.pid,
      outcome: run.outcome,
      exit_status: run.exit_status,
      exit_description: run.exit_description,
      terminated: run.terminated && trace.terminated,
      elapsed_ms: run.elapsed_ms,
      stdout: trace.stdout,
      stderr: trace.stderr,
      other_stops: run.other_stops,
    },
    breakpoints: input.breakpoints.map((request, index) => ({
      index,
      request:
        request.kind === "function"
          ? { ...request, module: request.module ?? null }
          : { ...request, class_name: request.class_name ?? null },
      location_count: run.breakpoints[index]?.location_count ?? 0,
      locations: run.breakpoints[index]?.locations ?? [],
    })),
    events: run.events,
    coverage: {
      status: partial ? "partial" : "complete",
      event_limit_reached: eventLimit,
      resource_limit_reached: resourceLimit,
      ...(breakpointLocationLimit
        ? { breakpoint_locations_truncated: true }
        : {}),
      unresolved_breakpoints: unresolved,
    },
    limitations: [
      ...NATIVE_CALL_OBSERVATION_LIMITATIONS,
      "The selected pathname digest and LLDB module identity are checked around launch. No immutable executable snapshot is used; concurrent in-place mutation or replacement and restoration cannot be ruled out, so the loaded-image digest remains unknown.",
      ...(eventLimit
        ? [
            `Observation stopped at max_events (${input.max_events}); later calls were not recorded and the process was killed.`,
          ]
        : []),
      ...(resourceLimit
        ? [
            "Observation stopped before retaining the next complete event because the estimated 8 MiB trace-payload or 65,536-frame aggregate budget was reached; the process was killed.",
          ]
        : []),
      ...(run.outcome === "duration-elapsed"
        ? [
            `The process was still running after duration_ms (${input.duration_ms}) and was killed.`,
          ]
        : []),
      ...(run.target_identity.stable
        ? []
        : [
            "LLDB did not provide enough module identity evidence to confirm pathname and module continuity around launch.",
          ]),
      ...(run.outcome === "stop-limit"
        ? [
            "Observation stopped after repeated signal or exception stops; the process was killed.",
          ]
        : []),
      ...(unresolved.length === 0
        ? []
        : [
            `Breakpoints ${unresolved.join(", ")} matched no code in any image loaded while observing; their calls could not be observed.`,
          ]),
      ...(run.breakpoints.some(
        ({ location_count: count, locations }) => locations.length < count,
      )
        ? [
            "Breakpoints with many matching locations list only the first 64; location_count gives the total.",
          ]
        : []),
      ...(breakpointLocationLimit
        ? [
            "Resolved breakpoint locations exceeded the aggregate 8 MiB metadata budget; omitted locations are counted in location_count. This metadata limit does not change the process outcome.",
          ]
        : []),
      ...(trace.stdout.truncated || trace.stderr.truncated
        ? ["Target output beyond 1 MiB per stream is counted but not kept."]
        : []),
      ...(!trace.stdout.complete || !trace.stderr.complete
        ? [
            "Target output draining did not complete; reported byte counts are observed lower bounds, not stream totals.",
          ]
        : []),
      ...(run.terminated && trace.terminated
        ? []
        : [
            `REA could not confirm that process ${run.pid} exited; check for it before relying on host state.`,
          ]),
    ],
  });
};

const fileSha256 = async (
  path: string,
  signal?: AbortSignal,
): Promise<string> => {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = new Uint8Array(1024 * 1024);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};
