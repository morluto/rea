import { isAbsolute } from "node:path";

import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import type { ProviderRejectionCode } from "../contracts/providerSelection.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Environment key selecting the caller's adb binary. */
export const ADB_BINARY_ENV = "REA_ADB_PATH";

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_MAX_OUTPUT_BYTES = 64 * 1024;

/** How the adb binary was selected for this provider instance. */
export interface AdbBinarySelection {
  readonly binary: string;
  readonly pathSource: "environment" | "path";
}

/**
 * Resolve the caller-supplied adb binary. `REA_ADB_PATH` must be absolute so
 * the selection stays explicit; without it, adb is resolved from `PATH` by
 * the platform exec at run time, like any bring-your-own tool.
 */
export const resolveAdbBinary = (
  environment: Readonly<Record<string, string | undefined>>,
): AdbBinarySelection => {
  const configured = environment[ADB_BINARY_ENV];
  if (configured === undefined || configured.trim() === "")
    return { binary: "adb", pathSource: "path" };
  if (!isAbsolute(configured))
    throw new AdbConfigurationFailure(
      "not_absolute",
      `${ADB_BINARY_ENV} must be an absolute path to the adb binary`,
      { configured_path: configured },
    );
  return { binary: configured, pathSource: "environment" };
};

export type AdbConfigurationFailureCode =
  | "not_absolute"
  | "binary_missing"
  | "version_unresolved";

export class AdbConfigurationFailure extends Error {
  constructor(
    readonly code: AdbConfigurationFailureCode,
    message: string,
    readonly diagnostics: Readonly<Record<string, JsonValue>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface AdbClientIdentity {
  readonly version: string | null;
  readonly installedPath: string | null;
}

/**
 * Parse `adb version` output. The first line carries the protocol version,
 * `Version ` the build version (no colon), and `Installed as` the binary path.
 */
export const parseAdbVersionOutput = (stdout: string): AdbClientIdentity => {
  const build = /^Version\s+(\S.*)$/mu.exec(stdout);
  const installed = /^Installed as\s+(.+)$/mu.exec(stdout);
  return {
    version: build === null ? null : build[1]!.trim(),
    installedPath: installed === null ? null : installed[1]!.trim(),
  };
};

/**
 * Probe the selected adb binary without contacting devices. `adb version`
 * never starts the adb server, so this stays a pure client check.
 */
export const inspectAdbClient = async (
  selection: AdbBinarySelection,
  signal?: AbortSignal,
): Promise<AdbClientIdentity> => {
  try {
    const { stdout } = await execFileOutput(selection.binary, ["version"], {
      timeout: VERSION_TIMEOUT_MS,
      maxBuffer: VERSION_MAX_OUTPUT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    return parseAdbVersionOutput(stdout);
  } catch (cause) {
    const failure = execFileOutputFailure(cause);
    if (failure?.code === "ENOENT")
      throw new AdbConfigurationFailure(
        "binary_missing",
        `The selected adb binary was not found: ${selection.binary}`,
        {
          selected_binary: selection.binary,
          path_source: selection.pathSource,
          remediation: `Set ${ADB_BINARY_ENV} to an absolute path to an existing adb binary`,
        },
        { cause },
      );
    throw new AdbConfigurationFailure(
      "version_unresolved",
      "The selected adb binary did not report a usable version",
      {
        selected_binary: selection.binary,
        ...(failure === undefined
          ? {}
          : {
              exit_code: failure.code,
              stderr_excerpt: failure.stderr.slice(0, 512),
            }),
      },
      { cause },
    );
  }
};

/** Availability in the shape shared by every provider. */
const rejectionCodeOf = (
  code: AdbConfigurationFailureCode,
): ProviderRejectionCode =>
  code === "binary_missing"
    ? "executable_missing"
    : code === "not_absolute"
      ? "not_configured"
      : "version_unresolved";

export const adbConfigurationAvailability = (
  cause: AdbConfigurationFailure,
): ProviderAvailability =>
  ({
    status: "unavailable",
    code: rejectionCodeOf(cause.code),
    reason: cause.message,
    diagnostics: { ...cause.diagnostics },
  }) as ProviderAvailability;
