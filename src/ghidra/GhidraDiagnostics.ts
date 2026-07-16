import type { JsonValue } from "../domain/jsonValue.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import type { GhidraLaunch } from "./GhidraLauncher.js";

/** Inputs needed to project bounded diagnostics for one Ghidra runtime. */
export interface GhidraDiagnosticsOptions {
  readonly targetPath: string;
  readonly targetSha256: string;
  readonly providerVersion: string;
  readonly profileDigest: string;
  readonly runtimeRoot?: string;
  readonly launch?: GhidraLaunch;
  readonly snapshot?: ProviderProcessSnapshot;
  readonly token?: string;
  readonly previous: Readonly<Record<string, JsonValue>>;
}

/** Preserve actionable runtime coordinates after cleanup and redact bearer data. */
export const createGhidraDiagnostics = (
  options: GhidraDiagnosticsOptions,
): Readonly<Record<string, JsonValue>> => {
  if (
    options.runtimeRoot === undefined &&
    options.launch === undefined &&
    Object.keys(options.previous).length > 0
  )
    return options.previous;
  const redacted = (value: string): string =>
    options.token === undefined
      ? value
      : value.replaceAll(options.token, "[REDACTED]");
  return {
    target_path: options.targetPath,
    target_sha256: options.targetSha256,
    provider_version: options.providerVersion,
    profile_digest: options.profileDigest,
    ...(options.runtimeRoot === undefined
      ? {}
      : {
          runtime_root: options.runtimeRoot,
          socket_path: `${options.runtimeRoot}/bridge.sock`,
        }),
    ...(options.launch === undefined
      ? {}
      : {
          project_root: options.launch.projectRoot,
          ghidra_log_path: options.launch.ghidraLogPath,
          script_log_path: options.launch.scriptLogPath,
          process_id: options.launch.process.pid ?? null,
        }),
    ...(options.snapshot === undefined
      ? {}
      : {
          exit_code: options.snapshot.exitCode ?? null,
          exit_signal: options.snapshot.signal ?? null,
          stdout: boundedStream(options.snapshot.stdout, redacted),
          stderr: boundedStream(options.snapshot.stderr, redacted),
        }),
  };
};

const boundedStream = (
  stream: ProviderProcessSnapshot["stdout"],
  redact: (value: string) => string,
): JsonValue => ({
  text: redact(stream.text),
  bytes: stream.bytes,
  retained_bytes: stream.retainedBytes,
  truncated: stream.truncated,
});
