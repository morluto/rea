import {
  systemDoctorHost,
  type DoctorCheck,
  type DoctorHost,
  type DoctorProviderInspection,
} from "./application/Doctor.js";
import { fileURLToPath } from "node:url";
import { inspectJadxProvider } from "./android/JadxDoctor.js";
import { inspectSystemGhidraProvider } from "./ghidra/GhidraDoctor.js";
import { inspectIdaRegistration } from "./ida/IdaDoctor.js";
import { inspectKunaProvider } from "./kuna/KunaDoctor.js";
import { readIdaConfiguration } from "./ida/IdaConfiguration.js";
import { selectLinuxPrivateDisplayStrategy } from "./hopper/LinuxPrivateDisplayProbe.js";
import { ok } from "./domain/result.js";
import { AnalysisCancelledError } from "./domain/analysisErrorCore.js";
import { ProviderCleanupError } from "./domain/providerCleanupError.js";
import { AnalysisCleanupLeaseGroup } from "./artifacts/AnalysisCleanupLease.js";
import type { RetainedResourceScope } from "./application/AnalysisProvider.js";
import { RegularFileCleanupFailure } from "./filesystem/OwnedRegularFile.js";
import { readEffectiveClientRegistrationConfiguration } from "./application/ClientConfigurationFiles.js";
import { clientRegistrationEnvironmentDetails } from "./application/ClientRegistrationEnvironment.js";
import { supportedClients } from "./application/SupportedClients.js";
import { homeDirectoryFromEnvironment } from "./config/homeDirectory.js";
import {
  inspectLinuxHopperPythonRuntime,
  linuxHopperPythonUnavailable,
} from "./application/LinuxHopperPython.js";

/**
 * A selected client's own environment, when its registration records one.
 * Provider checks read the terminal by default; a caller that asked about one
 * client wants the values that client passes to the server it starts.
 */
interface SelectedRegistrationEnvironment {
  /** The terminal a selected client inherits, overlaid by its registration. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Names the client records as expressions this process cannot evaluate. */
  readonly unresolved: ReadonlySet<string>;
}

const selectedRegistrationEnvironment = async (
  clients: readonly string[],
  processEnvironment: Readonly<NodeJS.ProcessEnv>,
  resourceScope: RetainedResourceScope,
  signal: AbortSignal,
): Promise<SelectedRegistrationEnvironment | undefined> => {
  const [selected] = clients;
  // Only an unambiguous selection can stand for the terminal's environment.
  if (selected === undefined || clients.length !== 1) return undefined;
  signal.throwIfAborted();
  const home = homeDirectoryFromEnvironment(
    processEnvironment,
    process.platform,
  );
  const client = supportedClients(
    home,
    process.platform,
    processEnvironment,
  ).find(({ name }) => name === selected);
  if (client === undefined || client.format === "unsupported") return undefined;
  const registered = await readSelectedRegistration(
    client,
    resourceScope,
    process.platform,
  );
  // Absent, unreadable, or unresolvable: the terminal is the only environment
  // this process can honestly describe.
  if (registered === undefined) return undefined;
  return {
    environment: registered.values,
    unresolved: registered.unresolvedSettings,
  };
};

type SelectedRegistration = {
  readonly values: Readonly<Record<string, string>>;
  readonly unresolvedSettings: ReadonlySet<string>;
};

/** Read the selected client's registration, or report it as unreadable. */
const readSelectedRegistration = async (
  client: Parameters<typeof readEffectiveClientRegistrationConfiguration>[0],
  resourceScope: RetainedResourceScope,
  platform: NodeJS.Platform,
): Promise<SelectedRegistration | undefined> => {
  // A failed close is a retained owner, not a read outcome: transfer it to the
  // caller's scope so `close()` retries it instead of losing it.
  const configuration = await resourceScope
    .run(() =>
      readEffectiveClientRegistrationConfiguration(client, undefined, platform),
    )
    .catch((cause: unknown) => {
      if (cause instanceof RegularFileCleanupFailure) {
        resourceScope.retain(cause.owner, cause.path);
        return undefined;
      }
      throw cause;
    });
  // A registration this process cannot read says nothing about the values the
  // client passes on; the terminal is not those values.
  if (configuration === undefined || !configuration.ok) return undefined;
  const details = clientRegistrationEnvironmentDetails(
    configuration.value.document,
    {},
    "effective",
    platform,
  );
  return details.ok
    ? {
        values: details.value.values,
        unresolvedSettings: details.value.unresolvedSettings,
      }
    : undefined;
};

/**
 * The terminal, overlaid by the selected registration's own values. A client
 * whose registration carries only a setting or two still inherits what the
 * ambient run exported; its recorded values win where they exist.
 *
 * A name the registration records as an expression stays unknown: probing with
 * the terminal's value would certify a setting the client owns and this
 * process cannot read. The provider then reports it as unconfigured, which is
 * the honest answer for a chain that resolves outside REA.
 */
const selectedProviderSettings = (
  selected: SelectedRegistrationEnvironment | undefined,
  terminal: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> => {
  if (selected === undefined) return terminal;
  const settings: NodeJS.ProcessEnv = {
    ...terminal,
    ...selected.environment,
  };
  for (const name of selected.unresolved) delete settings[name];
  return settings;
};

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
      if (analysisProvider !== "ida" && analysisProvider !== "auto")
        return ok(undefined);
      const path = registrationEnvironment.REA_IDA_MCP_CONFIG;
      if (path === undefined) return ok(undefined);
      const registration = await readRegistration(
        path,
        resourceScope,
        inspectionSignal,
      );
      if (registration.ok) return ok(registration.value.timeoutMs);
      // An invalid IDA registration cannot be selected automatically. Keep it
      // out of recommendations for another available provider, but surface the
      // parser-owned error when IDA itself was explicitly selected.
      return analysisProvider === "ida" ? registration : ok(undefined);
    },
    providerInspections: async (
      resourceScope: RetainedResourceScope,
      inspectionSignal: AbortSignal,
      clients: readonly string[],
    ) => {
      const selected = await selectedRegistrationEnvironment(
        clients,
        environment,
        resourceScope,
        inspectionSignal,
      );
      const inspectionEnvironment = selectedProviderSettings(
        selected,
        environment,
      );
      return [
        await inspectSystemGhidraProvider(
          inspectionEnvironment,
          resourceScope,
          inspectionSignal,
        ),
        await inspectIdaRegistration(
          inspectionEnvironment.REA_IDA_MCP_CONFIG,
          resourceScope,
          inspectionSignal,
          inspectionEnvironment.REA_IDA_MCP_CONFIG === undefined
            ? undefined
            : readRegistration(
                inspectionEnvironment.REA_IDA_MCP_CONFIG,
                resourceScope,
                inspectionSignal,
              ),
        ),
        await inspectJadxProvider(
          inspectionEnvironment,
          resourceScope,
          inspectionSignal,
        ),
        await inspectKunaProvider(inspectionEnvironment, process.platform, {
          resourceScope,
          signal: inspectionSignal,
        }),
      ] satisfies readonly DoctorProviderInspection[];
    },
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
