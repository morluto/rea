import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import {
  inspectGhidraInstallation,
  type GhidraInstallationCheck,
  type GhidraInstallationInspection,
} from "./GhidraInstallation.js";

/** Project adapter-owned installation facts into the generic doctor contract. */
export const projectGhidraDoctorInspection = (
  inspection: GhidraInstallationInspection,
): DoctorProviderInspection => ({
  id: "ghidra",
  configured: inspection.installDir !== null,
  available: inspection.status === "available",
  providerVersion: inspection.providerVersion,
  registrationEnvironment:
    inspection.status === "available"
      ? {
          GHIDRA_INSTALL_DIR: inspection.installDir,
          JAVA_HOME: inspection.javaHome,
        }
      : {},
  checks: selectedChecks(inspection).map((check) =>
    projectCheck(check, inspection.installDir !== null),
  ),
});

/** Inspect the process-configured BYO Ghidra installation for `rea doctor`. */
export const inspectSystemGhidraProvider =
  (): Promise<DoctorProviderInspection> =>
    Promise.resolve(
      projectGhidraDoctorInspection(
        inspectGhidraInstallation({
          ...(process.env.GHIDRA_INSTALL_DIR === undefined
            ? {}
            : { installDir: process.env.GHIDRA_INSTALL_DIR }),
          ...(process.env.JAVA_HOME === undefined
            ? {}
            : { javaHome: process.env.JAVA_HOME }),
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
      ? [byName.get("version"), byName.get("headless")]
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
