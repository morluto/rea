import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisClientFailureForOperation } from "../providers/AnalysisClientFailure.js";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import type {
  DoctorProviderCheck,
  DoctorProviderInspection,
} from "../application/Doctor.js";
import { inspectWindowsNativeReadiness } from "../process/WindowsAuthority.js";
import {
  inspectGhidraInstallation,
  type GhidraInstallationCheck,
  type GhidraInstallationInspection,
} from "./GhidraInstallation.js";
import {
  GHIDRA_RESTRICTED_TEMP_REMEDIATION,
  probeGhidraTemporaryDirectory,
  type GhidraTemporaryDirectoryProbe,
} from "./GhidraTemporaryDirectory.js";

/** Project installation and runtime-authority facts into the doctor contract. */
export const projectGhidraDoctorInspection = (
  inspection: GhidraInstallationInspection,
  temporaryDirectory?: GhidraTemporaryDirectoryProbe,
): DoctorProviderInspection => {
  const readiness =
    inspection.status === "available" && inspection.platform === "win32"
      ? inspectWindowsNativeReadiness(inspection.platform)
      : undefined;
  const windowsAuthorityUnavailable = readiness?.available === false;
  const temporaryDirectoryUnavailable = temporaryDirectory?.ok === false;
  return {
    id: "ghidra",
    configured: inspection.installDir !== null,
    available:
      inspection.status === "available" &&
      !windowsAuthorityUnavailable &&
      !temporaryDirectoryUnavailable,
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
        projectCheck(
          check,
          inspection.installDir !== null,
          inspection.javaProbeFailure,
          inspection.nativeDecompilerHeaderFailure,
        ),
      ),
      ...(readiness !== undefined
        ? [
            {
              name: "native_authority",
              ok: !windowsAuthorityUnavailable,
              code: !readiness.available ? readiness.code : null,
              detail: !readiness.available
                ? readiness.reason
                : "Verified Windows native Job Object, private DACL, and reparse-safe handle controls; local NTFS only.",
              remediation: !readiness.available ? readiness.remediation : null,
              classification:
                !readiness.available && readiness.code === "runtime_unavailable"
                  ? ("runtime_failure" as const)
                  : !readiness.available && readiness.code === "runtime_missing"
                    ? ("missing_dependency" as const)
                    : ("unsupported_host" as const),
            },
          ]
        : []),
      ...(temporaryDirectory === undefined
        ? []
        : [temporaryDirectoryCheck(temporaryDirectory)]),
    ],
  };
};

/** Report the REA-process write probe without claiming child-process access. */
const temporaryDirectoryCheck = (
  probe: GhidraTemporaryDirectoryProbe,
): DoctorProviderCheck =>
  probe.ok
    ? {
        name: "temp_directory",
        ok: true,
        code: null,
        detail: `REA created and deleted a file under the Ghidra session root ${probe.directory}, where session runtimes are created. This does not test writes by Ghidra's child JVM.`,
        remediation: null,
        classification: "runtime_failure",
      }
    : {
        name: "temp_directory",
        ok: false,
        code: "temp_directory_unwritable",
        detail: `REA could not ${probe.stage === "write" ? "write" : "delete"} a probe file under the Ghidra session root ${probe.directory}, where session runtimes are created${probe.code === undefined ? "" : ` (${probe.code})`}: ${probe.message}${probe.retainedPath === undefined ? "" : `. The probe file ${probe.retainedPath} remains; REA retains its cleanup and retries removal when doctor finishes.`}`,
        remediation: GHIDRA_RESTRICTED_TEMP_REMEDIATION,
        classification: "runtime_failure",
        details: {
          directory: probe.directory,
          stage: probe.stage,
          ...(probe.code === undefined ? {} : { system_code: probe.code }),
          ...(probe.retainedPath === undefined
            ? {}
            : { retained_path: probe.retainedPath }),
        },
      };

/** Inspect the process-configured BYO Ghidra installation for `rea doctor`. */
export const inspectSystemGhidraProvider = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  resourceOwner: RetainedResourceScope,
  signal?: AbortSignal,
  probeTemporaryDirectory: (
    resourceOwner: RetainedResourceScope,
  ) => Promise<GhidraTemporaryDirectoryProbe> = probeGhidraTemporaryDirectory,
): Promise<DoctorProviderInspection> => {
  try {
    const installation = await inspectGhidraInstallation({
      environment,
      resourceOwner,
      ...(signal === undefined ? {} : { signal }),
      ...(environment.GHIDRA_INSTALL_DIR === undefined
        ? {}
        : { installDir: environment.GHIDRA_INSTALL_DIR }),
      ...(environment.JAVA_HOME === undefined
        ? {}
        : { javaHome: environment.JAVA_HOME }),
    });
    // The restricted-host denial reported for #7075 is Windows-specific.
    const temporaryDirectory =
      installation.status === "available" && installation.platform === "win32"
        ? await probeTemporaryDirectory(resourceOwner)
        : undefined;
    return projectGhidraDoctorInspection(installation, temporaryDirectory);
  } catch (cause: unknown) {
    throw analysisClientFailureForOperation(cause, "ghidra", "doctor");
  }
};

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
  javaFailure: GhidraInstallationInspection["javaProbeFailure"],
  headerFailure: GhidraInstallationInspection["nativeDecompilerHeaderFailure"],
): DoctorProviderCheck => ({
  name: check.name,
  ok: check.status === "passed",
  code: check.status === "failed" ? check.code : null,
  detail: check.detail,
  ...(check.name === "java" && javaFailure?.output !== undefined
    ? {
        details: {
          output: { ...javaFailure.output },
          ...(javaFailure.processErrorCode === undefined
            ? {}
            : { process_error_code: javaFailure.processErrorCode }),
          ...(javaFailure.properties === undefined
            ? {}
            : { properties: { ...javaFailure.properties } }),
        },
      }
    : {}),
  ...(check.name === "native_decompiler" && headerFailure !== undefined
    ? { details: { header_failure: projectAnalysisError(headerFailure) } }
    : {}),
  remediation: check.status === "failed" ? check.remediation : null,
  classification:
    check.name === "platform" || check.name === "architecture"
      ? "unsupported_host"
      : check.name === "java" &&
          check.status === "failed" &&
          check.code === "runtime_missing"
        ? "missing_dependency"
        : check.name === "java" &&
            check.status === "failed" &&
            check.code === "runtime_unavailable"
          ? "runtime_failure"
          : configured
            ? "config_drift"
            : "missing_analysis_engine",
});
