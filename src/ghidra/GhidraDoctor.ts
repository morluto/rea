import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import {
  hasWindowsNativeAuthority,
  windowsNativeAuthorityUnavailableReason,
} from "../process/WindowsAuthority.js";
import {
  inspectGhidraInstallation,
  type GhidraInstallationCheck,
  type GhidraInstallationInspection,
} from "./GhidraInstallation.js";

/** Project installation and runtime-authority facts into the doctor contract. */
export const projectGhidraDoctorInspection = (
  inspection: GhidraInstallationInspection,
): DoctorProviderInspection => {
  const windowsAuthorityUnavailable =
    inspection.status === "available" &&
    inspection.platform === "win32" &&
    !hasWindowsNativeAuthority(inspection.platform);
  return {
    id: "ghidra",
    configured: inspection.installDir !== null,
    available:
      inspection.status === "available" && !windowsAuthorityUnavailable,
    providerVersion: inspection.providerVersion,
    registrationEnvironment:
      inspection.status === "available"
        ? {
            GHIDRA_INSTALL_DIR: inspection.installDir,
            JAVA_HOME: inspection.javaHome,
          }
        : {},
    checks: [
      ...selectedChecks(inspection).map((check) =>
        projectCheck(check, inspection.installDir !== null),
      ),
      ...(inspection.status === "available" && inspection.platform === "win32"
        ? [
            {
              name: "native_authority",
              ok: !windowsAuthorityUnavailable,
              code: windowsAuthorityUnavailable ? "unsupported_host" : null,
              detail: windowsAuthorityUnavailable
                ? windowsNativeAuthorityUnavailableReason(inspection.platform)
                : "Verified Windows native Job Object, private DACL, and reparse-safe handle controls; local NTFS only.",
              remediation: windowsAuthorityUnavailable
                ? "Use the matching Windows x64 REA package with its bundled native addon and a writable local NTFS temporary directory. The native failure above identifies the failed constraint; Ghidra installation or registration changes cannot enable a missing native backend."
                : null,
              classification: "unsupported_host" as const,
            },
          ]
        : []),
    ],
  };
};

/** Inspect the process-configured BYO Ghidra installation for `rea doctor`. */
export const inspectSystemGhidraProvider = (
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<DoctorProviderInspection> =>
  Promise.resolve(
    projectGhidraDoctorInspection(
      inspectGhidraInstallation({
        environment,
        ...(environment.GHIDRA_INSTALL_DIR === undefined
          ? {}
          : { installDir: environment.GHIDRA_INSTALL_DIR }),
        ...(environment.JAVA_HOME === undefined
          ? {}
          : { javaHome: environment.JAVA_HOME }),
      }),
    ),
  );

const selectedChecks = (
  inspection: GhidraInstallationInspection,
): readonly GhidraInstallationCheck[] => {
  const byName = new Map(
    inspection.checks.map((candidate) => [candidate.name, candidate]),
  );
  const configuration = byName.get("configuration");
  if (configuration === undefined) return [];
  if (configuration.status === "failed") return [configuration];
  const installation = byName.get("installation");
  return [
    configuration,
    byName.get("platform"),
    byName.get("architecture"),
    installation,
    ...(installation?.status === "passed"
      ? [
          byName.get("version"),
          byName.get("headless"),
          byName.get("native_decompiler"),
        ]
      : []),
    byName.get("java"),
  ].filter((candidate): candidate is GhidraInstallationCheck =>
    Boolean(candidate),
  );
};

const projectCheck = (
  check: GhidraInstallationCheck,
  configured: boolean,
): DoctorProviderCheck => ({
  name: check.name,
  ok: check.status === "passed",
  code: check.status === "failed" ? check.code : null,
  detail: check.detail,
  remediation: check.status === "failed" ? check.remediation : null,
  classification:
    check.name === "platform" || check.name === "architecture"
      ? "unsupported_host"
      : check.name === "java" &&
          check.status === "failed" &&
          check.code === "runtime_missing"
        ? "missing_dependency"
        : configured
          ? "config_drift"
          : "missing_analysis_engine",
});
