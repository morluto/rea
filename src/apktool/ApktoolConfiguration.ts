import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { isAbsolute, win32 } from "node:path";
import { stat } from "node:fs/promises";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { ABORTED, waitForAbortable } from "../process/AbortablePromise.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";

import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import type { ProviderRejectionCode } from "../contracts/providerSelection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  isWindowsBatchFile,
  windowsBatchCommand,
  WindowsBatchCommandError,
} from "../process/WindowsBatchCommand.js";

/** Environment key selecting the caller's apktool launcher. */
export const APKTOOL_COMMAND_ENV = "REA_APKTOOL_COMMAND";

const VERSION_TIMEOUT_MS = 20_000;
const VERSION_MAX_OUTPUT_BYTES = 64 * 1024;

/** How the apktool launcher was selected for this provider instance. */
export interface ApktoolCommandSelection {
  readonly command: string;
  readonly commandSource: "environment" | "path";
}

/**
 * Preserve an explicit launcher, or resolve the default Windows command before
 * choosing native versus batch process creation. POSIX keeps execFile's PATH
 * lookup. The resolved selection is reused for the version and decode runs.
 */
export const resolveApktoolCommand = async (
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal,
): Promise<ApktoolCommandSelection> => {
  if (signal?.aborted === true)
    throw new AnalysisCancelledError("inspect_apktool_client");
  const selectedEnvironment = snapshotEnvironment(environment, platform);
  const configured = selectedEnvironment[APKTOOL_COMMAND_ENV];
  if (configured !== undefined && configured.trim() !== "") {
    if (
      !(platform === "win32"
        ? win32.isAbsolute(configured)
        : isAbsolute(configured))
    )
      throw new ApktoolConfigurationFailure(
        "not_absolute",
        `${APKTOOL_COMMAND_ENV} must be an absolute path to the apktool launcher`,
        { configured_command: configured },
      );
    return { command: configured, commandSource: "environment" };
  }
  if (platform !== "win32")
    return { command: "apktool", commandSource: "path" };
  const extensions = (selectedEnvironment.PATHEXT ?? ".EXE;.COM;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension !== "");
  for (const extension of extensions)
    if (!extension.startsWith(".") || /[\\/:\0]/u.test(extension))
      throw new ApktoolConfigurationFailure(
        "command_unresolved",
        "Windows PATHEXT must contain filename extensions, not paths",
        {
          selected_command: "apktool",
          command_source: "path",
          invalid_extension: extension,
        },
      );
  const directories = (selectedEnvironment.PATH ?? "")
    .split(";")
    .filter((directory) => directory !== "");
  if (selectedEnvironment.NODEFAULTCURRENTDIRECTORYINEXEPATH === undefined)
    directories.unshift(process.cwd());
  // A single deadline owns the whole PATH search, including filesystem waits.
  const deadline = new ProviderStartupDeadline(VERSION_TIMEOUT_MS, signal);
  const lookupInterruption = () =>
    deadline.interruption === "cancelled"
      ? new AnalysisCancelledError("inspect_apktool_client")
      : new AnalysisTimeoutError("inspect_apktool_client", VERSION_TIMEOUT_MS, {
          diagnostics: { phase: "windows_path_lookup" },
        });
  try {
    for (const entry of directories) {
      const directory =
        entry.startsWith('"') && entry.endsWith('"')
          ? entry.slice(1, -1)
          : entry;
      for (const extension of extensions) {
        if (deadline.interruption !== undefined) throw lookupInterruption();
        const candidate = win32.resolve(directory, `apktool${extension}`);
        try {
          const metadata = await waitForAbortable(
            stat(candidate),
            deadline.signal,
          );
          if (metadata === ABORTED || deadline.interruption !== undefined)
            throw lookupInterruption();
          if (metadata.isFile())
            return { command: candidate, commandSource: "path" };
        } catch (cause: unknown) {
          if (deadline.interruption !== undefined) throw lookupInterruption();
          const code =
            typeof cause === "object" && cause !== null
              ? Reflect.get(cause, "code")
              : undefined;
          if (code === "ENOENT" || code === "ENOTDIR") continue;
          throw new ApktoolConfigurationFailure(
            "command_unresolved",
            `The PATH-selected apktool launcher could not be inspected: ${candidate}`,
            {
              selected_command: "apktool",
              command_source: "path",
              candidate_path: candidate,
              ...(typeof code === "string" ? { filesystem_error: code } : {}),
            },
            { cause },
          );
        }
      }
    }
  } finally {
    deadline.dispose();
  }

  throw new ApktoolConfigurationFailure(
    "command_missing",
    "The apktool launcher was not found on the selected Windows PATH/PATHEXT",
    {
      selected_command: "apktool",
      command_source: "path",
      remediation: `Set ${APKTOOL_COMMAND_ENV} to an absolute apktool launcher, or add its directory and extension to PATH and PATHEXT`,
    },
  );
};

export type ApktoolConfigurationFailureCode =
  | "not_absolute"
  | "command_missing"
  | "command_unresolved"
  | "launcher_unsupported"
  | "version_unresolved";

export class ApktoolConfigurationFailure extends Error {
  constructor(
    readonly code: ApktoolConfigurationFailureCode,
    message: string,
    readonly diagnostics: Readonly<Record<string, JsonValue>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ApktoolClientIdentity {
  readonly version: string | null;
}

/** Process creation for one apktool run on the selected host. */
export interface ApktoolInvocation {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

/**
 * Run the selected launcher directly, or through cmd.exe when Windows can
 * only execute it there (the Chocolatey `apktool.bat` and `java -jar`
 * wrapper scripts). Throws WindowsBatchCommandError when a token cannot be
 * passed to cmd.exe safely.
 */
export const apktoolInvocation = (
  selection: ApktoolCommandSelection,
  arguments_: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): ApktoolInvocation =>
  platform === "win32" && isWindowsBatchFile(selection.command)
    ? {
        ...windowsBatchCommand({
          environment,
          batchPath: selection.command,
          arguments: arguments_,
        }),
        windowsVerbatimArguments: true,
      }
    : {
        command: selection.command,
        arguments: arguments_,
        windowsVerbatimArguments: false,
      };

/** Read the version from `apktool --version` output (first non-empty line). */
export const parseApktoolVersionOutput = (
  stdout: string,
): ApktoolClientIdentity => {
  const line = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  return { version: line === undefined ? null : line };
};

/** Probe the selected apktool launcher without decoding anything. */
export const inspectApktoolClient = async (
  selection: ApktoolCommandSelection,
  signal?: AbortSignal,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ApktoolClientIdentity> => {
  const hostEnvironment = snapshotEnvironment(environment, platform);
  let invocation: ApktoolInvocation;
  try {
    invocation = apktoolInvocation(
      selection,
      ["--version"],
      hostEnvironment,
      platform,
    );
  } catch (cause) {
    if (!(cause instanceof WindowsBatchCommandError)) throw cause;
    throw new ApktoolConfigurationFailure(
      "launcher_unsupported",
      `The selected apktool launcher cannot be run through cmd.exe: ${cause.message}`,
      {
        selected_command: selection.command,
        command_source: selection.commandSource,
        remediation: `Set ${APKTOOL_COMMAND_ENV} to a launcher path without cmd.exe metacharacters (" % ^ ! & | < >), or to a native apktool executable`,
      },
      { cause },
    );
  }
  try {
    const { stdout } = await execFileOutput(
      invocation.command,
      invocation.arguments,
      {
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        timeout: VERSION_TIMEOUT_MS,
        stopSignal: "SIGTERM",
        maxBuffer: VERSION_MAX_OUTPUT_BYTES,
        env: hostEnvironment,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return parseApktoolVersionOutput(stdout);
  } catch (cause) {
    const failure = execFileOutputFailure(cause);
    if (signal?.aborted || failure?.code === "ABORT_ERR")
      throw new AnalysisCancelledError("inspect_apktool_client", { cause });
    if (failure?.code === "ENOENT")
      throw new ApktoolConfigurationFailure(
        "command_missing",
        `The selected apktool launcher was not found: ${selection.command}`,
        {
          selected_command: selection.command,
          command_source: selection.commandSource,
          remediation: `Set ${APKTOOL_COMMAND_ENV} to an absolute apktool launcher (the upstream wrapper or a java -jar script)`,
        },
        { cause },
      );
    throw new ApktoolConfigurationFailure(
      "version_unresolved",
      "The selected apktool launcher did not report a usable version",
      {
        selected_command: selection.command,
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
  code: ApktoolConfigurationFailureCode,
): ProviderRejectionCode =>
  code === "command_missing"
    ? "executable_missing"
    : code === "not_absolute" ||
        code === "launcher_unsupported" ||
        code === "command_unresolved"
      ? "not_configured"
      : "version_unresolved";

export const apktoolConfigurationAvailability = (
  cause: ApktoolConfigurationFailure,
): ProviderAvailability =>
  ({
    status: "unavailable",
    code: rejectionCodeOf(cause.code),
    reason: cause.message,
    diagnostics: { ...cause.diagnostics },
  }) as ProviderAvailability;
