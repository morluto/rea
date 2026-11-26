import type { JsonValue } from "../domain/jsonValue.js";
import { utf8TailExcerpt } from "../domain/utf8Excerpt.js";
import {
  redactExplicitOutput,
  redactExplicitText,
} from "../domain/explicitSensitiveValues.js";
import type {
  ProviderProcessOutputSince,
  ProviderProcessSnapshot,
} from "../process/ProviderProcess.js";
import { runtimeExhaustion } from "../process/RuntimeExhaustion.js";
import type { GhidraLaunch } from "./GhidraLauncher.js";
import type { GhidraTransportKind } from "./GhidraTransport.js";

/** Aggregate in-memory retention budget for this provider's launcher output. */
export const GHIDRA_PROCESS_DIAGNOSTIC_BYTES = 8 * 1024 * 1024;

/**
 * Bytes of each retained stream an error carries: the latest output, where a
 * failure is reported. The 8 MiB retention stays for scanning, not delivery.
 */
export const GHIDRA_DIAGNOSTIC_EXCERPT_BYTES = 64 * 1024;
const LAUNCHER_LINE_CHARACTERS = 4096;

/** A rejected caller input owns request output, not the launcher's history. */
export type GhidraDiagnosticsScope = "session" | "request";

/** Inputs needed to project bounded diagnostics for one Ghidra runtime. */
export interface GhidraDiagnosticsOptions {
  readonly scope?: GhidraDiagnosticsScope;
  readonly targetPath: string;
  readonly targetSha256: string;
  readonly targetAdmission?: JsonValue;
  readonly transport: GhidraTransportKind;
  readonly providerVersion: string;
  readonly profileDigest: string;
  readonly runId?: string;
  readonly diagnosticsExportPath?: string;
  readonly runtimeRoot?: string;
  readonly socketRoot?: string;
  readonly endpointPath?: string;
  readonly launch?: GhidraLaunch;
  readonly snapshot?: ProviderProcessSnapshot;
  readonly token?: string;
  readonly previous: Readonly<Record<string, JsonValue>>;
  readonly failure_output?: JsonValue;
}

/** Preserve actionable runtime coordinates after cleanup and redact bearer data. */
export const createGhidraDiagnostics = (
  options: GhidraDiagnosticsOptions,
): Readonly<Record<string, JsonValue>> => {
  if (
    options.runtimeRoot === undefined &&
    options.launch === undefined &&
    Object.keys(options.previous).length > 0
  ) {
    const history: Record<string, JsonValue> = { ...options.previous };
    delete history.failure_output;
    if (options.scope === "request") {
      delete history.stdout;
      delete history.stderr;
      delete history.launch_support;
      history.diagnostic_scope = "request";
    }
    return history;
  }
  return {
    ...(options.scope === "request" ? { diagnostic_scope: "request" } : {}),
    target_path: options.targetPath,
    target_sha256: options.targetSha256,
    ...(options.targetAdmission === undefined
      ? {}
      : { target_admission: options.targetAdmission }),
    transport: options.transport,
    provider_version: options.providerVersion,
    profile_digest: options.profileDigest,
    ...(options.runId === undefined ? {} : { run_id: options.runId }),
    ...(options.diagnosticsExportPath === undefined
      ? {}
      : { diagnostics_export_path: options.diagnosticsExportPath }),
    ...(options.runtimeRoot === undefined
      ? {}
      : { runtime_root: options.runtimeRoot }),
    ...(options.socketRoot === undefined
      ? {}
      : { socket_root: options.socketRoot }),
    ...(options.endpointPath === undefined
      ? {}
      : { endpoint_path: options.endpointPath }),
    ...(options.launch === undefined
      ? {}
      : {
          project_root: options.launch.projectRoot,
          ghidra_log_path: options.launch.ghidraLogPath,
          script_log_path: options.launch.scriptLogPath,
          process_id: options.launch.process.pid ?? null,
          ...(options.scope === "request" ||
          options.launch.launchSupport === undefined
            ? {}
            : {
                launch_support: options.launch.launchSupport.map((output) => ({
                  ...output,
                })),
              }),
        }),
    ...(options.launch?.configuredMaxHeap === undefined
      ? {}
      : { configured_jvm_max_heap: options.launch.configuredMaxHeap }),
    ...(options.snapshot === undefined
      ? {}
      : {
          exit_code: options.snapshot.exitCode ?? null,
          exit_signal: options.snapshot.signal ?? null,
          stop_requested: options.snapshot.stopRequested === true,
          diagnostic_truncated: options.snapshot.diagnosticTruncated === true,
          output_incomplete: options.snapshot.outputIncomplete === true,
          ...(options.scope === "request"
            ? {}
            : {
                stdout: ghidraDiagnosticStream(
                  options.snapshot.stdout,
                  options.token,
                ),
                stderr: ghidraDiagnosticStream(
                  options.snapshot.stderr,
                  options.token,
                ),
              }),
        }),
    ...(options.failure_output === undefined
      ? {}
      : { failure_output: options.failure_output }),
  };
};

/**
 * Operation-scoped output, plus OOME lines observed after the checkpoint even
 * when the retention budget dropped them from the retained text.
 */
export const ghidraFailureOutput = (
  scoped: ProviderProcessOutputSince,
  token: string | undefined,
  drainIncomplete: boolean,
): JsonValue => ({
  stdout: ghidraDiagnosticStream(scoped.snapshot.stdout, token),
  stderr: ghidraDiagnosticStream(scoped.snapshot.stderr, token),
  complete: scoped.complete && !drainIncomplete,
  launcher_failures: observedLauncherFailures(scoped, token),
  observed_oome: (scoped.markers ?? []).map((marker) => {
    // The supervisor's runtime owns which memory area the line names.
    const { area } = runtimeExhaustion("jvm", marker.stream, marker);
    return {
      stream: marker.stream,
      offset: marker.offset,
      ...(area === undefined ? {} : { area }),
      // A cut line may end in a partial credential.
      line: redactExplicitText(
        marker.line,
        token === undefined ? [] : [token],
        {
          cutOff: marker.trailingContextIncomplete === true,
        },
      ),
      line_complete: marker.trailingContextIncomplete !== true,
      ...(marker.truncated ? { truncated: true } : {}),
      ...(marker.invalidUtf8 === true ? { invalid_utf8: true } : {}),
    };
  }),
});

/** Ghidra's headless refusal when `-process` names no program in the project. */
const GHIDRA_MISSING_PROGRAM = "Requested project program file(s) not found: ";

/**
 * The JVM's access-denied refusal to open `java_home.save` (Win32 error 5).
 * Only a line naming that file and the denial counts.
 */
const JAVA_HOME_SAVE_DENIED =
  /FileNotFoundException:\s*(.*?java_home\.save)\s*\(Access is denied\)/iu;

/** A launcher failure recognized in one output line, with that line as evidence. */
export type GhidraLauncherFailure =
  | {
      readonly kind: "missing_program";
      readonly stream: "stdout" | "stderr";
      readonly line: string;
      /** The text after Ghidra's refusal marker: the requested program list. */
      readonly requested: string;
    }
  | {
      readonly kind: "java_home_save_denied";
      readonly stream: "stdout" | "stderr";
      readonly line: string;
      readonly path: string;
    };

/**
 * Recognize a launcher failure in one line of output. This is the only parser
 * of these lines; error projection reads its facts, never the raw streams.
 */
export const ghidraLauncherFailure = (
  stream: "stdout" | "stderr",
  line: string,
): GhidraLauncherFailure | undefined => {
  const marker = line.indexOf(GHIDRA_MISSING_PROGRAM);
  if (marker !== -1)
    return {
      kind: "missing_program",
      stream,
      line,
      requested: line.slice(marker + GHIDRA_MISSING_PROGRAM.length),
    };
  const path = JAVA_HOME_SAVE_DENIED.exec(line)?.[1]?.trim();
  return path === undefined || path === ""
    ? undefined
    : { kind: "java_home_save_denied", stream, line, path };
};

/**
 * Whether a missing-program refusal names exactly the program REA passed to
 * `-process`, so a longer program name cannot be read as this refusal.
 */
export const ghidraMissingProgramNames = (
  failure: Extract<GhidraLauncherFailure, { kind: "missing_program" }>,
  programName: string,
): boolean =>
  failure.requested === programName ||
  failure.requested.startsWith(`${programName} `);

const LAUNCHER_FAILURE_LIMIT = Math.floor(
  GHIDRA_DIAGNOSTIC_EXCERPT_BYTES / LAUNCHER_LINE_CHARACTERS,
);

/**
 * Parse every retained, credential-redacted line once, before the streams are
 * cut to their delivered excerpt, and keep a bounded list of the failures.
 */
const observedLauncherFailures = (
  scoped: ProviderProcessOutputSince,
  token: string | undefined,
): JsonValue => {
  const failures: GhidraLauncherFailure[] = [];
  let truncated = false;
  for (const stream of ["stdout", "stderr"] as const) {
    const text = redactExplicitOutput(
      scoped.snapshot[stream],
      token === undefined ? [] : [token],
    );
    for (const line of text.split(/\r?\n/u)) {
      const failure = ghidraLauncherFailure(stream, line);
      if (failure === undefined) continue;
      if (
        line.length > LAUNCHER_LINE_CHARACTERS ||
        failures.length >= LAUNCHER_FAILURE_LIMIT
      ) {
        truncated = true;
        continue;
      }
      failures.push(failure);
    }
  }
  return { failures, truncated };
};

export const ghidraDiagnosticStream = (
  stream: ProviderProcessSnapshot["stdout"],
  token: string | undefined,
): JsonValue => {
  // Redact the whole retained text first, so the cut cannot expose part of a token.
  const excerpt = utf8TailExcerpt(
    redactExplicitOutput(stream, token === undefined ? [] : [token]),
    GHIDRA_DIAGNOSTIC_EXCERPT_BYTES,
  );
  return {
    text: excerpt.text,
    // Preserve the historical total-byte counter; text is now bounded separately.
    bytes: stream.observedBytes,
    retained_bytes: stream.bytes,
    ...(excerpt.truncated ? { text_bytes: excerpt.bytes } : {}),
    ...(stream.invalidUtf8 === true ? { invalid_utf8: true } : {}),
  };
};
