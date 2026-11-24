import {
  SUPPORTED_NODE_VERSION_PROSE,
  supportsNodeVersion,
} from "../domain/runtimeVersion.js";
import { providerStartupTimeoutSchema } from "../config/providerStartupTimeout.js";
import {
  linuxHopperLauncherCandidates,
  systemLinuxHopperLauncherCandidates,
  supportsReaHost,
} from "./LinuxHopper.js";
import {
  MAC_HOPPER_SYSTEM_LAUNCHER,
  macHopperCanonicalLauncherCandidates,
} from "./MacHopperPaths.js";
import type {
  DoctorCheck,
  DoctorHost,
  DoctorProviderInspection,
} from "./Doctor.js";

/** Ordered environment diagnostics consumed by the Doctor report assembler. */
export interface DoctorDiagnostics {
  readonly checks: readonly DoctorCheck[];
  readonly hopperPath?: string;
  readonly providerInspections?: readonly DoctorProviderInspection[];
}

/** Collect host, provider, and optional-target diagnostics without mutation. */
export const collectDoctorDiagnostics = async (
  target: string | undefined,
  host: DoctorHost,
): Promise<DoctorDiagnostics> => {
  const checks: DoctorCheck[] = [nodeCheck(host)];
  checks.push(await hostCheck(host));

  const hopperPath = await findHopper(host);
  checks.push(hopperCheck(host, hopperPath));
  const hopperTimeoutCheck = optionalHopperStartupTimeoutCheck(host);
  if (hopperTimeoutCheck !== undefined) checks.push(hopperTimeoutCheck);
  const hopperVersionCheck = await optionalHopperVersionCheck(host, hopperPath);
  if (hopperVersionCheck !== undefined) checks.push(hopperVersionCheck);

  const providerInspections = await host.providerInspections?.();
  if (providerInspections !== undefined)
    checks.push(...providerInspections.flatMap(providerDoctorChecks));

  const ilspyCheck = await optionalIlspyCheck(host);
  if (ilspyCheck !== undefined) checks.push(ilspyCheck);
  const hopperDemoCheck = await optionalHopperDemoCheck(host, hopperPath);
  if (hopperDemoCheck !== undefined) checks.push(hopperDemoCheck);
  const targetCheck = await optionalTargetCheck(target, host);
  if (targetCheck !== undefined) checks.push(targetCheck);

  return {
    checks,
    ...(hopperPath === undefined ? {} : { hopperPath }),
    ...(providerInspections === undefined ? {} : { providerInspections }),
  };
};

/** Evaluate core health while treating unconfigured providers as optional. */
export const doctorHealthy = (
  checks: readonly DoctorCheck[],
  providers: {
    readonly hopperAvailable: boolean;
    readonly hopperConfigured: boolean;
    readonly providerInspections:
      | readonly DoctorProviderInspection[]
      | undefined;
  },
): boolean => {
  if (providers.providerInspections === undefined)
    return checks.every(({ ok }) => ok);
  const providerChecks = checks.filter(
    ({ name }) =>
      name.startsWith("hopper") ||
      providers.providerInspections?.some((inspection) =>
        providerCheckName(inspection.id, name),
      ) === true,
  );
  const coreHealthy = checks
    .filter((candidate) => !providerChecks.includes(candidate))
    .every(({ ok }) => ok);
  const configuredProvidersHealthy = providerChecks
    .filter(({ name }) => {
      // Validate the supplied setting independently of provider discovery.
      if (name === "hopper-startup-timeout") return true;
      if (name.startsWith("hopper")) return providers.hopperConfigured;
      return providers.providerInspections?.some(
        (inspection) =>
          inspection.configured && providerCheckName(inspection.id, name),
      );
    })
    .every(({ ok }) => ok);
  return (
    coreHealthy &&
    configuredProvidersHealthy &&
    (providers.hopperAvailable ||
      providers.providerInspections.some(({ available }) => available))
  );
};

/** Bun passes when its reported Node.js compatibility version is supported. */
const nodeCheck = ({ runtime }: DoctorHost): DoctorCheck => {
  const failure = {
    remediation: `Install ${SUPPORTED_NODE_VERSION_PROSE}.`,
    classification: "missing_dependency",
  } as const;
  if (runtime.id === "node")
    return {
      ...check(
        "node",
        supportsNodeVersion(runtime.version),
        runtime.version,
        failure,
      ),
      details: { runtime: "node", version: runtime.version },
    };
  return {
    ...check(
      "node",
      supportsNodeVersion(runtime.nodeCompatibilityVersion),
      `Bun ${runtime.version} (Node.js ${runtime.nodeCompatibilityVersion} compatibility)`,
      failure,
    ),
    details: {
      runtime: "bun",
      version: runtime.version,
      node_compatibility_version: runtime.nodeCompatibilityVersion,
    },
  };
};

const hostCheck = async (host: DoctorHost): Promise<DoctorCheck> => {
  const macosVersion =
    host.platform === "darwin" ? await host.macosVersion() : undefined;
  const linuxDistribution =
    host.platform === "linux" ? await host.linuxDistribution() : undefined;
  const supported =
    (host.platform === "darwin" && parseMajor(macosVersion) >= 12) ||
    (host.platform === "linux" && supportsReaHost(linuxDistribution)) ||
    (host.platform === "win32" && host.architecture === "x64");
  const detail =
    macosVersion ??
    (linuxDistribution === undefined
      ? `${host.platform} ${host.architecture}`
      : `${linuxDistribution.id} ${linuxDistribution.versionId ?? "unknown"}`);
  return check("host", supported, detail, {
    remediation:
      "REA supports macOS 12+, Linux distributions with a recognized apt, dnf, or pacman package family, and the experimental Windows x64 Ghidra P0 boundary; automated Hopper setup additionally requires Ubuntu 24.04+, Fedora 41+, Nobara 44+, 64-bit Arch Linux, CachyOS, or Omarchy.",
    classification: "unsupported_host",
  });
};

const findHopper = async (host: DoctorHost): Promise<string | undefined> => {
  const candidates =
    host.configuredHopperPath === undefined
      ? [
          ...(host.platform === "darwin"
            ? macHopperCanonicalLauncherCandidates(host.homeDirectory)
            : [MAC_HOPPER_SYSTEM_LAUNCHER]),
          ...(host.platform === "linux"
            ? linuxHopperLauncherCandidates(host.homeDirectory)
            : [...systemLinuxHopperLauncherCandidates]),
          ...(host.platform === "darwin"
            ? []
            : macHopperCanonicalLauncherCandidates(host.homeDirectory).slice(
                1,
              )),
          ...(await host.manualHopperPaths()),
        ]
      : [host.configuredHopperPath];
  const hopperPath = await firstExecutable(host, candidates);
  if (hopperPath !== undefined || host.configuredHopperPath !== undefined)
    return hopperPath;
  const brewCandidate = await host.brewHopperPath();
  return firstExecutable(
    host,
    brewCandidate === undefined ? [] : [brewCandidate],
  );
};

const firstExecutable = async (
  host: DoctorHost,
  candidates: readonly string[],
): Promise<string | undefined> => {
  for (const candidate of new Set(candidates))
    if (await host.executable(candidate)) return candidate;
  return undefined;
};

const hopperCheck = (
  host: DoctorHost,
  hopperPath: string | undefined,
): DoctorCheck =>
  check(
    "hopper",
    hopperPath !== undefined,
    hopperPath ?? host.configuredHopperPath,
    {
      remediation:
        host.configuredHopperPath === undefined
          ? "Run rea setup to install Hopper, or set HOPPER_LAUNCHER_PATH."
          : "Unset or update HOPPER_LAUNCHER_PATH to an executable Hopper launcher.",
      classification:
        host.configuredHopperPath === undefined
          ? "missing_analysis_engine"
          : "config_drift",
    },
  );

const optionalHopperStartupTimeoutCheck = (
  host: DoctorHost,
): DoctorCheck | undefined => {
  if (host.configuredHopperStartupTimeout === undefined) return undefined;
  const parsed = providerStartupTimeoutSchema.safeParse(
    host.configuredHopperStartupTimeout,
  );
  return check(
    "hopper-startup-timeout",
    parsed.success,
    parsed.success
      ? `REA_HOPPER_STARTUP_TIMEOUT_MS=${String(parsed.data)}`
      : `REA_HOPPER_STARTUP_TIMEOUT_MS: ${parsed.error.issues.map(({ message }) => message).join("; ")}`,
    {
      classification: "config_drift",
      remediation:
        "Unset REA_HOPPER_STARTUP_TIMEOUT_MS to use the default, or set it to a positive decimal integer from 1 to 2147483647 milliseconds.",
    },
  );
};

const optionalHopperVersionCheck = async (
  host: DoctorHost,
  hopperPath: string | undefined,
): Promise<DoctorCheck | undefined> => {
  if (host.platform !== "linux" || hopperPath === undefined) return undefined;
  const inspected = await host.inspectLinuxHopper(hopperPath);
  const buildCheck = check("hopper-version", inspected.ok, hopperPath, {
    remediation: unsupportedHopperRemediation(
      host.configuredHopperPath === hopperPath,
    ),
    classification:
      !inspected.ok &&
      [
        "release_metadata",
        "download",
        "verification_unavailable",
        "cancelled",
        "cleanup_failed",
      ].includes(inspected.error.reason)
        ? "unknown"
        : "config_drift",
  });
  return {
    ...buildCheck,
    details: inspected.ok
      ? {
          reported_release_version: inspected.value.version,
          launcher_sha256: inspected.value.sha256,
          primary_fingerprint: inspected.value.primaryFingerprint,
          source: inspected.value.source,
        }
      : { reason: inspected.error.reason, message: inspected.error.message },
  };
};

const optionalHopperDemoCheck = async (
  host: DoctorHost,
  hopperPath: string | undefined,
): Promise<DoctorCheck | undefined> =>
  host.platform !== "linux" || hopperPath === undefined
    ? undefined
    : host.linuxDemoRuntimeCheck();

const optionalIlspyCheck = async (
  host: DoctorHost,
): Promise<DoctorCheck | undefined> => {
  if (host.configuredIlspyCmdPath === undefined) return undefined;
  const version = await host.ilspyCmdVersion?.(host.configuredIlspyCmdPath);
  return check(
    "ilspycmd",
    version !== undefined,
    version === undefined
      ? host.configuredIlspyCmdPath
      : `${host.configuredIlspyCmdPath} (${version})`,
    {
      remediation:
        "Unset REA_ILSPY_CMD_PATH or point it at a runnable ilspycmd executable.",
      classification: "config_drift",
    },
  );
};

const optionalTargetCheck = async (
  target: string | undefined,
  host: DoctorHost,
): Promise<DoctorCheck | undefined> =>
  target === undefined
    ? undefined
    : host.inspectTarget !== undefined
      ? host.inspectTarget(target)
      : check("target", await host.validTarget(target), target, {
          remediation: "Supply a readable local app or program path.",
          classification: "config_drift",
        });

const check = (
  name: string,
  ok: boolean,
  detail: string | undefined,
  failure: {
    readonly remediation: string;
    readonly classification: Exclude<DoctorCheck["classification"], "healthy">;
  },
): DoctorCheck => ({
  name,
  ok,
  classification: ok ? "healthy" : failure.classification,
  ...(detail === undefined ? {} : { detail }),
  ...(ok ? {} : { remediation: failure.remediation }),
});

const providerDoctorChecks = (
  inspection: DoctorProviderInspection,
): readonly DoctorCheck[] =>
  inspection.checks.map((candidate) => ({
    name:
      candidate.name === "configuration"
        ? inspection.id
        : `${inspection.id}-${candidate.name}`,
    ok: candidate.ok,
    classification: candidate.ok ? "healthy" : candidate.classification,
    detail: candidate.detail,
    ...(candidate.remediation === null
      ? {}
      : { remediation: candidate.remediation }),
    ...(candidate.details === undefined ? {} : { details: candidate.details }),
  }));

const unsupportedHopperRemediation = (configured: boolean): string =>
  configured
    ? "Check HOPPER_LAUNCHER_PATH and its publisher verification evidence. Run rea setup to install and retain an authenticated official Hopper package for offline use."
    : "Run rea setup to install and retain an authenticated official Hopper package for offline use.";

const parseMajor = (version: string | undefined): number =>
  Number.parseInt(version?.split(".")[0] ?? "0", 10);

const providerCheckName = (providerId: string, name: string): boolean =>
  name === providerId || name.startsWith(`${providerId}-`);
