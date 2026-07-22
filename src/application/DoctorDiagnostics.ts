import { homedir } from "node:os";

import { supportsNodeVersion } from "../domain/runtimeVersion.js";
import { linuxHopperLauncherPath } from "./LinuxHopper.js";
import type {
  DoctorCheck,
  DoctorHost,
  DoctorProviderInspection,
} from "./Doctor.js";
import type { RuntimeExecutableInventory } from "./RuntimeExecutableDiagnostics.js";

const DEFAULT_HOPPER =
  "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
const SYSTEM_LINUX_HOPPER = "/opt/hopper/bin/Hopper";

/** Ordered environment diagnostics consumed by the Doctor report assembler. */
export interface DoctorDiagnostics {
  readonly checks: readonly DoctorCheck[];
  readonly hopperPath?: string;
  readonly providerInspections?: readonly DoctorProviderInspection[];
  readonly runtimeExecutables?: RuntimeExecutableInventory;
}

/** Collect host, provider, and optional-target diagnostics without mutation. */
export const collectDoctorDiagnostics = async (
  target: string | undefined,
  host: DoctorHost,
): Promise<DoctorDiagnostics> => {
  const runtimeExecutables = await host.runtimeExecutables?.();
  const checks: DoctorCheck[] = [
    nodeCheck(host),
    ...runtimeChecks(runtimeExecutables),
  ];
  checks.push(await hostCheck(host));

  const hopperPath = await findHopper(host);
  checks.push(hopperCheck(host, hopperPath));
  const hopperVersionCheck = await optionalHopperVersionCheck(host, hopperPath);
  if (hopperVersionCheck !== undefined) checks.push(hopperVersionCheck);

  const providerInspections = await host.providerInspections?.();
  if (providerInspections !== undefined)
    checks.push(...providerInspections.flatMap(providerDoctorChecks));

  const javascriptReplayCheck = await host.javascriptReplayCheck?.();
  if (javascriptReplayCheck !== undefined) checks.push(javascriptReplayCheck);
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
    ...(runtimeExecutables === undefined ? {} : { runtimeExecutables }),
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

const nodeCheck = (host: DoctorHost): DoctorCheck =>
  check("node", supportsNodeVersion(host.nodeVersion), host.nodeVersion, {
    remediation: "Install Node.js 22.19+ or 24.11+.",
    classification: "missing_dependency",
  });

const runtimeChecks = (
  inventory: RuntimeExecutableInventory | undefined,
): readonly DoctorCheck[] => {
  if (inventory === undefined) return [];
  const broken = inventory.candidates.filter(({ healthy }) => !healthy);
  const detail =
    broken.length === 0
      ? `${String(inventory.candidates.length)} runtime executable candidates passed bounded version probes.`
      : `${String(broken.length)} of ${String(inventory.candidates.length)} runtime executable candidates failed bounded version probes: ${broken
          .slice(0, 5)
          .map(({ lexical_path: path }) => path)
          .join(", ")}${broken.length > 5 ? ", …" : ""}`;
  return [
    check("node-toolchains", broken.length === 0, detail, {
      remediation:
        "Select a verified healthy Node toolchain or repair the failing installation, then rerun rea doctor. Do not create compatibility-library symlinks.",
      classification: "missing_dependency",
    }),
  ];
};

const hostCheck = async (host: DoctorHost): Promise<DoctorCheck> => {
  const macosVersion =
    host.platform === "darwin" ? await host.macosVersion() : undefined;
  const linuxDistribution =
    host.platform === "linux" ? await host.linuxDistribution() : undefined;
  const supported =
    (host.platform === "darwin" && parseMajor(macosVersion) >= 12) ||
    (host.platform === "linux" && linuxDistribution?.supported === true) ||
    (host.platform === "win32" && host.architecture === "x64");
  const detail =
    macosVersion ??
    (linuxDistribution === undefined
      ? `${host.platform} ${host.architecture}`
      : `${linuxDistribution.id} ${linuxDistribution.versionId ?? "unknown"}`);
  return check("host", supported, detail, {
    remediation:
      "REA supports macOS 12+, Ubuntu 24.04+, Fedora 41+, 64-bit Arch Linux, and the experimental Windows x64 Ghidra P0 boundary.",
    classification: "unsupported_host",
  });
};

const findHopper = async (host: DoctorHost): Promise<string | undefined> => {
  const candidates =
    host.configuredHopperPath === undefined
      ? [
          DEFAULT_HOPPER,
          SYSTEM_LINUX_HOPPER,
          linuxHopperLauncherPath(homedir()),
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

const optionalHopperVersionCheck = async (
  host: DoctorHost,
  hopperPath: string | undefined,
): Promise<DoctorCheck | undefined> => {
  if (host.platform !== "linux" || hopperPath === undefined) return undefined;
  return check(
    "hopper-version",
    await host.supportedLinuxHopper(hopperPath),
    hopperPath,
    {
      remediation: unsupportedHopperRemediation(
        host.configuredHopperPath === hopperPath,
      ),
      classification: "config_drift",
    },
  );
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
  }));

const unsupportedHopperRemediation = (configured: boolean): string =>
  configured
    ? "Unset or update HOPPER_LAUNCHER_PATH, install the Hopper build supported by this REA release, or update REA."
    : "Install the Hopper build supported by this REA release, or update REA for a newer Hopper build.";

const parseMajor = (version: string | undefined): number =>
  Number.parseInt(version?.split(".")[0] ?? "0", 10);

const providerCheckName = (providerId: string, name: string): boolean =>
  name === providerId || name.startsWith(`${providerId}-`);
