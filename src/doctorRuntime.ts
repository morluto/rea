import { HOST_PLATFORM, type HostPlatform } from "./platform/HostPlatform.js";
import {
  systemDoctorHost,
  type DoctorHost,
  type DoctorProviderConfiguration,
  type RetainedProviderRequestBudgetResolver,
} from "./application/Doctor.js";
import type {
  DoctorCheck,
  DoctorProviderInspection,
} from "./ports/DoctorProviderInspection.js";
import { fileURLToPath } from "node:url";
import { readDesktopBuildFacts } from "./desktop/DesktopBuildDoctorFacts.js";
import {
  JADX_DOCTOR_SETTINGS,
  inspectJadxProvider,
} from "./android/JadxDoctor.js";
import {
  GHIDRA_DOCTOR_SETTINGS,
  inspectSystemGhidraProvider,
} from "./ghidra/GhidraDoctor.js";
import {
  IDA_DOCTOR_SETTINGS,
  inspectIdaRegistration,
} from "./ida/IdaDoctor.js";
import {
  KUNA_DOCTOR_SETTINGS,
  inspectKunaProvider,
  kunaSettingAffectsProbe,
} from "./kuna/KunaDoctor.js";
import {
  inspectLeandecProvider,
  LEANDEC_DOCTOR_SETTINGS,
} from "./leandec/LeandecDoctor.js";
import { readIdaConfiguration } from "./ida/IdaConfiguration.js";
import { selectLinuxPrivateDisplayStrategy } from "./hopper/LinuxPrivateDisplayProbe.js";
import { ok } from "./domain/result.js";
import type { ConfigurationError } from "./domain/configurationErrors.js";
import { cancelledBy, carriedReason } from "./domain/analysisErrorCore.js";
import { ProviderCleanupError } from "./domain/providerCleanupError.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
  ArtifactResourceScope,
} from "./resources/index.js";
import type { RetainedResourceScope } from "./ports/AnalysisProvider.js";
import { RegularFileCleanupFailure } from "./filesystem/OwnedRegularFile.js";
import {
  hasProjectRegistrationContribution,
  readEffectiveClientRegistrationConfiguration,
} from "./application/ClientConfigurationFiles.js";
import { clientRegistrationEnvironmentDetails } from "./application/ClientRegistrationEnvironment.js";
import {
  mergeEnvironmentOverrides,
  omitEnvironmentSettings,
  snapshotEnvironment,
} from "./process/snapshotEnvironment.js";
import { resolveSupportedClients } from "./application/SupportedClients.js";
import { homeDirectoryFromEnvironment } from "./config/homeDirectory.js";
import {
  applyUserConfigurationDefaults,
  PERSISTED_SETTINGS,
  type UserSettings,
} from "./config/userConfig.js";
import {
  userConfigFilePath,
  userConfigLocationSettings,
} from "./application/UserConfigurationLocation.js";
import { loadUserConfigurationDefaults } from "./application/UserConfigurationStore.js";
import {
  inspectLinuxHopperPythonRuntime,
  linuxHopperPythonUnavailable,
} from "./application/LinuxHopperPython.js";
import { settleConcurrent } from "./application/settleConcurrent.js";

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
  /** Why registration settings cannot authorize provider probes. */
  readonly unavailable?: RegistrationProbeRefusal;
}

type RegistrationProbeRefusal = "unreadable" | "project_scope";

const selectedRegistrationEnvironment = async (
  clients: readonly string[],
  processEnvironment: Readonly<NodeJS.ProcessEnv>,
  resourceScope: RetainedResourceScope,
  signal: AbortSignal,
  platform: NodeJS.Platform,
  projectDirectory: string | undefined,
): Promise<SelectedRegistrationEnvironment | undefined> => {
  const [selected] = clients;
  // Only an unambiguous selection can stand for the terminal's environment.
  if (selected === undefined || clients.length !== 1) return undefined;
  signal.throwIfAborted();
  const home = homeDirectoryFromEnvironment(processEnvironment, platform);
  const client = (
    await resolveSupportedClients(home, platform, processEnvironment)
  ).find(({ name }) => name === selected);
  if (client === undefined)
    return {
      environment: {},
      unresolved: new Set(),
      unavailable: "unreadable",
    };
  // Manual connectors have no local overlay, but host diagnostics still apply.
  if (client.format === "unsupported") return undefined;
  const registered = await readSelectedRegistration(
    client,
    resourceScope,
    platform,
    projectDirectory,
  );
  if (registered === undefined) return undefined;
  if ("unavailable" in registered)
    return {
      environment: {},
      unresolved: new Set(),
      unavailable: registered.unavailable,
    };
  return {
    environment: registered.values,
    unresolved: registered.unresolvedSettings,
  };
};

const registrationEnvironmentOverlay = (
  inherited: Readonly<NodeJS.ProcessEnv>,
  registration: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): Readonly<NodeJS.ProcessEnv> =>
  snapshotEnvironment(
    mergeEnvironmentOverrides(inherited, registration, platform),
    platform,
  );

/**
 * Fold a selected registration and the terminal it inherits into the canonical
 * names a provider check reads: the registration's recorded values win, names
 * it records as unreadable expressions are dropped, and everything else
 * survives from the terminal.
 *
 * Windows treats setting names case-insensitively, so a registration recording
 * `ghidra_install_dir` must override the terminal's `GHIDRA_INSTALL_DIR`
 * rather than sit beside it, and a dropped expression must be found under
 * either spelling. `snapshotEnvironment` performs that fold;
 * `mergeEnvironmentOverrides` alone keeps the winning layer's spelling.
 */
export const selectedProviderSettings = (
  selected: SelectedRegistrationEnvironment | undefined,
  terminal: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): Readonly<Record<string, string | undefined>> => {
  if (selected === undefined) return terminal;
  const settings: Record<string, string | undefined> = {
    ...registrationEnvironmentOverlay(terminal, selected.environment, platform),
  };
  for (const name of Object.keys(
    snapshotEnvironment(
      Object.fromEntries(
        [...selected.unresolved].map((entry): [string, string] => [entry, ""]),
      ),
      platform,
    ),
  ))
    delete settings[name];
  return settings;
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
  projectDirectory: string | undefined,
): Promise<
  | SelectedRegistration
  | { readonly unavailable: RegistrationProbeRefusal }
  | undefined
> => {
  // A failed close is a retained owner, not a read outcome: transfer it to the
  // caller's scope so `close()` retries it instead of losing it.
  const configuration = await resourceScope
    .run(() =>
      readEffectiveClientRegistrationConfiguration(
        client,
        undefined,
        platform,
        projectDirectory === undefined ? undefined : { projectDirectory },
      ),
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
  if (configuration === undefined) return { unavailable: "unreadable" };
  if (!configuration.ok) {
    const cleanup = configuration.error.cleanupFailure;
    if (cleanup !== undefined)
      resourceScope.retain(cleanup.owner, cleanup.path);
    return { unavailable: "unreadable" };
  }
  if (configuration.value.document === undefined) return undefined;
  if (hasProjectRegistrationContribution(configuration.value))
    return { unavailable: "project_scope" };
  const details = clientRegistrationEnvironmentDetails(
    configuration.value.document,
    client,
    platform,
    {},
    "effective",
  );
  return details.ok
    ? {
        values: details.value.values,
        unresolvedSettings: details.value.unresolvedSettings,
      }
    : { unavailable: "unreadable" };
};

/** Registration settings read by each provider's readiness probe. */
const PROVIDER_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  ghidra: GHIDRA_DOCTOR_SETTINGS,
  ida: IDA_DOCTOR_SETTINGS,
  jadx: JADX_DOCTOR_SETTINGS,
  kuna: KUNA_DOCTOR_SETTINGS,
  leandec: LEANDEC_DOCTOR_SETTINGS,
};

/**
 * Whether a setting an unresolved expression removed is one this probe actually
 * reads for the configuration the client supplied. A literal `JAVA_HOME` and
 * jar path make JADX never consult `PATH`, so failing that probe closed would
 * report `unknown` for a provider that has everything it needs.
 */
export const settingAffectsProbe = (
  id: string,
  name: string,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): boolean => {
  const read = (key: string) =>
    environment[platform === "win32" ? key.toUpperCase() : key];
  switch (id) {
    case "jadx":
      // Java comes from JAVA_HOME when it is explicit; only then is PATH unused.
      return name !== "PATH" || read("JAVA_HOME") === undefined;
    case "ghidra":
      // An existing project changes admission only on Windows, which cannot
      // open one. Both the install directory and the JDK fall back to PATH.
      if (name === "REA_GHIDRA_PROJECT_PATH") return platform === "win32";
      return (
        name !== "PATH" ||
        read("GHIDRA_INSTALL_DIR") === undefined ||
        read("JAVA_HOME") === undefined
      );
    case "kuna":
      return kunaSettingAffectsProbe(name, environment, platform);
    default:
      return true;
  }
};

const providerSettingOrigins = (
  inspection: DoctorProviderInspection,
  environment: Readonly<NodeJS.ProcessEnv>,
  savedDefaults: ReadonlySet<string> | undefined,
): DoctorProviderInspection => {
  const settings: NonNullable<DoctorProviderInspection["providerSettings"]> =
    Object.fromEntries(
      PERSISTED_SETTINGS.flatMap((key) => {
        if (!(PROVIDER_SETTINGS[inspection.id] ?? []).includes(key)) return [];
        const explicit = environment[key];
        const value = explicit ?? inspection.registrationEnvironment[key];
        if (value === undefined) return [];
        const source =
          explicit === undefined
            ? "auto"
            : savedDefaults?.has(key)
              ? "config"
              : "env";
        return [[key, { value, source }]];
      }),
    );
  return Object.keys(settings).length === 0
    ? inspection
    : { ...inspection, providerSettings: settings };
};

const PROVIDER_CONFIGURATION_KEYS: Readonly<Record<string, string>> = {
  ghidra: "GHIDRA_INSTALL_DIR",
  ida: "REA_IDA_MCP_CONFIG",
  jadx: "REA_JADX_MCP_JAR",
  kuna: "REA_KUNA_COMMAND",
  leandec: "LEANDEC_MCP_SERVER",
};

const providerConfigurationPresent = (
  id: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): boolean => {
  const key = PROVIDER_CONFIGURATION_KEYS[id];
  const value = key === undefined ? undefined : environment[key];
  return value !== undefined && (id !== "kuna" || value.length > 0);
};

const unresolvedProvider = (
  id: string,
  unresolvedSettings: ReadonlySet<string> | undefined,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): DoctorProviderInspection | undefined => {
  if (unresolvedSettings === undefined) return undefined;
  const read = new Set(PROVIDER_SETTINGS[id] ?? []);
  const unresolved = [...unresolvedSettings].filter(
    (name) =>
      read.has(name) && settingAffectsProbe(id, name, environment, platform),
  );
  if (unresolved.length === 0) return undefined;
  const key = PROVIDER_CONFIGURATION_KEYS[id];
  return unresolvedProviderInspection(
    id,
    key === undefined || unresolved.includes(key)
      ? null
      : providerConfigurationPresent(id, environment),
    {
      code: "registration_environment_unknown",
      classification: "unknown",
      detail: `The selected client's registration has unresolved settings: ${unresolved.join(", ")}.`,
      remediation:
        "Inspect the selected client's registration on the host and rerun doctor.",
    },
  );
};

const unresolvedProviderInspection = (
  id: string,
  configured: boolean | null,
  failure: NonNullable<DoctorProviderConfiguration["failure"]>,
): DoctorProviderInspection => ({
  id,
  configured,
  available: null,
  providerVersion: null,
  registrationEnvironment: {},
  checks: [{ name: "configuration", ok: false, ...failure }],
});

const withProbeResourceScope = <T>(
  parent: RetainedResourceScope,
  label: string,
  operation: (scope: RetainedResourceScope) => Promise<T>,
): Promise<T> =>
  parent.run(async () => {
    const child = new ArtifactResourceScope();
    const scope: RetainedResourceScope = {
      retain: (owner, resource) =>
        child.retain({
          kind: "lease",
          resource,
          lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
        }),
      run: (work) => child.run(work),
    };
    try {
      return await operation(scope);
    } finally {
      if (child.hasPending) parent.retain(child, label);
      else await child.close();
    }
  });

/** Compose provider diagnostics at the outer CLI adapter boundary. */
export const createSystemDoctorHost = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  signal?: AbortSignal,
  /** The host diagnosed; tests select another host's client layout. */
  host: HostPlatform = HOST_PLATFORM,
  savedDefaults?: ReadonlySet<string>,
  registrationScope: "user" | "all" = "all",
): DoctorHost => {
  const { platform } = host;
  const projectDirectory =
    registrationScope === "all" ? process.cwd() : undefined;
  const startupConfig = userConfigFilePath(environment, platform);
  const inheritedEnvironment = omitEnvironmentSettings(
    environment,
    savedDefaults,
  );
  const startupProviderDefaults: UserSettings = Object.fromEntries(
    PERSISTED_SETTINGS.flatMap((key) => {
      const value = environment[key];
      return savedDefaults?.has(key) === true && value !== undefined
        ? [[key, value]]
        : [];
    }),
  );
  const savedConfigReads = new Map<
    string,
    ReturnType<typeof loadUserConfigurationDefaults>
  >();
  const readProviderDefaults = (
    explicit: Readonly<NodeJS.ProcessEnv>,
  ): ReturnType<typeof loadUserConfigurationDefaults> => {
    const path = userConfigFilePath(explicit, platform);
    if (savedDefaults !== undefined && path === startupConfig)
      return Promise.resolve(ok(startupProviderDefaults));
    let read = savedConfigReads.get(path);
    if (read === undefined) {
      read = loadUserConfigurationDefaults(explicit, platform);
      savedConfigReads.set(path, read);
    }
    return read;
  };
  const idaBudgetLookup = (
    analysisProvider: Parameters<RetainedProviderRequestBudgetResolver>[0],
    registration: Parameters<RetainedProviderRequestBudgetResolver>[1],
  ) => {
    if (analysisProvider !== "ida" && analysisProvider !== "auto")
      return { kind: "none" } as const;
    const explicit = registrationEnvironmentOverlay(
      inheritedEnvironment,
      registration,
      platform,
    );
    const path = explicit.REA_IDA_MCP_CONFIG;
    return path === undefined
      ? ({ kind: "saved", environment: explicit } as const)
      : ({ kind: "explicit", path } as const);
  };
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
      registration = withProbeResourceScope(resourceScope, path, (probeScope) =>
        readIdaConfiguration(path, {
          resourceScope: probeScope,
          signal: inspectionSignal,
        }),
      );
      byPath.set(path, registration);
    }
    return registration;
  };
  return systemDoctorHost({
    environment,
    platform,
    architecture: host.architecture,
    registrationScope,
    savedDefaults,
    ...(signal === undefined ? {} : { signal }),
    resolveProviderRequestBudget: Object.assign(
      async (
        analysisProvider: Parameters<RetainedProviderRequestBudgetResolver>[0],
        registrationEnvironment: Parameters<RetainedProviderRequestBudgetResolver>[1],
        resourceScope: Parameters<RetainedProviderRequestBudgetResolver>[2],
        inspectionSignal: Parameters<RetainedProviderRequestBudgetResolver>[3],
      ) => {
        const lookup = idaBudgetLookup(
          analysisProvider,
          registrationEnvironment,
        );
        if (lookup.kind === "none") return ok(undefined);
        let path: string | undefined;
        if (lookup.kind === "explicit") path = lookup.path;
        else {
          const defaults = await readProviderDefaults(lookup.environment);
          if (!defaults.ok) return defaults;
          path = defaults.value.REA_IDA_MCP_CONFIG;
        }
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
      {
        budgetSettings: (
          analysisProvider: Parameters<RetainedProviderRequestBudgetResolver>[0],
          registrationEnvironment: Parameters<RetainedProviderRequestBudgetResolver>[1],
        ) => {
          const lookup = idaBudgetLookup(
            analysisProvider,
            registrationEnvironment,
          );
          if (lookup.kind === "none") return new Set<string>();
          return new Set([
            "REA_IDA_MCP_CONFIG",
            ...(lookup.kind === "saved"
              ? userConfigLocationSettings(lookup.environment, platform)
              : []),
          ]);
        },
      },
    ),
    selectProviderConfiguration: async (
      resourceScope,
      inspectionSignal,
      clients,
    ) => {
      const selection = await withProbeResourceScope(
        resourceScope,
        "selected-registration",
        (probeScope) =>
          selectedRegistrationEnvironment(
            clients,
            environment,
            probeScope,
            inspectionSignal,
            platform,
            projectDirectory,
          ),
      );
      if (selection === undefined) return { environment, savedDefaults };
      if (selection.unavailable !== undefined)
        return {
          environment: {},
          failure: {
            classification: "unknown",
            code:
              selection.unavailable === "project_scope"
                ? "project_provider_settings_unapproved"
                : "registration_environment_unknown",
            detail:
              selection.unavailable === "project_scope"
                ? "Doctor discovered a project registration and did not run provider probes from its settings."
                : "The selected client's registration could not be read or resolved.",
            remediation:
              selection.unavailable === "project_scope"
                ? "Run rea doctor with --provider and provider settings you selected in the terminal."
                : "Inspect the selected client's registration on the host and rerun doctor.",
          },
        };

      // Values loaded from the terminal's saved file cannot mask the client's file.
      const explicit = selectedProviderSettings(
        selection,
        inheritedEnvironment,
        platform,
      );
      const unresolved = new Set(
        [...selection.unresolved].map((name) =>
          platform === "win32" ? name.toUpperCase() : name,
        ),
      );
      const location = userConfigLocationSettings(explicit, platform);
      const unresolvedLocation = [...unresolved].filter((name) =>
        location.has(name),
      );
      if (unresolvedLocation.length > 0)
        return {
          environment: explicit,
          failure: {
            classification: "unknown",
            code: "registration_environment_unknown",
            detail: `The selected client's user configuration location has unresolved settings: ${unresolvedLocation.join(", ")}.`,
            remediation:
              "Resolve those settings in the selected client's registration, then rerun doctor.",
          },
        };

      const defaults = await readProviderDefaults(explicit);
      if (!defaults.ok)
        return {
          environment: explicit,
          failure: {
            classification: "config_drift",
            code: "invalid_configuration",
            detail: defaults.error.message,
            remediation:
              "Check the named file and its parent directory before retrying.",
          },
        };

      const resolved = applyUserConfigurationDefaults(explicit, defaults.value);
      return {
        environment: omitEnvironmentSettings(resolved.environment, unresolved),
        savedDefaults: new Set(
          [...resolved.savedDefaults].filter((name) => !unresolved.has(name)),
        ),
        unresolved,
      };
    },
    providerInspections: async (
      resourceScope,
      inspectionSignal,
      _clients,
      configuration,
    ) => {
      const {
        environment: inspectionEnvironment,
        savedDefaults: inspectionDefaults,
        unresolved,
        failure,
      } = configuration;
      if (failure !== undefined)
        return Object.keys(PROVIDER_SETTINGS).map((id) =>
          unresolvedProviderInspection(
            id,
            providerConfigurationPresent(id, inspectionEnvironment)
              ? true
              : null,
            failure,
          ),
        );
      const ghidraUnresolved = unresolvedProvider(
        "ghidra",
        unresolved,
        inspectionEnvironment,
        platform,
      );
      const idaUnresolved = unresolvedProvider(
        "ida",
        unresolved,
        inspectionEnvironment,
        platform,
      );
      const jadxUnresolved = unresolvedProvider(
        "jadx",
        unresolved,
        inspectionEnvironment,
        platform,
      );
      const kunaUnresolved = unresolvedProvider(
        "kuna",
        unresolved,
        inspectionEnvironment,
        platform,
      );
      const leandecUnresolved = unresolvedProvider(
        "leandec",
        unresolved,
        inspectionEnvironment,
        platform,
      );
      const inspections = await settleConcurrent([
        Promise.resolve(
          leandecUnresolved ??
            inspectLeandecProvider(inspectionEnvironment, platform),
        ),
        ghidraUnresolved !== undefined
          ? Promise.resolve(ghidraUnresolved)
          : withProbeResourceScope(
              resourceScope,
              "ghidra-doctor",
              (probeScope) =>
                inspectSystemGhidraProvider(
                  inspectionEnvironment,
                  probeScope,
                  inspectionSignal,
                ),
            ),
        idaUnresolved !== undefined
          ? Promise.resolve(idaUnresolved)
          : withProbeResourceScope(resourceScope, "ida-doctor", (probeScope) =>
              inspectIdaRegistration(
                inspectionEnvironment.REA_IDA_MCP_CONFIG,
                probeScope,
                inspectionSignal,
                inspectionEnvironment.REA_IDA_MCP_CONFIG === undefined
                  ? undefined
                  : readRegistration(
                      inspectionEnvironment.REA_IDA_MCP_CONFIG,
                      resourceScope,
                      inspectionSignal,
                    ),
              ),
            ),
        jadxUnresolved !== undefined
          ? Promise.resolve(jadxUnresolved)
          : withProbeResourceScope(resourceScope, "jadx-doctor", (probeScope) =>
              inspectJadxProvider(
                inspectionEnvironment,
                probeScope,
                host,
                inspectionSignal,
              ),
            ),
        kunaUnresolved !== undefined
          ? Promise.resolve(kunaUnresolved)
          : withProbeResourceScope(resourceScope, "kuna-doctor", (probeScope) =>
              inspectKunaProvider(inspectionEnvironment, platform, {
                resourceScope: probeScope,
                signal: inspectionSignal,
              }),
            ),
      ]);
      return inspections.map((inspection) =>
        providerSettingOrigins(
          inspection,
          inspectionEnvironment,
          inspectionDefaults,
        ),
      );
    },
    desktopBuildFacts: readDesktopBuildFacts,
    linuxDemoRuntimeCheck: (
      resourceScope,
      inspectionSignal,
      probeEnvironment,
    ) =>
      withProbeResourceScope(
        resourceScope,
        "hopper-demo-runtime",
        (probeScope) =>
          inspectLinuxHopperDemoRuntime(
            probeEnvironment,
            probeScope,
            inspectionSignal,
          ),
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
        ? cancelledBy("doctor", signal, { cleanup, diagnostics })
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
    throw cancelledBy("doctor", signal, {
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
    throw cancelledBy("doctor", carriedReason(python.error.cause), {
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
