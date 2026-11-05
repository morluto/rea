import {
  systemDoctorHost,
  type DoctorCheck,
  type DoctorHost,
} from "./application/Doctor.js";
import { fileURLToPath } from "node:url";
import { inspectJadxProvider } from "./android/JadxDoctor.js";
import { inspectSystemGhidraProvider } from "./ghidra/GhidraDoctor.js";
import { inspectIdaRegistration } from "./ida/IdaDoctor.js";
import { inspectAngrRegistration } from "./angr/AngrDoctor.js";
import {
  angrRequestBudgetMs,
  readAngrConfiguration,
} from "./angr/AngrConfiguration.js";
import { inspectKunaProvider } from "./kuna/KunaDoctor.js";
import { readIdaConfiguration } from "./ida/IdaConfiguration.js";
import { selectLinuxPrivateDisplayStrategy } from "./hopper/LinuxPrivateDisplayProbe.js";
import { ok, type Result } from "./domain/result.js";
import type { ConfigurationError } from "./domain/configurationErrors.js";
import { AnalysisCancelledError } from "./domain/analysisErrorCore.js";
import { ProviderCleanupError } from "./domain/providerCleanupError.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "./artifacts/AnalysisCleanupLease.js";
import { ArtifactResourceScope } from "./artifacts/ArtifactResourceScope.js";
import type { RetainedResourceScope } from "./application/AnalysisProvider.js";
import {
  inspectLinuxHopperPythonRuntime,
  linuxHopperPythonUnavailable,
} from "./application/LinuxHopperPython.js";

/** Compose provider diagnostics at the outer CLI adapter boundary. */
export const createSystemDoctorHost = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  signal?: AbortSignal,
): DoctorHost => {
  const registrationReads = new WeakMap<
    RetainedResourceScope,
    Map<string, ReturnType<typeof readIdaConfiguration>>
  >();
  const readRegistration = (
    path: string,
    resourceScope: RetainedResourceScope,
    inspectionSignal: AbortSignal,
  ) => {
    let byPath = registrationReads.get(resourceScope);
    if (byPath === undefined) {
      byPath = new Map();
      registrationReads.set(resourceScope, byPath);
    }
    let registration = byPath.get(path);
    if (registration === undefined) {
      registration = readIdaConfiguration(path, {
        resourceScope,
        signal: inspectionSignal,
      });
      byPath.set(path, registration);
    }
    return registration;
  };
  return systemDoctorHost({
    environment,
    ...(signal === undefined ? {} : { signal }),
    resolveProviderRequestBudget: async (
      analysisProvider,
      registrationEnvironment,
      resourceScope,
      inspectionSignal,
    ) => {
      const budgets: number[] = [];
      // An invalid registration cannot be selected automatically. Keep it out
      // of recommendations for another available provider, but surface the
      // parser-owned error when that provider itself was explicitly selected.
      if (analysisProvider === "ida" || analysisProvider === "auto") {
        const path = registrationEnvironment.REA_IDA_MCP_CONFIG;
        if (path !== undefined) {
          const registration = await readRegistration(
            path,
            resourceScope,
            inspectionSignal,
          );
          if (registration.ok) budgets.push(registration.value.timeoutMs);
          else if (analysisProvider === "ida") return registration;
        }
      }
      if (analysisProvider === "angr" || analysisProvider === "auto") {
        const angr = await readAngrBudget(
          registrationEnvironment,
          resourceScope,
          inspectionSignal,
        );
        if (angr?.ok === true) budgets.push(angr.value);
        else if (angr !== undefined && analysisProvider === "angr") return angr;
      }
      return ok(budgets.length === 0 ? undefined : Math.max(...budgets));
    },
    // Spans every inspection; see withAngrRegistrationScope.
    providerInspections: (resourceScope, inspectionSignal) =>
      withAngrRegistrationScope(resourceScope, async (angrScope) => [
        await inspectSystemGhidraProvider(
          environment,
          resourceScope,
          inspectionSignal,
        ),
        await inspectIdaRegistration(
          environment.REA_IDA_MCP_CONFIG,
          resourceScope,
          inspectionSignal,
          environment.REA_IDA_MCP_CONFIG === undefined
            ? undefined
            : readRegistration(
                environment.REA_IDA_MCP_CONFIG,
                resourceScope,
                inspectionSignal,
              ),
        ),
        await inspectJadxProvider(environment, resourceScope, inspectionSignal),
        await inspectAngrRegistration(
          angrSources(environment),
          angrScope,
          inspectionSignal,
        ),
        await inspectKunaProvider(environment, process.platform, {
          resourceScope,
          signal: inspectionSignal,
        }),
      ]),
    linuxDemoRuntimeCheck: (resourceScope, inspectionSignal) =>
      inspectLinuxHopperDemoRuntime(
        environment,
        resourceScope,
        inspectionSignal,
      ),
  });
};

const HOPPER_DEMO_HELPER_PATH = fileURLToPath(
  new URL("../scripts/hopper-demo-x11.py", import.meta.url),
);

const inspectLinuxHopperDemoRuntime = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  resourceScope: RetainedResourceScope,
  signal?: AbortSignal,
): Promise<DoctorCheck> => {
  const selection = await selectLinuxPrivateDisplayStrategy({
    helperPath: HOPPER_DEMO_HELPER_PATH,
    environment,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!selection.ok && selection.cleanup !== undefined) {
    const { lease, reason } = selection.cleanup;
    resourceScope.retain(
      {
        close: () => lease.release(),
        get cleanupResources() {
          return lease.cleanupResources;
        },
      },
      "hopper-private-display-probe",
    );
    const cleanup = {
      reason,
      resources: [
        ...(lease.cleanupResources ?? ["hopper-private-display-probe"]),
      ],
    };
    const diagnostics = {
      hopper_demo_runtime: { private_display: { ...selection.diagnostic } },
    };
    const failure =
      signal?.aborted === true
        ? new AnalysisCancelledError("doctor", {
            cause: signal.reason,
            cleanup,
            diagnostics,
          })
        : new ProviderCleanupError(
            "hopper",
            cleanup.resources,
            { reason, ...diagnostics },
            { operation: "doctor" },
          );
    new AnalysisCleanupLeaseGroup(failure, [lease]);
    throw failure;
  }
  if (signal?.aborted === true)
    throw new AnalysisCancelledError("doctor", {
      cause: signal.reason,
      diagnostics: {
        hopper_demo_runtime: { private_display: { ...selection.diagnostic } },
      },
    });
  const python = await inspectLinuxHopperPythonRuntime(environment, signal);
  const pythonFailure = !python.ok
    ? python.error
    : python.value.library.status !== "loadable"
      ? linuxHopperPythonUnavailable(python.value.library)
      : undefined;
  const pythonDiagnostic = {
    scope: "system_interpreter",
    hopper_interpreter: "unknown",
    ...(python.ok
      ? { status: "observed", ...python.value }
      : {
          status: "unknown",
          reason: python.error.reason,
          message: python.error.message,
        }),
  };
  const value = selection.diagnostic;
  const detail = [
    `strategy=${selection.strategy}`,
    `socket_directory=${value.socket_directory}`,
    `mode=${value.socket_directory_mode ?? "unknown"}`,
    `mount_read_only=${String(value.mount_read_only)}`,
    `effective_mode=${value.effective_socket_directory_mode ?? "unknown"}`,
    `effective_mount_read_only=${String(value.effective_mount_read_only)}`,
    `wsl=${String(value.wsl)}`,
    `system_python=${python.ok ? python.value.library.status : "unknown"}`,
  ].join("; ");
  const details = {
    private_display: { ...value },
    embedded_python: pythonDiagnostic,
  };
  if (!python.ok && python.error.reason === "cancelled")
    throw new AnalysisCancelledError("doctor", {
      cause: python.error.cause,
      diagnostics: { hopper_demo_runtime: details },
    });
  if (selection.ok && pythonFailure === undefined)
    return {
      name: "hopper-demo-runtime",
      ok: true,
      classification: "healthy",
      detail,
      details,
    };
  const missingDependency =
    value.failure_code === "runtime_dependency_unavailable" ||
    value.failure_code === "x11_authorization_failed" ||
    (python.ok && python.value.library.status === "unavailable");
  const pythonRemediation =
    pythonFailure === undefined
      ? undefined
      : pythonFailure.reason === "runtime_unavailable"
        ? pythonFailure.message +
          " On a supported system run rea setup --install-hopper, then rerun rea doctor --provider hopper. This checks the system interpreter; a custom Hopper Python interpreter needs its own matching shared runtime."
        : pythonFailure.reason === "configuration_unknown"
          ? pythonFailure.message +
            " Inspect this interpreter's shared-runtime configuration, then rerun rea doctor --provider hopper."
          : pythonFailure.message +
            " Retry rea doctor --provider hopper and inspect /usr/bin/python3 if its runtime remains unknown.";
  const displayRemediation = selection.ok
    ? undefined
    : value.failure_code === "x11_socket_directory_unusable"
      ? "Enable unprivileged user and mount namespaces, or provide a writable mode-1777 /tmp/.X11-unix directory. Do not mutate the current host mount with sudo; then rerun rea doctor --provider hopper."
      : value.failure_code === "runtime_dependency_unavailable" ||
          value.failure_code === "x11_authorization_failed"
        ? "Install Xvfb, xauth, Python 3, libX11, and libXtst, then rerun rea doctor --provider hopper."
        : "Inspect the private-display diagnostic, correct the reported local condition, and rerun rea doctor --provider hopper.";
  return {
    name: "hopper-demo-runtime",
    ok: false,
    classification: missingDependency
      ? "missing_dependency"
      : selection.ok
        ? "unknown"
        : "config_drift",
    detail,
    details,
    remediation: [pythonRemediation, displayRemediation]
      .filter((message) => message !== undefined)
      .join(" "),
  };
};

/** angr's request budget for a registration, or undefined when none is set. */
const readAngrBudget = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  resourceScope: RetainedResourceScope,
  signal: AbortSignal,
): Promise<Result<number, ConfigurationError> | undefined> => {
  if (
    environment.REA_ANGR_MCP_CONFIG === undefined &&
    environment.REA_ANGR_PYTHON === undefined
  )
    return undefined;
  const registration = await withAngrRegistrationScope(
    resourceScope,
    (angrScope) =>
      readAngrConfiguration(angrSources(environment), {
        resourceScope: angrScope,
        signal,
      }),
  );
  return registration.ok
    ? ok(angrRequestBudgetMs(registration.value))
    : registration;
};

const angrSources = (environment: Readonly<NodeJS.ProcessEnv>) => ({
  mcpConfigPath: environment.REA_ANGR_MCP_CONFIG,
  pythonPath: environment.REA_ANGR_PYTHON,
});

/**
 * Give one operation's angr registration reads their own scope. A failed
 * close retained directly in the doctor's scope would make the next nested
 * run wait for its own caller, so it moves there only after the operation
 * settles. Concurrent operations never share a scope.
 */
const withAngrRegistrationScope = async <T>(
  parent: RetainedResourceScope,
  operation: (scope: RetainedResourceScope) => Promise<T>,
): Promise<T> => {
  const resources = new ArtifactResourceScope();
  try {
    return await operation({
      retain: (owner, resource) =>
        resources.retain({
          kind: "lease",
          resource,
          lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
        }),
      run: (run) => resources.run(run),
    });
  } finally {
    if (resources.hasPending)
      parent.retain(
        {
          close: () => resources.close(),
          get cleanupResources() {
            return resources.cleanupResources;
          },
        },
        "angr-registration",
      );
  }
};
