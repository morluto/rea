import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  accessSync,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { posix, win32 } from "node:path";

import type { ProviderRejectionCode } from "../contracts/providerSelection.js";
import {
  parseExecutableHeader,
  type ExecutableMetadata,
} from "../domain/binaryTarget.js";
import type { BinaryArchitecture } from "../domain/binaryTargetTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  ghidraApplicationProperties,
  ghidraJavaMajorAccepted,
  ghidraJavaRangeLabel,
  ghidraJavaRequirement,
  ghidraReleaseAccepted,
  ghidraReleaseCompatibility,
  ghidraReleaseLine,
  ghidraVersionDetail,
  SUPPORTED_GHIDRA_JAVA_MAJOR,
  SUPPORTED_GHIDRA_VERSION,
  type GhidraApplicationProperties,
  type GhidraJavaRequirement,
} from "./GhidraInstallationPolicy.js";

const NATIVE_PLATFORMS: Readonly<
  Partial<
    Record<
      NodeJS.Platform,
      Readonly<Partial<Record<NodeJS.Architecture, string>>>
    >
  >
> = {
  linux: { x64: "linux_x86_64", arm64: "linux_arm_64" },
  darwin: { x64: "mac_x86_64", arm64: "mac_arm_64" },
  win32: { x64: "win_x86_64" },
};

/** Executable format each supported host runs its own Ghidra native tools as. */
const NATIVE_TOOL_FORMATS: Readonly<
  Partial<Record<NodeJS.Platform, ExecutableMetadata["format"]>>
> = {
  linux: "elf",
  darwin: "mach-o",
  win32: "pe",
};

/** Node architecture identifiers as the executable-header parser reports them. */
const NATIVE_ARCHITECTURES: readonly {
  readonly node: NodeJS.Architecture;
  readonly binary: BinaryArchitecture;
}[] = [
  { node: "x64", binary: "x86_64" },
  { node: "ia32", binary: "x86" },
  { node: "arm", binary: "arm" },
  { node: "arm64", binary: "arm64" },
];

/** Bound installation discovery reads; larger headers remain unknown. */
const EXECUTABLE_HEADER_PROBE_BYTES = 4096;

/** Compatibility of one present native decompiler with the inspected host. */
type NativeDecompilerCompatibility =
  | {
      readonly status: "incompatible";
      readonly detail: string;
      readonly remediation: string;
    }
  | { readonly status: "compatible"; readonly detail: string }
  | { readonly status: "unknown"; readonly detail: string };

/**
 * Judge a native decompiler by its own executable header instead of the
 * directory name that admits it.
 *
 * Only a header that positively contradicts the host is `incompatible`. An
 * absent, unreadable, truncated, or unrecognized header stays `unknown`, so a
 * file the other checks already accept is never refused on missing evidence.
 */
const assessNativeDecompiler = (
  path: string,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  probe: GhidraExecutableHeaderProbe | undefined,
): NativeDecompilerCompatibility => {
  const expectedFormat = NATIVE_TOOL_FORMATS[platform];
  const expectedArchitecture = NATIVE_ARCHITECTURES.find(
    ({ node }) => node === architecture,
  )?.binary;
  if (expectedFormat === undefined || expectedArchitecture === undefined)
    return {
      status: "unknown",
      detail: `${path} is executable, but no native tool format is defined for ${platform}/${architecture}`,
    };
  let parsed =
    probe === undefined
      ? undefined
      : parseExecutableHeader(probe.bytes, architecture, probe.size);
  if (probe !== undefined && parsed !== undefined && !parsed.ok) {
    // FAT parsing selects a host slice. A validated foreign slice can still
    // prove that its complete architecture table excludes this host. If the
    // host is listed but its slice is malformed, preserve the unknown outcome.
    for (const { node } of NATIVE_ARCHITECTURES) {
      if (node === architecture) continue;
      const alternative = parseExecutableHeader(probe.bytes, node, probe.size);
      if (
        alternative.ok &&
        !alternative.value.availableArchitectures.some(
          (available) => available === expectedArchitecture,
        )
      ) {
        parsed = alternative;
        break;
      }
    }
  }
  if (parsed === undefined || !parsed.ok)
    return {
      status: "unknown",
      detail: `${path} is executable, but its executable format for ${platform}/${architecture} could not be established`,
    };
  const observed = `${parsed.value.format} ${parsed.value.architecture}`;
  const expected = `${expectedFormat} ${expectedArchitecture}`;
  if (observed === expected)
    return {
      status: "compatible",
      detail: `${path} reports ${observed}, which matches ${platform}/${architecture}`,
    };
  const nativeDirectory = NATIVE_PLATFORMS[platform]?.[architecture];
  const executable = platform === "win32" ? "decompile.exe" : "decompile";
  return {
    status: "incompatible",
    detail: `${path} reports ${observed}, but ${platform}/${architecture} requires ${expected}`,
    remediation: `Provide an executable Ghidra/Features/Decompiler/os/${nativeDirectory ?? "<platform>"}/${executable} built for ${expected}, or its build/os equivalent. REA does not build or install native tools.`,
  };
};

/** Caller-owned paths and host coordinates used for one installation probe. */
export interface GhidraInstallationOptions {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly installDir?: string;
  readonly javaHome?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
}

/** One independently actionable part of the supported-installation contract. */
export type GhidraInstallationCheck =
  | {
      readonly status: "passed";
      readonly name: GhidraInstallationCheckName;
      readonly detail: string;
    }
  | {
      readonly status: "failed";
      readonly name: GhidraInstallationCheckName;
      readonly code: ProviderRejectionCode;
      readonly detail: string;
      readonly remediation: string;
    };

/** Stable identity for one Ghidra installation check. */
export type GhidraInstallationCheckName =
  | "configuration"
  | "platform"
  | "architecture"
  | "installation"
  | "version"
  | "headless"
  | "native_decompiler"
  | "java";

interface GhidraInstallationObservation {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly applicationPropertiesPath: string | null;
  readonly nativeDecompilerPath: string | null;
  readonly javaCommand: string;
  readonly checks: readonly GhidraInstallationCheck[];
}

/** Bounded observation of a supported BYO Ghidra installation and JDK. */
export interface AvailableGhidraInstallation extends GhidraInstallationObservation {
  readonly status: "available";
  readonly installDir: string;
  readonly analyzeHeadlessPath: string;
  readonly applicationPropertiesPath: string;
  readonly providerVersion: string;
  readonly javaHome: string;
  readonly javaVersion: string;
}

/** Bounded observation explaining why a BYO Ghidra installation is unusable. */
export interface UnavailableGhidraInstallation extends GhidraInstallationObservation {
  readonly status: "unavailable";
  readonly installDir: string | null;
  readonly analyzeHeadlessPath: string | null;
  readonly providerVersion: string | null;
  readonly javaHome: string | null;
  readonly javaVersion: string | null;
  readonly rejection: Readonly<{
    code: ProviderRejectionCode;
    reason: string;
  }>;
}

/** Parsed available or unavailable state of one BYO Ghidra installation. */
export type GhidraInstallationInspection =
  | AvailableGhidraInstallation
  | UnavailableGhidraInstallation;

/** Parsed identity of the JDK selected for Ghidra. */
export interface GhidraJavaObservation {
  readonly version: string;
  readonly major: number;
  readonly home: string;
  readonly bits: number;
  readonly runtime: "jdk" | "jre";
}

/** A bounded executable-header probe: a small prefix plus the whole file size. */
export interface GhidraExecutableHeaderProbe {
  /** A bounded prefix; a larger or unreadable header remains unknown. */
  readonly bytes: Buffer;
  /** Whole-file size, since header commitments are checked against it, not the prefix. */
  readonly size: number;
}

/** Narrow synchronous seam used by provider discovery without launching Ghidra. */
export interface GhidraInstallationHost {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readText(path: string): string | undefined;
  executable(path: string): boolean;
  /**
   * Read a bounded header prefix of one executable so admission can reject a
   * tool built for another platform or architecture. An omitted seam, or an
   * unreadable file, reports the header as unknown and never rejects an
   * installation that the other checks already accept.
   */
  executableHeader?(path: string): GhidraExecutableHeaderProbe | undefined;
  probeJava(
    command: string,
    environment: NodeJS.ProcessEnv,
  ): GhidraJavaObservation | undefined;
}

interface GhidraInstallationCoordinates {
  readonly installDir: string | null;
  readonly applicationPropertiesPath: string | null;
  readonly analyzeHeadlessPath: string | null;
  readonly nativeDecompilerPath: string | null;
  readonly properties: GhidraApplicationProperties | undefined;
  readonly javaCommand: string;
  readonly java: GhidraJavaObservation | undefined;
}

interface GhidraInstallationCheckContext {
  readonly coordinates: GhidraInstallationCoordinates;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly javaHome: string | undefined;
  readonly host: GhidraInstallationHost;
}

/** Inspect an installation without importing a target or modifying Ghidra. */
export const inspectGhidraInstallation = (
  options: GhidraInstallationOptions,
  host: GhidraInstallationHost = systemGhidraInstallationHost(),
): GhidraInstallationInspection => {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const coordinates = installationCoordinates(
    options,
    platform,
    architecture,
    host,
  );
  const checks = installationChecks({
    coordinates,
    platform,
    architecture,
    javaHome: options.javaHome,
    host,
  });
  const failed = checks.find(
    (check): check is Extract<GhidraInstallationCheck, { status: "failed" }> =>
      check.status === "failed",
  );
  const observation = {
    platform,
    architecture,
    applicationPropertiesPath: coordinates.applicationPropertiesPath,
    nativeDecompilerPath: coordinates.nativeDecompilerPath,
    javaCommand: coordinates.javaCommand,
    checks,
  };
  if (failed !== undefined)
    return {
      status: "unavailable",
      ...observation,
      installDir: coordinates.installDir,
      analyzeHeadlessPath: coordinates.analyzeHeadlessPath,
      providerVersion: coordinates.properties?.providerVersion ?? null,
      javaHome: coordinates.java?.home ?? options.javaHome ?? null,
      javaVersion: coordinates.java?.version ?? null,
      rejection: { code: failed.code, reason: failed.remediation },
    };
  return availableInstallation(coordinates, observation);
};

const availableInstallation = (
  coordinates: GhidraInstallationCoordinates,
  observation: GhidraInstallationObservation,
): AvailableGhidraInstallation => {
  const providerVersion = coordinates.properties?.providerVersion;
  if (
    coordinates.installDir === null ||
    coordinates.applicationPropertiesPath === null ||
    coordinates.analyzeHeadlessPath === null ||
    providerVersion === null ||
    providerVersion === undefined ||
    coordinates.java === undefined
  )
    throw new TypeError(
      "Passing Ghidra installation checks produced incomplete coordinates",
    );
  return {
    status: "available",
    ...observation,
    installDir: coordinates.installDir,
    analyzeHeadlessPath: coordinates.analyzeHeadlessPath,
    applicationPropertiesPath: coordinates.applicationPropertiesPath,
    providerVersion,
    javaHome: coordinates.java.home,
    javaVersion: coordinates.java.version,
  };
};

const installationCoordinates = (
  options: GhidraInstallationOptions,
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  host: GhidraInstallationHost,
): GhidraInstallationCoordinates => {
  const path = platform === "win32" ? win32 : posix;
  const installDir = options.installDir ?? null;
  const applicationPropertiesPath =
    installDir === null
      ? null
      : path.join(installDir, "Ghidra", "application.properties");
  const analyzeHeadlessPath =
    installDir === null
      ? null
      : path.join(
          installDir,
          "support",
          platform === "win32" ? "analyzeHeadless.bat" : "analyzeHeadless",
        );
  const decompilerPlatform = NATIVE_PLATFORMS[platform]?.[architecture];
  const decompilerExecutable =
    platform === "win32" ? "decompile.exe" : "decompile";
  const nativeDecompilerPath =
    installDir === null || decompilerPlatform === undefined
      ? null
      : ([
          path.join(
            installDir,
            "Ghidra",
            "Features",
            "Decompiler",
            "os",
            decompilerPlatform,
            decompilerExecutable,
          ),
          path.join(
            installDir,
            "Ghidra",
            "Features",
            "Decompiler",
            "build",
            "os",
            decompilerPlatform,
            decompilerExecutable,
          ),
        ].find((candidate) => host.executable(candidate)) ?? null);
  const properties =
    applicationPropertiesPath === null
      ? undefined
      : host.readText(applicationPropertiesPath);
  const javaCommand =
    options.javaHome === undefined
      ? platform === "win32"
        ? "java.exe"
        : "java"
      : path.join(
          options.javaHome,
          "bin",
          platform === "win32" ? "java.exe" : "java",
        );
  return {
    installDir,
    applicationPropertiesPath,
    analyzeHeadlessPath,
    nativeDecompilerPath,
    properties:
      properties === undefined
        ? undefined
        : ghidraApplicationProperties(properties),
    javaCommand,
    // The configuration check rejects a relative JAVA_HOME. Probing it would
    // run whatever `bin/java` the current directory holds.
    java:
      options.javaHome === undefined || path.isAbsolute(options.javaHome)
        ? host.probeJava(
            javaCommand,
            ghidraJavaEnvironment(
              options.javaHome,
              options.environment,
              platform,
            ),
          )
        : undefined,
  };
};

const installationChecks = ({
  coordinates,
  platform,
  architecture,
  javaHome,
  host,
}: GhidraInstallationCheckContext): readonly GhidraInstallationCheck[] => [
  configurationCheck(coordinates.installDir, javaHome, platform),
  installationCheck({
    name: "platform",
    passed: NATIVE_PLATFORMS[platform] !== undefined,
    code: "unsupported_host",
    detail: platform,
    remediation:
      "Use Linux or macOS x64/arm64, or Windows x64 with matching native Ghidra tools.",
  }),
  installationCheck({
    name: "architecture",
    passed: NATIVE_PLATFORMS[platform]?.[architecture] !== undefined,
    code: "unsupported_host",
    detail: architecture,
    remediation: "Use x64/arm64 on Linux or macOS, or x64 on Windows.",
  }),
  installationCheck({
    name: "installation",
    passed: coordinates.properties !== undefined,
    code: "executable_missing",
    detail:
      coordinates.applicationPropertiesPath ??
      "Ghidra application properties unavailable",
    remediation:
      "Point GHIDRA_INSTALL_DIR at the root of an extracted official Ghidra release.",
  }),
  versionCheck(coordinates.properties),
  installationCheck({
    name: "headless",
    passed:
      coordinates.analyzeHeadlessPath !== null &&
      host.executable(coordinates.analyzeHeadlessPath),
    code: "executable_missing",
    detail: coordinates.analyzeHeadlessPath ?? "analyzeHeadless unavailable",
    remediation:
      "Restore support/analyzeHeadless or support/analyzeHeadless.bat from the official Ghidra release.",
  }),
  nativeDecompilerCheck({ coordinates, platform, architecture, host }),
  javaCheck(
    coordinates.java,
    coordinates.javaCommand,
    javaHome,
    coordinates.properties,
  ),
];

/**
 * REA's configuration parser, and so the MCP server and analysis, accept only
 * absolute paths; a relative one that happens to resolve here must not pass.
 */
const configurationCheck = (
  installDir: string | null,
  javaHome: string | undefined,
  platform: NodeJS.Platform,
): GhidraInstallationCheck => {
  const { isAbsolute } = platform === "win32" ? win32 : posix;
  const relative = [
    ...(installDir !== null && !isAbsolute(installDir)
      ? ["GHIDRA_INSTALL_DIR"]
      : []),
    ...(javaHome !== undefined && !isAbsolute(javaHome) ? ["JAVA_HOME"] : []),
  ];
  if (installDir === null || relative.length === 0)
    return installationCheck({
      name: "configuration",
      passed: installDir !== null,
      code: "not_configured",
      detail: installDir ?? "GHIDRA_INSTALL_DIR is not set",
      remediation: `Set GHIDRA_INSTALL_DIR to an extracted Ghidra ${ghidraReleaseLine()} release directory.`,
    });
  const settings = relative.join(" and ");
  return installationCheck({
    name: "configuration",
    passed: false,
    code: "not_configured",
    detail: `${settings} must be absolute`,
    remediation: `Set ${settings} to ${relative.length === 1 ? "an absolute path" : "absolute paths"}. REA's analysis and MCP server reject relative paths even when they resolve from the current directory.`,
  });
};

/** Project an installation probe into caller-visible, secret-free diagnostics. */
export const ghidraInstallationDiagnostics = (
  inspection: GhidraInstallationInspection,
): Readonly<Record<string, JsonValue>> => ({
  install_dir: inspection.installDir,
  analyze_headless_path: inspection.analyzeHeadlessPath,
  native_decompiler_path: inspection.nativeDecompilerPath,
  application_properties_path: inspection.applicationPropertiesPath,
  provider_version: inspection.providerVersion,
  java_command: inspection.javaCommand,
  java_home: inspection.javaHome,
  java_version: inspection.javaVersion,
  platform: inspection.platform,
  architecture: inspection.architecture,
  checks: inspection.checks.map((check) => ({
    name: check.name,
    ok: check.status === "passed",
    code: check.status === "failed" ? check.code : null,
    detail: check.detail,
  })),
});

/** Environment that makes an explicitly selected JDK win over PATH discovery. */
export const ghidraJavaEnvironment = (
  javaHome: string | undefined,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  const selectedEnvironment = snapshotEnvironment(environment, platform);
  const boundedEnvironment = {
    ...selectedEnvironment,
    _JAVA_OPTIONS: "",
    JAVA_TOOL_OPTIONS: "",
    JDK_JAVA_OPTIONS: "",
    GHIDRA_JAVA_OPTIONS: "",
  };
  return javaHome === undefined
    ? boundedEnvironment
    : {
        ...boundedEnvironment,
        JAVA_HOME: javaHome,
        PATH: `${(platform === "win32" ? win32 : posix).join(
          javaHome,
          "bin",
        )}${platform === "win32" ? win32.delimiter : posix.delimiter}${selectedEnvironment.PATH ?? ""}`,
      };
};

const installationCheck = (options: {
  readonly name: GhidraInstallationCheckName;
  readonly passed: boolean;
  readonly detail: string;
  readonly code: ProviderRejectionCode;
  readonly remediation: string;
}): GhidraInstallationCheck =>
  options.passed
    ? {
        status: "passed",
        name: options.name,
        detail: options.detail,
      }
    : {
        status: "failed",
        name: options.name,
        code: options.code,
        detail: options.detail,
        remediation: options.remediation,
      };

/** Require a present native decompiler without positively incompatible bytes. */
const nativeDecompilerCheck = ({
  coordinates,
  platform,
  architecture,
  host,
}: Pick<
  GhidraInstallationCheckContext,
  "coordinates" | "platform" | "architecture" | "host"
>): GhidraInstallationCheck => {
  const path = coordinates.nativeDecompilerPath;
  const compatibility =
    path === null
      ? undefined
      : assessNativeDecompiler(
          path,
          platform,
          architecture,
          host.executableHeader?.(path),
        );
  return installationCheck({
    name: "native_decompiler",
    passed: path !== null && compatibility?.status !== "incompatible",
    code: "executable_missing",
    detail:
      compatibility?.detail ??
      `Matching native decompiler for ${platform}/${architecture} was not found`,
    remediation:
      compatibility?.status === "incompatible"
        ? compatibility.remediation
        : `Provide an executable Ghidra/Features/Decompiler/os/${NATIVE_PLATFORMS[platform]?.[architecture] ?? "<platform>"}/${platform === "win32" ? "decompile.exe" : "decompile"}, or its build/os equivalent. REA does not build or install native tools.`,
  });
};

const versionCheck = (
  properties: GhidraApplicationProperties | undefined,
): GhidraInstallationCheck => {
  const raw = properties?.providerVersion;
  return installationCheck({
    name: "version",
    passed: ghidraReleaseAccepted(raw),
    code:
      ghidraReleaseCompatibility(raw).status === "unsupported"
        ? "unsupported_version"
        : "version_unresolved",
    detail: ghidraVersionDetail(raw),
    remediation: `Install a Ghidra ${ghidraReleaseLine()} release (verified with ${SUPPORTED_GHIDRA_VERSION}), or update REA for another Ghidra line.`,
  });
};

const javaCheck = (
  observation: GhidraJavaObservation | undefined,
  command: string,
  configuredHome: string | undefined,
  properties: GhidraApplicationProperties | undefined,
): GhidraInstallationCheck => {
  const requirement = ghidraJavaRequirement(properties);
  const range = ghidraJavaRangeLabel(requirement);
  const supported =
    observation !== undefined &&
    ghidraJavaMajorAccepted(observation.major, requirement) &&
    observation.bits === 64 &&
    observation.runtime === "jdk";
  const detail =
    observation === undefined
      ? requirement.unresolved === null
        ? command
        : `${command}; ${requirement.unresolved}`
      : `${observation.version}; ${String(observation.bits)}-bit; ${observation.runtime === "jdk" ? "JDK" : "runtime only"}; ${observation.home}; accepted ${range}`;
  return installationCheck({
    name: "java",
    passed: supported,
    code:
      requirement.unresolved !== null
        ? "version_unresolved"
        : observation === undefined
          ? "runtime_missing"
          : "unsupported_version",
    detail,
    remediation: javaRemediation(requirement, configuredHome, range),
  });
};

const javaRemediation = (
  requirement: GhidraJavaRequirement,
  configuredHome: string | undefined,
  range: string,
): string => {
  if (requirement.unresolved !== null)
    return `The Ghidra installation's Java bounds could not be read (${requirement.unresolved}). Install a 64-bit full JDK inside the declared application.java.min and application.java.max.`;
  return configuredHome === undefined
    ? `Install ${range}, or set JAVA_HOME before starting REA.`
    : `Update JAVA_HOME to the root of ${range} installation.`;
};

const systemGhidraInstallationHost = (): GhidraInstallationHost => ({
  readText(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (cause: unknown) {
      // best-effort cleanup: optional install probing; unreadable means unknown.
      void cause;
      return undefined;
    }
  },
  executableHeader(path) {
    let handle: number | undefined;
    try {
      handle = openSync(
        path,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY,
      );
      const metadata = fstatSync(handle);
      if (!metadata.isFile()) return undefined;
      const bytes = Buffer.alloc(EXECUTABLE_HEADER_PROBE_BYTES);
      const read = readSync(handle, bytes, 0, bytes.length, 0);
      return { bytes: bytes.subarray(0, read), size: metadata.size };
    } catch (cause: unknown) {
      // best-effort cleanup: a header that cannot be read stays unknown.
      void cause;
      return undefined;
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  },
  executable(path) {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch (cause: unknown) {
      // best-effort cleanup: optional executable probing; failure means missing.
      void cause;
      return false;
    }
  },
  probeJava(command, environment) {
    const observed = spawnSync(
      command,
      ["-XX:-UsePerfData", "-XshowSettings:properties", "-version"],
      {
        encoding: "utf8",
        env: environment,
        timeout: 5_000,
        maxBuffer: Number.POSITIVE_INFINITY,
        windowsHide: true,
      },
    );
    if (observed.error !== undefined || observed.status !== 0) return undefined;
    const output = `${observed.stdout ?? ""}\n${observed.stderr ?? ""}`;
    const version = javaProperty(output, "java.version");
    const home = javaProperty(output, "java.home");
    const bits = Number.parseInt(
      javaProperty(output, "sun.arch.data.model") ?? "0",
      10,
    );
    if (version === null || home === null) return undefined;
    return {
      version,
      major: javaMajor(version),
      home,
      bits,
      runtime: executablePath(
        (process.platform === "win32" ? win32 : posix).join(
          home,
          "bin",
          process.platform === "win32" ? "javac.exe" : "javac",
        ),
      )
        ? "jdk"
        : "jre",
    };
  },
});

const executablePath = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch (cause: unknown) {
    // best-effort cleanup: optional executable probing; failure means missing.
    void cause;
    return false;
  }
};

const javaProperty = (output: string, name: string): string | null =>
  new RegExp(
    `^\\s*${name.replaceAll(".", "\\.")}\\s*=\\s*(.+?)\\s*$`,
    "mu",
  ).exec(output)?.[1] ?? null;

const javaMajor = (version: string): number => {
  const first = Number.parseInt(version.split(".")[0] ?? "0", 10);
  if (first !== 1) return first;
  return Number.parseInt(version.split(".")[1] ?? "0", 10);
};
