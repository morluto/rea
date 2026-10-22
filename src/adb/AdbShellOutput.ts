import type {
  AdbWindowFocusContext,
  AdbWindowFocusObservation,
} from "../domain/adb/adbDeviceAnalysis.js";
import {
  collectUnparsedLines,
  type AdbUnparsedLines,
} from "./AdbUnparsedLines.js";

/**
 * Parsers for fixed observation commands REA runs through `adb shell`.
 *
 * Formats follow toybox output on Android 8+ (verified against an Android 14
 * emulator). Unparseable lines are sampled and counted rather than dropped so
 * callers can see the format drift instead of silently losing rows.
 */

export interface AdbProcessEntry {
  readonly user: string;
  readonly pid: number;
  readonly ppid: number | null;
  readonly rss: number | null;
  readonly state: string | null;
  readonly name: string;
}

const PROCESS_LINE =
  /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/u;

/** Parse `ps -A` output; the header line is preserved verbatim as `columns`. */
export const parseProcessListOutput = (
  stdout: string,
): {
  columns: string | null;
  processes: readonly AdbProcessEntry[];
  unparsedLines: AdbUnparsedLines;
} => {
  const processes: AdbProcessEntry[] = [];
  const unparsed = collectUnparsedLines();
  let columns: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    if (/^USER\s+PID\s+PPID\b/u.test(line)) {
      columns = line.trim();
      continue;
    }
    const match = PROCESS_LINE.exec(line);
    if (match === null) {
      unparsed.add(line);
      continue;
    }
    processes.push({
      user: match[1]!,
      pid: Number(match[2]!),
      ppid: Number.isSafeInteger(Number(match[3]!)) ? Number(match[3]!) : null,
      rss: Number.isSafeInteger(Number(match[5]!)) ? Number(match[5]!) : null,
      state: match[8]!,
      name: match[9]!.trim(),
    });
  }
  return { columns, processes, unparsedLines: unparsed.facts() };
};

export interface AdbFeatureEntry {
  readonly name: string;
  readonly version: number | null;
}

const FEATURE_LINE = /^feature:([^=\s]+)(?:=(0x[0-9a-fA-F]+|\d+))?$/u;

const parseFeatureVersion = (text: string): number =>
  text.startsWith("0x") ? Number.parseInt(text.slice(2), 16) : Number(text);

/** Parse `pm list features` output, including hex GL versions. */
export const parseFeatureListOutput = (
  stdout: string,
): {
  features: readonly AdbFeatureEntry[];
  unparsedLines: AdbUnparsedLines;
} => {
  const features: AdbFeatureEntry[] = [];
  const unparsed = collectUnparsedLines();
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = FEATURE_LINE.exec(line);
    if (match === null) {
      unparsed.add(line);
      continue;
    }
    features.push({
      name: match[1]!,
      version: match[2] === undefined ? null : parseFeatureVersion(match[2]!),
    });
  }
  return { features, unparsedLines: unparsed.facts() };
};

export interface AdbServiceEntry {
  readonly name: string;
  readonly interface: string | null;
}

const SERVICE_LINE = /^\s*(?:\d+\s+)?([A-Za-z0-9._$/-]+):\s*\[([^\]]*)\]\s*$/u;

/** Parse `service list` output, tolerating numbered and plain formats. */
export const parseServiceListOutput = (
  stdout: string,
): {
  services: readonly AdbServiceEntry[];
  unparsedLines: AdbUnparsedLines;
} => {
  const services: AdbServiceEntry[] = [];
  const unparsed = collectUnparsedLines();
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (line.trim() === "" || /^Found \d+ services:/u.test(line.trim()))
      continue;
    const match = SERVICE_LINE.exec(line);
    if (match === null) {
      if (line.trim() !== "") unparsed.add(line.trim());
      continue;
    }
    services.push({
      name: match[1]!,
      interface: match[2] === "" ? null : match[2]!,
    });
  }
  return { services, unparsedLines: unparsed.facts() };
};

const SIZE_PAIR = /^Physical size:\s+(\d+)x(\d+)$/u;
const SIZE_OVERRIDE = /^Override size:\s+(\d+)x(\d+)$/u;
const DENSITY_PHYSICAL = /^Physical density:\s+(\d+)$/u;
const DENSITY_OVERRIDE = /^Override density:\s+(\d+)$/u;
const DENSITY_BARE = /^(\d+)$/u;

/** Parse `wm size` output into physical and optional override sizes. */
export const parseWmSizeOutput = (
  stdout: string,
): {
  physical: { readonly width: number; readonly height: number } | null;
  override: { readonly width: number; readonly height: number } | null;
} => {
  let physical = null;
  let override = null;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const physicalMatch = SIZE_PAIR.exec(trimmed);
    if (physicalMatch !== null)
      physical = {
        width: Number(physicalMatch[1]!),
        height: Number(physicalMatch[2]!),
      };
    const overrideMatch = SIZE_OVERRIDE.exec(trimmed);
    if (overrideMatch !== null)
      override = {
        width: Number(overrideMatch[1]!),
        height: Number(overrideMatch[2]!),
      };
  }
  return { physical, override };
};

/**
 * Parse `wm density` output. Current builds print labeled physical and
 * optional override lines; older builds print the physical density as a
 * bare number on its own line (morluto/rea#3942). A labeled declaration
 * wins over a bare one so a mixed dump cannot downgrade the physical value.
 */
export const parseWmDensityOutput = (
  stdout: string,
): {
  physical: number | null;
  override: number | null;
} => {
  let physical = null;
  let override = null;
  let bare = null;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const physicalMatch = DENSITY_PHYSICAL.exec(trimmed);
    if (physicalMatch !== null) physical = Number(physicalMatch[1]!);
    const overrideMatch = DENSITY_OVERRIDE.exec(trimmed);
    if (overrideMatch !== null) override = Number(overrideMatch[1]!);
    const bareMatch = DENSITY_BARE.exec(trimmed);
    if (bareMatch !== null && bare === null) bare = Number(bareMatch[1]!);
  }
  return { physical: physical ?? bare, override };
};

/** Own declaration identity and omission before deriving a singular summary. */
export const parseWindowFocusOutput = (
  stdout: string,
): AdbWindowFocusObservation => {
  const contexts: AdbWindowFocusContext[] = [];
  const observedLines: string[] = [];
  let current: AdbWindowFocusContext | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Display:")) {
      current = {
        scope: "display",
        display_id:
          /^Display:\s+mDisplayId=(-?[0-9]+)(?:\s|$)/u.exec(trimmed)?.[1] ??
          null,
        header_line: line,
        declarations: [],
      };
      contexts.push(current);
      observedLines.push(line);
      continue;
    }
    const field = trimmed.startsWith("mCurrentFocus=")
      ? "mCurrentFocus"
      : trimmed.startsWith("mFocusedApp=")
        ? "mFocusedApp"
        : undefined;
    if (field === undefined) continue;
    if (current === undefined) {
      current = {
        scope: "unscoped",
        display_id: null,
        header_line: null,
        declarations: [],
      };
      contexts.push(current);
    }
    const value = trimmed.slice(field.length + 1).trim();
    current.declarations.push({
      field,
      value: value === "null" ? null : value,
      raw_line: line,
    });
    observedLines.push(line);
  }
  const windows =
    contexts.length === 1
      ? contexts[0]!.declarations.filter(
          ({ field }) => field === "mCurrentFocus",
        )
      : [];
  const apps =
    contexts.length === 1
      ? contexts[0]!.declarations.filter(({ field }) => field === "mFocusedApp")
      : [];
  const declared = contexts.some(({ declarations }) => declarations.length > 0);
  const summary = !declared
    ? "unavailable"
    : contexts.length === 1 && windows.length <= 1 && apps.length <= 1
      ? "single_context"
      : "ambiguous";
  return {
    focused_window:
      summary === "single_context" ? (windows[0]?.value ?? null) : null,
    focused_app: summary === "single_context" ? (apps[0]?.value ?? null) : null,
    focus_summary: summary,
    focus_contexts: contexts,
    observed_lines: observedLines,
  };
};

export interface AdbPackageDetails {
  readonly versionName: string | null;
  /** Signed 64-bit long version code exactly as Package Manager prints it. */
  readonly versionCode: string | null;
  readonly firstInstallTime: string | null;
  readonly lastUpdateTime: string | null;
  readonly installerPackageName: string | null;
  readonly userId: number | null;
  readonly pkgFlags: string | null;
  readonly requestedPermissions: number | null;
}

const DETAIL_LINE = /^\s+([A-Za-z][A-Za-z0-9_]*)=(.*)$/u;

/**
 * Package Manager prints its `String` fields by concatenation, so an absent
 * `installerPackageName` appears as the literal text `null`
 * (morluto/rea#3943). No installer can be named "null", so an empty value or
 * that sentinel is the absence of the fact and becomes the nullable result's
 * null. `versionName` keeps the printed text: a manifest may declare the
 * string "null" on purpose, and the parser cannot tell the two apart.
 */
const absentInstallerOrName = (value: string): string | null =>
  value === "" || value === "null" ? null : value;

/**
 * Project `dumpsys package PACKAGE` output. Only the listed fields are
 * extracted; the input is version-dependent and everything else is ignored
 * by design rather than guessed.
 */
export const parseDumpsysPackageOutput = (
  stdout: string,
): AdbPackageDetails => {
  const details: {
    versionName: string | null;
    versionCode: string | null;
    firstInstallTime: string | null;
    lastUpdateTime: string | null;
    installerPackageName: string | null;
    userId: number | null;
    pkgFlags: string | null;
  } = {
    versionName: null,
    versionCode: null,
    firstInstallTime: null,
    lastUpdateTime: null,
    installerPackageName: null,
    userId: null,
    pkgFlags: null,
  };
  let inPermissions = false;
  let hasPermissionsSection = false;
  let permissions = 0;
  let parsedPackageAvailable: boolean | null = null;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().startsWith("requested permissions:")) {
      hasPermissionsSection = true;
      inPermissions = true;
      continue;
    }
    // Android 10 and 11 mark restricted entries as "NAME: restricted=true".
    if (
      inPermissions &&
      /^\s{2,}[A-Za-z0-9._]+(?:: restricted=true)?$/u.test(line)
    ) {
      permissions += 1;
      continue;
    }
    inPermissions = false;
    const match = DETAIL_LINE.exec(line);
    if (match === null) continue;
    const key = match[1]!;
    const value = match[2]!.trim();
    if (key === "pkg" && parsedPackageAvailable === null) {
      if (value === "null") parsedPackageAvailable = false;
      else if (value.startsWith("Package{") && value.endsWith("}"))
        parsedPackageAvailable = true;
    } else if (key === "versionName" && details.versionName === null)
      details.versionName = value === "" ? null : value;
    else if (key === "versionCode" && details.versionCode === null) {
      const parsed = /^(-?\d+)/u.exec(value);
      if (parsed !== null) details.versionCode = parsed[1]!;
    } else if (key === "firstInstallTime" && details.firstInstallTime === null)
      details.firstInstallTime = value === "" ? null : value;
    else if (key === "lastUpdateTime" && details.lastUpdateTime === null)
      details.lastUpdateTime = value === "" ? null : value;
    else if (
      key === "installerPackageName" &&
      details.installerPackageName === null
    )
      details.installerPackageName = absentInstallerOrName(value);
    else if (key === "userId" && details.userId === null) {
      const parsed = /^(\d+)/u.exec(value);
      if (parsed !== null) details.userId = Number(parsed[1]!);
    } else if (key === "pkgFlags" && details.pkgFlags === null)
      details.pkgFlags = value === "" ? null : value;
  }
  // `dumpsys` omits this section both for known-empty inventories and when
  // Package Manager has no parsed package; only the former is a known zero.
  const requestedPermissions =
    parsedPackageAvailable === false
      ? null
      : hasPermissionsSection
        ? permissions
        : parsedPackageAvailable === true
          ? 0
          : null;
  return { ...details, requestedPermissions };
};

/**
 * Parse `settings get` output. Android prints the literal string `null` for
 * absent keys; that is reported as a device-side null observation.
 */
export const parseSettingsGetOutput = (
  stdout: string,
): {
  value: string | null;
  deviceReportedNull: boolean;
} => {
  const trimmed = stdout.replace(/\r?\n$/u, "");
  if (trimmed === "null") return { value: null, deviceReportedNull: true };
  return { value: trimmed, deviceReportedNull: false };
};

/** Parse the host-side completion line from `adb bugreport`. */
export const parseBugreportCopiedPath = (stdout: string): string | null => {
  const match = /^Bug report copied to (.+)\r?$/mu.exec(stdout.trim());
  return match === null ? null : match[1]!;
};

/**
 * Read the digest from one `sha256sum FILE` line, or null when the output
 * names none. GNU sha256sum starts the line with a backslash when it escaped
 * the echoed name; the digest itself is never escaped.
 */
export const parseSha256sumOutput = (stdout: string): string | null =>
  /^\\?([a-f0-9]{64}) [ *]/u.exec(stdout)?.[1] ?? null;

/** Read the device's `Failure [REASON]` verdict from package-change output. */
export const packageChangeFailureReason = (output: string): string | null =>
  /Failure \[([^\]]+)\]/u.exec(output)?.[1] ?? null;

/**
 * Parse `adb install`/`adb uninstall` output. adb can print `Failure [...]`
 * with a zero exit code, so the text decides, not the exit status. Output
 * without either verdict, such as an empty reply or progress lines alone,
 * leaves the package change unknown rather than refused.
 */
export const parsePackageChangeOutput = (
  stdout: string,
):
  | { readonly status: "success" }
  | { readonly status: "failure"; readonly reason: string }
  | { readonly status: "unknown" } => {
  const text = stdout.trim();
  if (/^Success$/mu.test(text)) return { status: "success" };
  const reason = packageChangeFailureReason(text);
  return reason === null
    ? { status: "unknown" }
    : { status: "failure", reason };
};

/**
 * Parse `cmd package resolve-activity --brief` output: the component is the
 * last non-empty line.
 */
export const parseResolveActivityOutput = (stdout: string): string | null => {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^No activity found$/iu.test(line));
  return lines.length === 0 ? null : lines[lines.length - 1]!;
};

/** Parsed facts and verdict from the full `am start -W` report. */
export interface AmStartOutput {
  readonly status: "started" | "refused";
  readonly startedActivity: string | null;
  readonly activity: string | null;
  readonly reportedStatus: string | null;
  readonly reason: string | null;
}

/**
 * Parse the complete `am start -W` report. `Starting:` records an attempt;
 * hard errors and any non-ok Activity Manager status determine the verdict.
 */
export const parseAmStartOutput = (
  stdout: string,
  stderr = "",
): AmStartOutput => {
  const normalizedStdout = stdout.replaceAll("\r\n", "\n");
  const starting = /^Starting:[ \t]+Intent[ \t]*\{(.*)\}[ \t]*$/mu.exec(
    normalizedStdout,
  );
  const startedActivity = starting?.[1]?.trim() ?? null;
  const activityMatch = /^Activity:[ \t]*(.*)$/mu.exec(normalizedStdout);
  const activity = activityMatch?.[1]?.trim() || null;
  const statuses = [...normalizedStdout.matchAll(/^Status:[ \t]*(.*)$/gmu)].map(
    (match) => match[1]!.trim(),
  );
  const nonOkStatus = statuses.find((status) => status.toLowerCase() !== "ok");
  const reportedStatus = nonOkStatus ?? statuses[0] ?? null;
  const error = [normalizedStdout, stderr.replaceAll("\r\n", "\n")]
    .flatMap((stream) => stream.split("\n"))
    .map((line) => line.trim())
    .map((line) => ({
      line,
      match: /^(?:Error|Exception)(?::|\b)(.*)$/iu.exec(line),
    }))
    .find(({ match }) => match !== null);
  const errorReason = error?.match?.[1]?.trim() || error?.line || null;
  const statusReason =
    nonOkStatus === ""
      ? "am start reported an empty status"
      : nonOkStatus === undefined
        ? null
        : `am start reported status: ${nonOkStatus}`;
  const reason =
    errorReason ??
    statusReason ??
    (/^Warning:/mu.test(normalizedStdout.trim())
      ? normalizedStdout.trim().slice(0, 512)
      : null);
  if (errorReason !== null || nonOkStatus !== undefined)
    return {
      status: "refused",
      startedActivity,
      activity,
      reportedStatus,
      reason: reason ?? "am start did not report a successful launch",
    };
  if (startedActivity !== null)
    return {
      status: "started",
      startedActivity,
      activity,
      reportedStatus,
      reason: null,
    };
  const text = `${normalizedStdout}\n${stderr.replaceAll("\r\n", "\n")}`.trim();
  return {
    status: "refused",
    startedActivity,
    activity,
    reportedStatus,
    reason:
      reason ??
      (text === "" ? "am start returned no activity" : text.slice(0, 512)),
  };
};

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Read image dimensions from a PNG header, or null for other payloads. */
export const parsePngDimensions = (
  bytes: Uint8Array,
): {
  width: number | null;
  height: number | null;
} => {
  if (
    bytes.length < 24 ||
    !Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)
  )
    return { width: null, height: null };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
};
