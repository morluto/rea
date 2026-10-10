/**
 * Parsers for fixed observation commands REA runs through `adb shell`.
 *
 * Formats follow toybox output on Android 8+ (verified against an Android 14
 * emulator). Unparseable lines are retained rather than dropped so callers
 * can see the format drift instead of silently losing rows.
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
  unparsedLines: readonly string[];
} => {
  const processes: AdbProcessEntry[] = [];
  const unparsedLines: string[] = [];
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
      unparsedLines.push(line);
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
  return { columns, processes, unparsedLines };
};

export interface AdbDirectoryEntry {
  readonly name: string;
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly permissions: string | null;
  readonly owner: string | null;
  readonly group: string | null;
  readonly bytes: number | null;
  readonly date: string | null;
  readonly link_target: string | null;
}

const LS_LINE =
  /^([bcdlps-][rwxstST-]{9})\s+(?:(\d+)\s+)?(\S+)\s+(\S+)\s+(?:(\d+)\s+)?([\d-]{10})\s+([\d:]{4,8})\s+(.+)$/u;

/** Parse `ls -la` output, including `total` headers and symlink targets. */
export const parseLsOutput = (
  stdout: string,
): {
  entries: readonly AdbDirectoryEntry[];
  unparsedLines: readonly string[];
} => {
  const entries: AdbDirectoryEntry[] = [];
  const unparsedLines: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (line === "" || line.startsWith("total ")) continue;
    const match = LS_LINE.exec(line);
    if (match === null) {
      if (line.trim() !== "") unparsedLines.push(line);
      continue;
    }
    const permissions = match[1]!;
    let name = match[8]!.trim();
    let linkTarget: string | null = null;
    const linkArrow = name.indexOf(" -> ");
    if (linkArrow !== -1 && permissions.startsWith("l")) {
      linkTarget = name.slice(linkArrow + 4);
      name = name.slice(0, linkArrow);
    }
    entries.push({
      name,
      kind: permissions.startsWith("d")
        ? "directory"
        : permissions.startsWith("l")
          ? "symlink"
          : permissions.startsWith("-")
            ? "file"
            : "other",
      permissions,
      owner: match[3] ?? null,
      group: match[4] ?? null,
      bytes: match[5] === undefined ? null : Number(match[5]),
      date: `${match[6] ?? ""} ${match[7] ?? ""}`.trim() || null,
      link_target: linkTarget,
    });
  }
  return { entries, unparsedLines };
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
  unparsedLines: readonly string[];
} => {
  const features: AdbFeatureEntry[] = [];
  const unparsedLines: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = FEATURE_LINE.exec(line);
    if (match === null) {
      unparsedLines.push(line);
      continue;
    }
    features.push({
      name: match[1]!,
      version: match[2] === undefined ? null : parseFeatureVersion(match[2]!),
    });
  }
  return { features, unparsedLines };
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
  unparsedLines: readonly string[];
} => {
  const services: AdbServiceEntry[] = [];
  const unparsedLines: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (line.trim() === "" || /^Found \d+ services:/u.test(line.trim()))
      continue;
    const match = SERVICE_LINE.exec(line);
    if (match === null) {
      if (line.trim() !== "") unparsedLines.push(line.trim());
      continue;
    }
    services.push({
      name: match[1]!,
      interface: match[2] === "" ? null : match[2]!,
    });
  }
  return { services, unparsedLines };
};

const SIZE_PAIR = /^Physical size:\s+(\d+)x(\d+)$/u;
const SIZE_OVERRIDE = /^Override size:\s+(\d+)x(\d+)$/u;
const DENSITY_PHYSICAL = /^Physical density:\s+(\d+)$/u;
const DENSITY_OVERRIDE = /^Override density:\s+(\d+)$/u;

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

/** Parse `wm density` output. Older builds print a bare number. */
export const parseWmDensityOutput = (
  stdout: string,
): {
  physical: number | null;
  override: number | null;
} => {
  let physical = null;
  let override = null;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const physicalMatch = DENSITY_PHYSICAL.exec(trimmed);
    if (physicalMatch !== null) physical = Number(physicalMatch[1]!);
    const overrideMatch = DENSITY_OVERRIDE.exec(trimmed);
    if (overrideMatch !== null) override = Number(overrideMatch[1]!);
  }
  return { physical, override };
};

/** Parse the focus declarations from `dumpsys window windows`. */
export const parseWindowFocusOutput = (
  stdout: string,
): {
  focusedWindow: string | null;
  focusedApp: string | null;
} => {
  let focusedWindow = null;
  let focusedApp = null;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (focusedWindow === null && trimmed.startsWith("mCurrentFocus="))
      focusedWindow = trimmed.slice("mCurrentFocus=".length).trim();
    if (focusedApp === null && trimmed.startsWith("mFocusedApp="))
      focusedApp = trimmed.slice("mFocusedApp=".length).trim();
  }
  return { focusedWindow, focusedApp };
};

export interface AdbPackageDetails {
  readonly versionName: string | null;
  readonly versionCode: number | null;
  readonly firstInstallTime: string | null;
  readonly lastUpdateTime: string | null;
  readonly installerPackageName: string | null;
  readonly userId: number | null;
  readonly pkgFlags: string | null;
  readonly requestedPermissions: number | null;
}

const DETAIL_LINE = /^\s+([A-Za-z][A-Za-z0-9_]*)=(.*)$/u;

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
    versionCode: number | null;
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
  let permissions = 0;
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().startsWith("requested permissions:")) {
      inPermissions = true;
      continue;
    }
    if (inPermissions && /^\s{2,}[A-Za-z0-9._]+$/.test(line)) {
      permissions += 1;
      continue;
    }
    inPermissions = false;
    const match = DETAIL_LINE.exec(line);
    if (match === null) continue;
    const key = match[1]!;
    const value = match[2]!.trim();
    if (key === "versionName" && details.versionName === null)
      details.versionName = value === "" ? null : value;
    else if (key === "versionCode" && details.versionCode === null) {
      const parsed = /^(\d+)/u.exec(value);
      if (parsed !== null) details.versionCode = Number(parsed[1]!);
    } else if (key === "firstInstallTime" && details.firstInstallTime === null)
      details.firstInstallTime = value === "" ? null : value;
    else if (key === "lastUpdateTime" && details.lastUpdateTime === null)
      details.lastUpdateTime = value === "" ? null : value;
    else if (
      key === "installerPackageName" &&
      details.installerPackageName === null
    )
      details.installerPackageName = value === "" ? null : value;
    else if (key === "userId" && details.userId === null) {
      const parsed = /^(\d+)/u.exec(value);
      if (parsed !== null) details.userId = Number(parsed[1]!);
    } else if (key === "pkgFlags" && details.pkgFlags === null)
      details.pkgFlags = value === "" ? null : value;
  }
  return { ...details, requestedPermissions: permissions };
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
 * Parse `adb install`/`adb uninstall` output. adb can print `Failure [...]`
 * with a zero exit code, so the text decides, not the exit status.
 */
export const parsePackageChangeOutput = (
  stdout: string,
): {
  readonly status: "success" | "failure";
  readonly reason: string | null;
} => {
  const text = stdout.trim();
  if (/^Success$/mu.test(text)) return { status: "success", reason: null };
  const failure = /Failure \[([^\]]+)\]/u.exec(text);
  return {
    status: "failure",
    reason: failure?.[1] ?? (text === "" ? null : text.slice(0, 512)),
  };
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

/**
 * Parse `am start` output. Success prints `Starting: Intent { ... }`;
 * refusals print lines starting with `Error:` or `Warning:` and activity
 * classes that do not exist name the component.
 */
export const parseAmStartOutput = (
  stdout: string,
): {
  readonly status: "started" | "refused";
  readonly startedActivity: string | null;
  readonly reason: string | null;
} => {
  const text = stdout.trim();
  const starting = /^Starting:\s+Intent\s*\{(.*)\}\s*$/mu.exec(text);
  if (starting !== null)
    return {
      status: "started",
      startedActivity: starting[1]!.trim(),
      reason: null,
    };
  const error = /^(?:Error|Warning|Exception)(?::|\b)(.*)$/mu.exec(text);
  return {
    status: "refused",
    startedActivity: null,
    reason:
      error?.[1]?.trim() ??
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
