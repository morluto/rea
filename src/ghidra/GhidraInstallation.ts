import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { accessSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";

import type { ProviderRejectionCode } from "../contracts/providerSelection.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Exact Ghidra build whose Java bridge contract this REA release supports. */
export const SUPPORTED_GHIDRA_VERSION = "12.1.2";
/** Exact JDK major documented by the supported Ghidra release. */
export const SUPPORTED_GHIDRA_JAVA_MAJOR = 21;

/** Caller-owned paths and host coordinates used for one installation probe. */
export interface GhidraInstallationOptions {
  readonly installDir?: string;
  readonly javaHome?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
}

/** One independently actionable part of the supported-installation contract. */
export interface GhidraInstallationCheck {
  readonly name:
    | "configuration"
    | "platform"
    | "architecture"
    | "installation"
    | "version"
    | "headless"
    | "java";
  readonly ok: boolean;
  readonly code: ProviderRejectionCode | null;
  readonly detail: string;
  readonly remediation: string | null;
}

/** Bounded observation of a BYO Ghidra installation and JDK. */
export interface GhidraInstallationInspection {
  readonly available: boolean;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly installDir: string | null;
  readonly analyzeHeadlessPath: string | null;
  readonly applicationPropertiesPath: string | null;
  readonly providerVersion: string | null;
  readonly javaCommand: string;
  readonly javaHome: string | null;
  readonly javaVersion: string | null;
  readonly checks: readonly GhidraInstallationCheck[];
  readonly rejectionCode: ProviderRejectionCode | null;
  readonly reason: string | null;
}

/** Parsed identity of the JDK selected for Ghidra. */
export interface GhidraJavaObservation {
  readonly version: string;
  readonly major: number;
  readonly home: string;
  readonly bits: number;
  readonly jdk: boolean;
}

/** Narrow synchronous seam used by provider discovery without launching Ghidra. */
export interface GhidraInstallationHost {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readText(path: string): string | undefined;
  executable(path: string): boolean;
  probeJava(
    command: string,
    environment: NodeJS.ProcessEnv,
  ): GhidraJavaObservation | undefined;
}

interface GhidraInstallationCoordinates {
  readonly installDir: string | null;
  readonly applicationPropertiesPath: string | null;
  readonly analyzeHeadlessPath: string | null;
  readonly propertiesAvailable: boolean;
  readonly providerVersion: string | null;
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
  const coordinates = installationCoordinates(options, platform, host);
  const checks = installationChecks({
    coordinates,
    platform,
    architecture,
    javaHome: options.javaHome,
    host,
  });
  const failed = checks.find(({ ok }) => !ok);
  return {
    available: failed === undefined,
    platform,
    architecture,
    installDir: coordinates.installDir,
    analyzeHeadlessPath: coordinates.analyzeHeadlessPath,
    applicationPropertiesPath: coordinates.applicationPropertiesPath,
    providerVersion: coordinates.providerVersion,
    javaCommand: coordinates.javaCommand,
    javaHome: coordinates.java?.home ?? options.javaHome ?? null,
    javaVersion: coordinates.java?.version ?? null,
    checks,
    rejectionCode: failed?.code ?? null,
    reason: failed?.remediation ?? null,
  };
};

const installationCoordinates = (
  options: GhidraInstallationOptions,
  platform: NodeJS.Platform,
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
    propertiesAvailable: properties !== undefined,
    providerVersion:
      properties === undefined
        ? null
        : propertyValue(properties, "application.version"),
    javaCommand,
    java: host.probeJava(
      javaCommand,
      ghidraJavaEnvironment(options.javaHome, process.env, platform),
    ),
  };
};

const installationChecks = ({
  coordinates,
  platform,
  architecture,
  javaHome,
  host,
}: GhidraInstallationCheckContext): readonly GhidraInstallationCheck[] => [
  installationCheck({
    name: "configuration",
    ok: coordinates.installDir !== null,
    code: "not_configured",
    detail: coordinates.installDir ?? "GHIDRA_INSTALL_DIR is not set",
    remediation:
      "Set GHIDRA_INSTALL_DIR to an extracted Ghidra 12.1.2 release directory.",
  }),
  installationCheck({
    name: "platform",
    ok: platform === "linux" || platform === "win32",
    code: "unsupported_host",
    detail: platform,
    remediation:
      "Use REA's Ghidra adapter on a supported Linux or Windows x64 host.",
  }),
  installationCheck({
    name: "architecture",
    ok: architecture === "x64",
    code: "unsupported_host",
    detail: architecture,
    remediation:
      "Use the official x86-64 Ghidra distribution on an x64 Linux or Windows host.",
  }),
  installationCheck({
    name: "installation",
    ok: coordinates.propertiesAvailable,
    code: "executable_missing",
    detail:
      coordinates.applicationPropertiesPath ??
      "Ghidra application properties unavailable",
    remediation:
      "Point GHIDRA_INSTALL_DIR at the root of an extracted official Ghidra release.",
  }),
  installationCheck({
    name: "version",
    ok: coordinates.providerVersion === SUPPORTED_GHIDRA_VERSION,
    code:
      coordinates.providerVersion === null
        ? "version_unresolved"
        : "unsupported_version",
    detail: coordinates.providerVersion ?? "unknown",
    remediation: `Install Ghidra ${SUPPORTED_GHIDRA_VERSION}, or update REA for a different Ghidra build.`,
  }),
  installationCheck({
    name: "headless",
    ok:
      coordinates.analyzeHeadlessPath !== null &&
      host.executable(coordinates.analyzeHeadlessPath),
    code: "executable_missing",
    detail: coordinates.analyzeHeadlessPath ?? "analyzeHeadless unavailable",
    remediation:
      "Restore support/analyzeHeadless or support/analyzeHeadless.bat from the official Ghidra release.",
  }),
  javaCheck(coordinates.java, coordinates.javaCommand, javaHome),
];

/** Project an installation probe into caller-visible, secret-free diagnostics. */
export const ghidraInstallationDiagnostics = (
  inspection: GhidraInstallationInspection,
): Readonly<Record<string, JsonValue>> => ({
  install_dir: inspection.installDir,
  analyze_headless_path: inspection.analyzeHeadlessPath,
  application_properties_path: inspection.applicationPropertiesPath,
  provider_version: inspection.providerVersion,
  java_command: inspection.javaCommand,
  java_home: inspection.javaHome,
  java_version: inspection.javaVersion,
  platform: inspection.platform,
  architecture: inspection.architecture,
  checks: inspection.checks.map((check) => ({
    name: check.name,
    ok: check.ok,
    code: check.code,
    detail: check.detail,
  })),
});

/** Environment that makes an explicitly selected JDK win over PATH discovery. */
export const ghidraJavaEnvironment = (
  javaHome: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  const boundedEnvironment = {
    ...environment,
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
        )}${platform === "win32" ? win32.delimiter : posix.delimiter}${environment.PATH ?? ""}`,
      };
};

const installationCheck = (
  options: Omit<GhidraInstallationCheck, "code" | "remediation"> & {
    readonly code: ProviderRejectionCode;
    readonly remediation: string;
  },
): GhidraInstallationCheck => ({
  name: options.name,
  ok: options.ok,
  code: options.ok ? null : options.code,
  detail: options.detail,
  remediation: options.ok ? null : options.remediation,
});

const javaCheck = (
  observation: GhidraJavaObservation | undefined,
  command: string,
  configuredHome: string | undefined,
): GhidraInstallationCheck => {
  const supported =
    observation !== undefined &&
    observation.major === SUPPORTED_GHIDRA_JAVA_MAJOR &&
    observation.bits === 64 &&
    observation.jdk;
  const detail =
    observation === undefined
      ? command
      : `${observation.version}; ${String(observation.bits)}-bit; ${observation.jdk ? "JDK" : "runtime only"}; ${observation.home}`;
  return installationCheck({
    name: "java",
    ok: supported,
    code: observation === undefined ? "runtime_missing" : "unsupported_version",
    detail,
    remediation:
      configuredHome === undefined
        ? "Install a 64-bit JDK 21 or set JAVA_HOME before starting REA."
        : "Update JAVA_HOME to the root of a 64-bit JDK 21 installation.",
  });
};

const propertyValue = (content: string, name: string): string | null => {
  for (const line of content.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator < 0 || line.slice(0, separator).trim() !== name) continue;
    const value = line.slice(separator + 1).trim();
    return value.length === 0 ? null : value;
  }
  return null;
};

const systemGhidraInstallationHost = (): GhidraInstallationHost => ({
  readText(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  executable(path) {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  probeJava(command, environment) {
    const observed = spawnSync(
      command,
      ["-XshowSettings:properties", "-version"],
      {
        encoding: "utf8",
        env: environment,
        timeout: 5_000,
        maxBuffer: 128 * 1024,
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
      jdk: executablePath(
        (process.platform === "win32" ? win32 : posix).join(
          home,
          "bin",
          process.platform === "win32" ? "javac.exe" : "javac",
        ),
      ),
    };
  },
});

const executablePath = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
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
