import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../ports/AnalysisProvider.js";
import {
  adbDisplayPartialObservationSchema,
  type AdbDisplayNumericIssues,
  type AdbDisplayPartialObservation,
  type AdbRequest,
} from "../domain/adb/adbDeviceAnalysis.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisProtocolError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import { adbArguments, runAdbCapture } from "./AdbCommand.js";
import type { AdbCommandContext } from "./AdbDeviceOperations.js";
import { parsePackageListOutput } from "./AdbDeviceOutput.js";
import {
  ADB_DIRECTORY_BATCH_SCRIPT,
  parseAdbDirectoryListing,
} from "./AdbDirectoryListing.js";
import { collectNumericIssues } from "./AdbNumericIssues.js";
import {
  pageListingItems,
  parsedListingExecution,
} from "./AdbOperationResults.js";
import {
  parseDumpsysPackageOutput,
  parseFeatureListOutput,
  parseProcessListOutput,
  parseServiceListOutput,
  parseSettingsGetOutput,
  parseWindowFocusOutput,
  parseWmDensityOutput,
  parseWmSizeOutput,
} from "./AdbShellOutput.js";

const SHELL_TIMEOUT_MS = 30_000;
const PACKAGE_LIST_TIMEOUT_MS = 60_000;
const PACKAGE_LIST_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const LOGCAT_TIMEOUT_MS = 60_000;
const LOGCAT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DUMPSYS_PACKAGE_TIMEOUT_MS = 60_000;
const DUMPSYS_PACKAGE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DUMPSYS_WINDOW_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const LISTING_TIMEOUT_MS = 30_000;
const LISTING_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SETTINGS_TIMEOUT_MS = 20_000;
const SETTINGS_MAX_OUTPUT_BYTES = 1024 * 1024;

type AdbRequestOf<Operation extends AdbRequest["operation"]> = Extract<
  AdbRequest,
  { operation: Operation }
>;

type AdbOperationContext<Operation extends AdbRequest["operation"]> = Omit<
  AdbCommandContext,
  "operation" | "request"
> & {
  readonly operation: Operation;
  readonly request: AdbRequestOf<Operation>;
};

export const listAdbPackagesOperation = async ({
  request,
  client,
  provider,
  shell,
}: AdbOperationContext<"list_adb_packages">): Promise<
  Result<AnalysisExecution, AnalysisError>
> => {
  const scopeFlag =
    request.input.scope === "third_party"
      ? "-3"
      : request.input.scope === "system"
        ? "-s"
        : null;
  const ran = await shell(
    [
      "pm",
      "list",
      "packages",
      "-f",
      ...(scopeFlag === null ? [] : [scopeFlag]),
    ],
    {
      timeoutMs: PACKAGE_LIST_TIMEOUT_MS,
      maxOutputBytes: PACKAGE_LIST_MAX_OUTPUT_BYTES,
    },
  );
  if (!ran.ok) return ran;
  const { packages, unparsedLines } = parsePackageListOutput(ran.value.stdout);
  const page = pageListingItems(packages, "packages", request.input);
  return ok(
    parsedListingExecution(
      {
        client,
        serial: request.input.serial,
        scope: request.input.scope,
        packages: page.items,
      },
      unparsedLines,
      provider,
      [
        "base_apk_device_path is a device filesystem path, not a host-local path",
        ...page.limitations,
      ],
      page.truncated,
    ),
  );
};

export const readAdbLogcatOperation = async ({
  request,
  client,
  provider,
  shell,
}: AdbOperationContext<"read_adb_logcat">): Promise<
  Result<AnalysisExecution, AnalysisError>
> => {
  const ran = await shell(
    [
      "logcat",
      "-d",
      "-b",
      request.input.buffer,
      "-t",
      String(request.input.count),
      ...(request.input.pid === undefined
        ? []
        : ["--pid", String(request.input.pid)]),
    ],
    {
      timeoutMs: LOGCAT_TIMEOUT_MS,
      maxOutputBytes: LOGCAT_MAX_OUTPUT_BYTES,
    },
  );
  if (!ran.ok) return ran;
  const lines = ran.value.stdout.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const bounded = lines.slice(-request.input.count);
  return ok(
    createAnalysisExecution(
      {
        client,
        serial: request.input.serial,
        count: request.input.count,
        buffer: request.input.buffer,
        pid: request.input.pid ?? null,
        lines: bounded,
        total_bytes: ran.value.stdoutBytes,
        coverage:
          bounded.length !== lines.length ||
          bounded.length === request.input.count
            ? "partial"
            : "complete",
      },
      provider,
      {
        limitations: [
          "Reads a bounded dump (logcat -d); the newest lines are kept when the count cap trims",
          "coverage is partial when the requested count or capture budget truncated the dump",
        ],
      },
    ),
  );
};

export const inspectAdbPackageOperation = async ({
  operation,
  request,
  client,
  provider,
  shell,
}: AdbOperationContext<"inspect_adb_package">): Promise<
  Result<AnalysisExecution, AnalysisError>
> => {
  const ran = await shell(["dumpsys", "package", request.input.package], {
    timeoutMs: DUMPSYS_PACKAGE_TIMEOUT_MS,
    maxOutputBytes: DUMPSYS_PACKAGE_MAX_OUTPUT_BYTES,
  });
  if (!ran.ok) return ran;
  const stdout = ran.value.stdout;
  if (/Unable to find package:/u.test(stdout) || stdout.trim() === "")
    return err(
      new AnalysisUnsupportedTargetError(
        operation,
        request.input.serial,
        `Package Manager did not report details for ${request.input.package}; it may not be installed for user 0`,
      ),
    );
  const details = parseDumpsysPackageOutput(stdout);
  return ok(
    createAnalysisExecution(
      {
        client,
        serial: request.input.serial,
        package_name: request.input.package,
        version_name: details.versionName,
        version_code: details.versionCode,
        first_install_time: details.firstInstallTime,
        last_update_time: details.lastUpdateTime,
        installer_package_name: details.installerPackageName,
        user_id: details.userId,
        pkg_flags: details.pkgFlags,
        requested_permissions_count: details.requestedPermissions,
        numeric_issues: details.numericIssues,
        coverage:
          details.numericIssues.total > 0 ||
          details.requestedPermissions === null ||
          (details.versionCode === null && details.versionName === null)
            ? "partial"
            : "complete",
      },
      provider,
      {
        limitations: [
          "Fields are a fixed projection of dumpsys package output; version-dependent sections are ignored rather than guessed",
          "requested_permissions_count counts the listed requested permissions section; an absent section is zero only when dumpsys confirms a loaded parsed package",
          "A null requested_permissions_count means dumpsys reported pkg=null or did not establish that an omitted permission section is an empty inventory",
        ],
      },
    ),
  );
};

export const listAdbProcessesOperation = async ({
  request,
  client,
  provider,
  shell,
}: AdbOperationContext<"list_adb_processes">): Promise<
  Result<AnalysisExecution, AnalysisError>
> => {
  const ran = await shell(["ps", "-A"], {
    timeoutMs: LISTING_TIMEOUT_MS,
    maxOutputBytes: LISTING_MAX_OUTPUT_BYTES,
  });
  if (!ran.ok) return ran;
  const { columns, processes, unparsedLines } = parseProcessListOutput(
    ran.value.stdout,
  );
  const page = pageListingItems(processes, "processes", request.input);
  return ok(
    parsedListingExecution(
      {
        client,
        serial: request.input.serial,
        columns,
        processes: page.items,
      },
      unparsedLines,
      provider,
      page.limitations,
      page.truncated,
    ),
  );
};

export const listAdbDirectoryOperation = async ({
  operation,
  request,
  selection,
  client,
  provider,
  signal,
}: AdbOperationContext<"list_adb_directory">): Promise<
  Result<AnalysisExecution, AnalysisError>
> => {
  const ran = await runAdbCapture(
    operation,
    { device: request.input.serial, path: request.input.device_path },
    selection,
    adbArguments(request.input.serial, [
      "shell",
      "sh",
      "-c",
      'cd "$1" || exit\nexec find . -mindepth 1 -maxdepth 1 -exec sh -c "$2" rea-list-directory {} +',
      "rea-list-directory",
      request.input.device_path,
      ADB_DIRECTORY_BATCH_SCRIPT,
    ]),
    {
      timeoutMs: LISTING_TIMEOUT_MS,
      maxOutputBytes: LISTING_MAX_OUTPUT_BYTES,
      volatileOutput: true,
    },
    signal,
  );
  if (!ran.ok) return ran;
  const { entries, unparsedLines } = parseAdbDirectoryListing(ran.value.stdout);
  const page = pageListingItems(entries, "directory entries", request.input);
  return ok(
    parsedListingExecution(
      {
        client,
        serial: request.input.serial,
        device_path: request.input.device_path,
        entries: page.items,
      },
      unparsedLines,
      provider,
      [
        "Entry kinds derive from stat permission mode; directory contents and link targets may change during capture",
        ...page.limitations,
      ],
      page.truncated,
    ),
  );
};

export const listAdbFeaturesOperation = async ({
  request,
  client,
  provider,
  shell,
}: AdbOperationContext<"list_adb_features">): Promise<
  Result<AnalysisExecution, AnalysisError>
> => {
  const ran = await shell(["pm", "list", "features"], {
    timeoutMs: LISTING_TIMEOUT_MS,
    maxOutputBytes: LISTING_MAX_OUTPUT_BYTES,
  });
  if (!ran.ok) return ran;
  const { features, unparsedLines } = parseFeatureListOutput(ran.value.stdout);
  const page = pageListingItems(features, "features", request.input);
  return ok(
    parsedListingExecution(
      { client, serial: request.input.serial, features: page.items },
      unparsedLines,
      provider,
      page.limitations,
      page.truncated,
    ),
  );
};

export const listAdbServicesOperation = async ({
  request,
  client,
  provider,
  shell,
}: AdbOperationContext<"list_adb_services">): Promise<
  Result<AnalysisExecution, AnalysisError>
> => {
  const ran = await shell(["service", "list"], {
    timeoutMs: LISTING_TIMEOUT_MS,
    maxOutputBytes: LISTING_MAX_OUTPUT_BYTES,
  });
  if (!ran.ok) return ran;
  const { services, unparsedLines } = parseServiceListOutput(ran.value.stdout);
  const page = pageListingItems(services, "services", request.input);
  return ok(
    parsedListingExecution(
      { client, serial: request.input.serial, services: page.items },
      unparsedLines,
      provider,
      page.limitations,
      page.truncated,
    ),
  );
};

export const inspectAdbDisplayOperation = async ({
  request,
  client,
  provider,
  shell,
}: AdbOperationContext<"inspect_adb_display">): Promise<
  Result<AnalysisExecution, AnalysisError>
> => {
  const size = await shell(["wm", "size"], {
    timeoutMs: SETTINGS_TIMEOUT_MS,
    maxOutputBytes: SETTINGS_MAX_OUTPUT_BYTES,
  });
  if (!size.ok) return size;
  const density = await shell(["wm", "density"], {
    timeoutMs: SETTINGS_TIMEOUT_MS,
    maxOutputBytes: SETTINGS_MAX_OUTPUT_BYTES,
  });
  if (!density.ok) return density;
  const parsedSize = parseWmSizeOutput(size.value.stdout);
  const parsedDensity = parseWmDensityOutput(density.value.stdout);
  const issues =
    collectNumericIssues<AdbDisplayNumericIssues["sample"][number]>();
  issues.append(parsedSize.numericIssues);
  issues.append(parsedDensity.numericIssues);
  const numericIssues = issues.facts();
  const displayFacts = {
    client,
    serial: request.input.serial,
    override_size: parsedSize.override,
    physical_density: parsedDensity.physical,
    override_density: parsedDensity.override,
    numeric_issues: numericIssues,
  };
  if (parsedSize.physical === null) {
    const reason = parsedSize.physicalDeclared
      ? "physical_size_malformed"
      : "physical_size_absent";
    const partialObservation: AdbDisplayPartialObservation =
      adbDisplayPartialObservationSchema.parse({
        provider_id: "adb",
        operation: "inspect_adb_display",
        reason,
        result: {
          ...displayFacts,
          physical_size: null,
          coverage: "partial",
        },
      });
    return err(
      new AnalysisProtocolError(
        parsedSize.physicalDeclared
          ? "wm size reported a malformed physical size"
          : "wm size did not report a physical size; the build may use an unsupported format",
        { partialObservation },
      ),
    );
  }
  return ok(
    createAnalysisExecution(
      {
        ...displayFacts,
        physical_size: parsedSize.physical,
        coverage:
          numericIssues.total > 0 || parsedDensity.physical === null
            ? "partial"
            : "complete",
      },
      provider,
      {
        limitations: [
          "Override fields are null when no declaration was reported or its value was malformed; numeric_issues retains malformed declarations",
        ],
      },
    ),
  );
};

export const inspectAdbWindowOperation = async ({
  request,
  client,
  provider,
  shell,
}: AdbOperationContext<"inspect_adb_window">): Promise<
  Result<AnalysisExecution, AnalysisError>
> => {
  let section: "windows" | "displays" = "windows";
  const ran = await shell(["dumpsys", "window", section], {
    timeoutMs: SHELL_TIMEOUT_MS,
    maxOutputBytes: DUMPSYS_WINDOW_MAX_OUTPUT_BYTES,
  });
  if (!ran.ok) return ran;
  let focus = parseWindowFocusOutput(ran.value.stdout);
  if (focus.focus_summary === "unavailable") {
    section = "displays";
    const fallback = await shell(["dumpsys", "window", section], {
      timeoutMs: SHELL_TIMEOUT_MS,
      maxOutputBytes: DUMPSYS_WINDOW_MAX_OUTPUT_BYTES,
    });
    if (!fallback.ok) return fallback;
    focus = parseWindowFocusOutput(fallback.value.stdout);
  }
  const declared = focus.focus_summary !== "unavailable";
  return ok(
    createAnalysisExecution(
      {
        client,
        serial: request.input.serial,
        source_section: section,
        ...focus,
      },
      provider,
      {
        limitations: [
          "Focus values are the window manager's declarations at read time; no interaction occurred",
          declared
            ? `Focus declarations were read from \`dumpsys window ${section}\``
            : "Neither `dumpsys window windows` nor `dumpsys window displays` declared mCurrentFocus or mFocusedApp; focus is unknown, not absent",
          ...(focus.focus_summary === "ambiguous"
            ? [
                "Multiple focus contexts or repeated declarations prevent a singular focus summary; inspect focus_contexts for every declaration",
              ]
            : []),
        ],
      },
    ),
  );
};

export const readAdbSettingOperation = async ({
  request,
  client,
  provider,
  shell,
}: AdbOperationContext<"read_adb_setting">): Promise<
  Result<AnalysisExecution, AnalysisError>
> => {
  const ran = await shell(
    ["settings", "get", request.input.namespace, request.input.key],
    {
      timeoutMs: SETTINGS_TIMEOUT_MS,
      maxOutputBytes: SETTINGS_MAX_OUTPUT_BYTES,
    },
  );
  if (!ran.ok) return ran;
  const { value, deviceReportedNull } = parseSettingsGetOutput(
    ran.value.stdout,
  );
  return ok(
    createAnalysisExecution(
      {
        client,
        serial: request.input.serial,
        namespace: request.input.namespace,
        key: request.input.key,
        value,
        device_reported_null: deviceReportedNull,
      },
      provider,
      {
        limitations: [
          "Android prints the literal string null for absent keys; that is reported as a device-side null observation",
        ],
      },
    ),
  );
};

export const resolveAdbPackagesOperation = async ({
  request,
  client,
  provider,
  shell,
}: AdbOperationContext<"resolve_adb_packages">): Promise<
  Result<AnalysisExecution, AnalysisError>
> => {
  const ran = await shell(["pm", "list", "packages", "-f"], {
    timeoutMs: PACKAGE_LIST_TIMEOUT_MS,
    maxOutputBytes: PACKAGE_LIST_MAX_OUTPUT_BYTES,
  });
  if (!ran.ok) return ran;
  const { packages, unparsedLines } = parsePackageListOutput(ran.value.stdout);
  const needle = request.input.query.toLowerCase();
  const matches = packages.filter((entry) =>
    entry.package_name.toLowerCase().includes(needle),
  );
  return ok(
    parsedListingExecution(
      {
        client,
        serial: request.input.serial,
        query: request.input.query,
        matches,
        exact_match:
          matches.length === 1 &&
          matches[0]!.package_name.toLowerCase() === needle,
      },
      unparsedLines,
      provider,
      [
        "Matching is a case-insensitive substring over package names; application display labels are not part of pm output",
      ],
    ),
  );
};
