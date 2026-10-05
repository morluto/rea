import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { PRODUCT_IDENTITY } from "../identity.js";
import { supportsNodeVersion } from "../domain/runtimeVersion.js";
import {
  runDoctor,
  systemDoctorHost,
  type DoctorHost,
  type DoctorReport,
  type DoctorScope,
} from "./Doctor.js";
import {
  installLinuxHopper,
  readLinuxDistribution,
  type LinuxDistribution,
} from "./LinuxHopper.js";
import { installMacHopper } from "./MacHopper.js";
import { configureDetectedClients } from "./SetupClients.js";
import { supportedClients, type SetupClient } from "./SupportedClients.js";
export type { SetupClient } from "./SupportedClients.js";
import {
  canonicalSkillNeedsInstall,
  installCanonicalSkill,
} from "./SetupSkill.js";
import { discoverSetupState, planSetupActions } from "./SetupPlan.js";
import {
  clientConfigurationAligned,
  configureClientConfiguration,
  configureJsonClient,
  configureTomlClient,
  inspectClientConfiguration,
} from "./SetupClientConfiguration.js";
export { configureJsonClient, configureTomlClient };
import {
  setupInstallFailure,
  type SetupFailureCode,
  type SetupHopperInstallResult,
} from "./SetupInstallFailure.js";
import { providerRegistrationEnvironment } from "./SetupRegistrationEnvironment.js";
export type { SetupHopperInstallResult } from "./SetupInstallFailure.js";

/** Exact non-secret provider variables propagated into managed registrations. */
export type SetupProviderEnvironment = Readonly<Record<string, string>>;

export { canonicalSkillNeedsInstall, installCanonicalSkill };

/** Resolve the executable and arguments used in a managed MCP registration. */
export const setupRegistrationCommand = (
  platform: NodeJS.Platform,
  useNpmRunner: boolean = process.env.npm_command === "exec",
): readonly string[] =>
  useNpmRunner
    ? PRODUCT_IDENTITY.mcpCommand.split(" ")
    : platform === "win32"
      ? [
          process.execPath,
          resolve(process.argv[1] ?? PRODUCT_IDENTITY.cliBinary),
          "mcp",
        ]
      : [resolve(process.argv[1] ?? PRODUCT_IDENTITY.cliBinary), "mcp"];

/** Result of one backup/write/readback transaction. */
export type ClientConfigurationResult =
  | {
      readonly status: "unchanged" | "configured" | "skipped";
      readonly backupPath?: string;
    }
  | {
      readonly status: "failed";
      readonly reason: "path" | "backup" | "write" | "readback";
    };

/** Read-only state used to block unsafe setup plans before any mutation. */
export type ClientConfigurationInspection =
  | { readonly status: "already_current" }
  | {
      readonly status: "create" | "update";
      readonly backupPath?: string;
    }
  | {
      readonly status: "invalid";
      readonly remediation: string;
    };
/** Effects required by the idempotent, non-blocking setup workflow. */
export interface SetupHost {
  readonly platform: NodeJS.Platform;
  readonly nodeVersion: string;
  macosVersion(): Promise<string | undefined>;
  linuxDistribution(): Promise<LinuxDistribution | undefined>;
  hopperPath(): Promise<string | undefined>;
  installHopper(replaceExisting: boolean): Promise<SetupHopperInstallResult>;
  providerEnvironment?(): Promise<SetupProviderEnvironment>;
  detectedClients(): Promise<readonly SetupClient[]>;
  supportedClients?(): Promise<readonly SetupClient[]>;
  configureClient(
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ): Promise<ClientConfigurationResult>;
  clientNeedsConfigure(
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ): Promise<boolean>;
  inspectClientConfiguration?(
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ): Promise<ClientConfigurationInspection>;
  skillNeedsInstall(): Promise<boolean>;
  installSkill(): Promise<"installed" | "unchanged" | "failed">;
  doctor(scope?: DoctorScope): Promise<Awaited<ReturnType<typeof runDoctor>>>;
}
/** Structured setup outcome carrying remediation instead of prompting. */
export interface SetupResult {
  readonly status:
    | "planned"
    | "cancelled"
    | "needs_confirmation"
    | "ready"
    | "needs_human";
  readonly plannedActions: readonly SetupAction[];
  readonly appliedActions: readonly string[];
  readonly clients: Readonly<Record<string, ClientConfigurationResult>>;
  readonly doctor: SetupDoctorSummary;
  /** Supported-client discovery state captured before setup mutations. */
  readonly clientStates: readonly SetupClientState[];
  readonly remediation?: string;
  readonly code?: SetupFailureCode;
}

/** Relevant health and identity evidence for the selected setup scope. */
export interface SetupDoctorSummary {
  readonly healthy: boolean;
  readonly environment_healthy: boolean;
  readonly scope: DoctorReport["scope"];
  readonly hopperPath?: string;
  readonly availableProviders: readonly string[];
  readonly providerInspections?: DoctorReport["providerInspections"];
  readonly identity?: Pick<
    NonNullable<DoctorReport["identity"]>,
    "skill" | "registrations"
  >;
}

/** Read-only state for one supported client location. */
export interface SetupClientState {
  readonly client: SetupClient;
  readonly detected: boolean;
  readonly configured: boolean;
  readonly status: "configured" | "missing" | "needs_configuration" | "invalid";
}

/** One concrete setup mutation disclosed before approval. */
export interface SetupAction {
  readonly id: string;
  readonly kind: "install_hopper" | "configure_client" | "install_skill";
  readonly label: string;
  readonly target: string;
  readonly detail: string;
  readonly external: boolean;
  readonly operation: "create" | "update" | "install";
  readonly backupPath?: string;
  readonly networkOrigins?: readonly string[];
  readonly commands?: readonly string[];
  readonly integrity?: string;
}

/** Explicit authorization supplied by an interactive or unattended CLI adapter. */
export interface SetupOptions {
  readonly approved: boolean;
  readonly installHopper: boolean;
  readonly structured: boolean;
  readonly proposeHopper?: boolean;
  readonly clientIds?: readonly string[];
  readonly installSkill?: boolean;
  readonly readinessScope?: DoctorScope;
  readonly dryRun?: boolean;
  readonly allDetectedClients?: boolean;
  readonly onProgress?: (event: SetupProgressEvent) => void;
}

/** One settled or active setup operation projected to the interactive adapter. */
export interface SetupProgressEvent {
  readonly actionId: string;
  readonly label: string;
  readonly state: "started" | "completed" | "warning" | "failed";
  readonly detail?: string;
}

/** Interactive selection and final consent returned by the CLI adapter. */
export interface SetupConfirmationDecision {
  readonly approved: boolean;
  readonly selectedActionIds: readonly string[];
  readonly cancelled?: boolean;
}

/** Read-only context shown while selecting clients or reviewing exact actions. */
export interface SetupConfirmationContext {
  readonly stage: "select" | "confirm";
  readonly clientStates: readonly SetupClientState[];
  readonly selectedClientIds: readonly string[];
  readonly clientSelectionAllowed: boolean;
}

/** Adapter-owned selection and confirmation for the setup workflow. */
export type SetupConfirmation = (
  actions: readonly SetupAction[],
  context?: SetupConfirmationContext,
) => Promise<boolean | SetupConfirmationDecision>;

/** Discover, approve, and apply setup actions idempotently. */
export const runSetup = async (
  options: SetupOptions,
  host: SetupHost = systemSetupHost(),
  confirm?: SetupConfirmation,
): Promise<SetupResult> => {
  const appliedActions: string[] = [];
  let plannedActions: readonly SetupAction[] = [];
  const clients: Record<string, ClientConfigurationResult> = {};
  let clientStates: readonly SetupClientState[] = [];
  let readinessScope = options.readinessScope;
  const fail = (remediation: string) =>
    setupFailure(
      remediation,
      [host, plannedActions, appliedActions, clients, clientStates],
      readinessScope,
    );
  const unsupported = await hostRemediation(host, false);
  if (unsupported !== undefined) return fail(unsupported);
  let hopperPath = await host.hopperPath();
  let providerEnvironment = await initialProviderEnvironment(host, hopperPath);
  const discovery = await discoverSetupState({
    host,
    providerEnvironment,
    forceHopperInstall: options.installHopper,
    proposeHopper:
      options.proposeHopper ?? (confirm !== undefined && !options.structured),
    doctorScope: options.readinessScope,
  });
  clientStates = discovery.clientStates;
  const clientSelectionAllowed =
    options.clientIds === undefined &&
    options.readinessScope?.clients === undefined &&
    options.allDetectedClients !== true &&
    options.installHopper !== true &&
    options.installSkill === undefined;
  const interactiveSelection =
    confirm !== undefined && !options.structured && clientSelectionAllowed;
  let selectedClientIds = options.allDetectedClients
    ? discovery.detectedClientIds
    : (options.clientIds ??
      options.readinessScope?.clients ??
      discovery.defaultClientIds);
  let skillSelected =
    options.installSkill === true ||
    (options.installSkill !== false && selectedClientIds.length > 0);
  let installSkill = skillSelected && discovery.skillNeedsInstall;
  let planDiscovery = discovery;
  if (interactiveSelection) {
    const offerSkillAction =
      options.installSkill !== false && discovery.skillNeedsInstall;
    const selectionActions = await planSetupActions({
      discovery,
      host,
      providerEnvironment,
      command: setupRegistrationCommand(host.platform),
      clientIds: [],
      installSkill: offerSkillAction,
    });
    const decision = await confirm(selectionActions.plannedActions, {
      stage: "select",
      clientStates,
      selectedClientIds: discovery.defaultClientIds,
      clientSelectionAllowed,
    });
    if (isSetupDecisionCancelled(decision))
      return setupCancelled(
        selectionActions.plannedActions,
        clients,
        clientStates,
        discovery.initialDoctor,
      );
    const selectedActionIds = new Set(
      typeof decision === "boolean"
        ? decision
          ? [
              ...selectionActions.plannedActions.map(({ id }) => id),
              ...discovery.defaultClientIds.map(
                (id) => `configure_client:${id}`,
              ),
            ]
          : []
        : decision.selectedActionIds,
    );
    selectedClientIds = [...selectedActionIds]
      .filter((id) => id.startsWith("configure_client:"))
      .map((id) => id.slice("configure_client:".length));
    const proposedInstallAction = selectionActions.plannedActions.some(
      ({ id }) => id === "install_hopper",
    );
    planDiscovery = {
      ...discovery,
      installHopper:
        options.installHopper ||
        (proposedInstallAction && selectedActionIds.has("install_hopper")),
    };
    skillSelected =
      options.installSkill === true ||
      (selectedActionIds.has("install_skill") &&
        selectedClientIds.length === 0) ||
      (options.installSkill !== false && selectedClientIds.length > 0);
    installSkill = skillSelected && discovery.skillNeedsInstall;
  }
  const planned = await planSetupActions({
    discovery: planDiscovery,
    host,
    providerEnvironment,
    command: setupRegistrationCommand(host.platform),
    clientIds: selectedClientIds,
    installSkill,
  });
  plannedActions = planned.plannedActions;
  if (planned.blocker !== undefined) return fail(planned.blocker);
  const hopperBlocker = await hostRemediation(
    host,
    planDiscovery.installHopper,
  );
  if (hopperBlocker !== undefined) return fail(hopperBlocker);
  const planSelection = {
    installHopper: planDiscovery.installHopper,
    installSkill,
    skillSelected,
    selectedClients: planned.selectedClients,
    clientsToConfigure: planned.clientsToConfigure,
  };
  readinessScope = resolvedReadinessScope(
    options.readinessScope,
    planSelection,
  );

  if (options.dryRun === true)
    return {
      status: "planned",
      plannedActions,
      appliedActions,
      clients,
      doctor: summarizeDoctor(discovery.initialDoctor),
      clientStates,
    };

  let approved = options.approved || plannedActions.length === 0;
  let interactiveApproval = false;
  if (!approved && confirm !== undefined && !options.structured) {
    const decision = await confirm?.(plannedActions, {
      stage: "confirm",
      clientStates,
      selectedClientIds,
      clientSelectionAllowed: false,
    });
    if (decision !== undefined) {
      if (isSetupDecisionCancelled(decision))
        return setupCancelled(
          plannedActions,
          clients,
          clientStates,
          discovery.initialDoctor,
        );
      approved = typeof decision === "boolean" ? decision : decision.approved;
      interactiveApproval = approved;
    }
  }
  if (!approved)
    return {
      status: confirm === undefined ? "needs_confirmation" : "cancelled",
      plannedActions,
      appliedActions,
      clients,
      doctor: summarizeDoctor(discovery.initialDoctor),
      clientStates,
      ...(confirm === undefined
        ? {
            remediation:
              "Review the setup plan, then rerun interactively or with --yes.",
          }
        : {}),
    };

  let selectedClients: readonly SetupClient[] =
    planSelection.clientsToConfigure;
  if (
    planSelection.installHopper &&
    (interactiveApproval || options.installHopper)
  ) {
    const install = await installHopperAction({
      host,
      options,
      plannedActions,
      appliedActions,
      clients,
      selectedClients,
      providerEnvironment,
      doctorScope: readinessScope,
      clientStates,
    });
    if ("failure" in install) return install.failure;
    ({ hopperPath, providerEnvironment, selectedClients } = install);
  }
  const clientFailure = await configureDetectedClients({
    host,
    detectedClients: selectedClients,
    providerEnvironment,
    command: setupRegistrationCommand(host.platform),
    clients,
    appliedActions,
    ...(options.onProgress === undefined
      ? {}
      : { onProgress: options.onProgress }),
  });
  if (clientFailure !== undefined) return fail(clientFailure);
  if (
    planSelection.installSkill &&
    !(await installSkillAction(host, options, appliedActions))
  )
    return fail(
      "REA analysis skill could not be installed or verified. Check permissions for `~/.agents/skills`, then rerun setup.",
    );
  const doctor = summarizeDoctor(await host.doctor(readinessScope));
  const remediation = finalSetupRemediation(
    host.platform,
    appliedActions.includes("installed_hopper"),
    doctor.healthy,
    hopperPath,
  );
  return {
    status: remediation === undefined ? "ready" : "needs_human",
    plannedActions,
    appliedActions,
    clients,
    doctor,
    clientStates,
    ...(remediation === undefined ? {} : { remediation }),
  };
};

const installHopperAction = async (input: {
  readonly host: SetupHost;
  readonly options: SetupOptions;
  readonly plannedActions: readonly SetupAction[];
  readonly appliedActions: string[];
  readonly clients: Readonly<Record<string, ClientConfigurationResult>>;
  readonly selectedClients: readonly SetupClient[];
  readonly providerEnvironment: SetupProviderEnvironment;
  readonly doctorScope: DoctorScope | undefined;
  readonly clientStates: readonly SetupClientState[];
}) => {
  const label = "Hopper deep-analysis provider";
  emitProgress(input.options, {
    actionId: "install_hopper",
    label,
    state: "started",
  });
  const installed = await input.host.installHopper(input.options.installHopper);
  if (installed.status === "failed") {
    emitProgress(input.options, {
      actionId: "install_hopper",
      label,
      state: "failed",
      detail: installed.remediation,
    });
    return {
      failure: {
        status: "needs_human" as const,
        plannedActions: input.plannedActions,
        appliedActions: input.appliedActions,
        clients: input.clients,
        doctor: summarizeDoctor(await input.host.doctor(input.doctorScope)),
        clientStates: input.clientStates,
        code: installed.code,
        remediation: installed.remediation,
      },
    };
  }
  input.appliedActions.push("installed_hopper");
  emitProgress(input.options, {
    actionId: "install_hopper",
    label,
    state: "completed",
    detail: installed.launcherPath,
  });
  const providerEnvironment = {
    ...input.providerEnvironment,
    HOPPER_LAUNCHER_PATH: installed.launcherPath,
  };
  return {
    hopperPath: installed.launcherPath,
    providerEnvironment,
    selectedClients: await filterClientsNeedingConfigure(
      input.host,
      input.selectedClients,
      providerEnvironment,
      setupRegistrationCommand(input.host.platform),
    ),
  };
};

const installSkillAction = async (
  host: SetupHost,
  options: SetupOptions,
  appliedActions: string[],
): Promise<boolean> => {
  const label = "REA reverse-engineering skill";
  emitProgress(options, {
    actionId: "install_skill",
    label,
    state: "started",
  });
  const skill = await host.installSkill();
  if (skill === "failed") {
    emitProgress(options, {
      actionId: "install_skill",
      label,
      state: "failed",
    });
    return false;
  }
  if (skill === "installed") appliedActions.push("installed_skill");
  emitProgress(options, {
    actionId: "install_skill",
    label,
    state: skill === "installed" ? "completed" : "warning",
    ...(skill === "unchanged" ? { detail: "Already current" } : {}),
  });
  return true;
};

const setupFailure = async (
  remediation: string,
  [host, plannedActions, appliedActions, clients, clientStates]: readonly [
    SetupHost,
    readonly SetupAction[],
    readonly string[],
    Readonly<Record<string, ClientConfigurationResult>>,
    readonly SetupClientState[],
  ],
  scope?: DoctorScope,
): Promise<SetupResult> => {
  return {
    status: "needs_human",
    plannedActions,
    appliedActions,
    clients,
    doctor: summarizeDoctor(await host.doctor(scope)),
    clientStates,
    remediation,
  };
};

const emitProgress = (options: SetupOptions, event: SetupProgressEvent): void =>
  options.onProgress?.(event);

const filterClientsNeedingConfigure = async (
  host: SetupHost,
  detectedClients: readonly SetupClient[],
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
): Promise<readonly SetupClient[]> => {
  const needs = await Promise.all(
    detectedClients.map((client) =>
      host.clientNeedsConfigure(client, providerEnvironment, command),
    ),
  );
  return detectedClients.filter((_, index) => needs[index]);
};

const initialProviderEnvironment = async (
  host: SetupHost,
  hopperPath: string | undefined,
): Promise<SetupProviderEnvironment> => ({
  ...(await host.providerEnvironment?.()),
  ...(hopperPath === undefined ? {} : { HOPPER_LAUNCHER_PATH: hopperPath }),
});

const finalSetupRemediation = (
  platform: NodeJS.Platform,
  installedHopper: boolean,
  healthy: boolean,
  hopperPath: string | undefined,
): string | undefined => {
  if (platform === "darwin" && installedHopper)
    return "Open Hopper, choose its demo mode or activate a license, then rerun rea doctor --json.";
  if (healthy) return undefined;
  return hopperPath === undefined
    ? "Hopper is optional for non-Hopper providers. Rerun with --yes --install-hopper for deep native analysis."
    : "Run rea doctor and apply each reported remediation.";
};

const isSetupDecisionCancelled = (
  decision: boolean | SetupConfirmationDecision,
): boolean =>
  typeof decision === "boolean" ? !decision : decision.cancelled === true;

const setupCancelled = (
  plannedActions: readonly SetupAction[],
  clients: Readonly<Record<string, ClientConfigurationResult>>,
  clientStates: readonly SetupClientState[],
  doctor: DoctorReport,
): SetupResult => ({
  status: "cancelled",
  plannedActions,
  appliedActions: [],
  clients,
  doctor: summarizeDoctor(doctor),
  clientStates,
});

const resolvedReadinessScope = (
  requested: DoctorScope | undefined,
  selection: {
    readonly selectedClients: readonly SetupClient[];
    readonly installHopper: boolean;
    readonly skillSelected?: boolean;
  },
): DoctorScope => ({
  clients: selection.selectedClients.map(({ name }) => name),
  providers: selection.installHopper
    ? ["hopper"]
    : (requested?.providers ?? []),
  skill: selection.skillSelected === true || requested?.skill === true,
});

const summarizeDoctor = (report: DoctorReport): SetupDoctorSummary => ({
  healthy: report.healthy,
  environment_healthy: report.environment_healthy,
  scope: report.scope,
  availableProviders: [
    ...(report.hopperPath !== undefined &&
    report.checks
      .filter(({ name }) => name.startsWith("hopper"))
      .every(({ ok }) => ok)
      ? ["hopper"]
      : []),
    ...(report.providerInspections ?? [])
      .filter(({ available }) => available)
      .map(({ id }) => id),
  ],
  ...(report.hopperPath === undefined ? {} : { hopperPath: report.hopperPath }),
  ...(report.providerInspections === undefined
    ? {}
    : { providerInspections: report.providerInspections }),
  ...(report.identity === undefined
    ? {}
    : {
        identity: {
          skill: report.identity.skill,
          registrations: report.identity.registrations,
        },
      }),
});

const hostRemediation = async (
  host: SetupHost,
  installHopper: boolean,
): Promise<string | undefined> => {
  if (!supportsNodeVersion(host.nodeVersion))
    return "Install Node.js 22.19+ or 24.11+ and rerun setup.";
  if (!installHopper) return undefined;
  if (host.platform !== "darwin" && host.platform !== "linux")
    return "REA supports Hopper on macOS and selected 64-bit Linux distributions.";
  if (host.platform === "darwin") {
    const version = await host.macosVersion();
    return version === undefined || major(version) < 12
      ? "Upgrade to macOS 12 or newer."
      : undefined;
  }
  if ((await host.linuxDistribution())?.supported === true) return undefined;
  return "Automated Hopper setup supports Ubuntu 24.04+, Fedora 41+, and 64-bit Arch Linux; configure an existing supported provider instead.";
};

/** Production setup effects for Hopper, agent configuration, and the canonical skill directory. */
export const systemSetupHost = (
  doctorHost: DoctorHost = systemDoctorHost(),
): SetupHost => {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    macosVersion: () => doctorHost.macosVersion(),
    linuxDistribution: readLinuxDistribution,
    hopperPath: async () => (await runDoctor(undefined, doctorHost)).hopperPath,
    providerEnvironment: async () => {
      const diagnosis = await runDoctor(undefined, doctorHost);
      return {
        ...providerRegistrationEnvironment(diagnosis.providerInspections ?? []),
        ...(diagnosis.hopperPath === undefined
          ? {}
          : { HOPPER_LAUNCHER_PATH: diagnosis.hopperPath }),
      };
    },
    installHopper: async (replaceExisting) => {
      const result =
        process.platform === "linux"
          ? await installLinuxHopper()
          : await installMacHopper({ replaceExisting });
      if (result.status === "installed") return result;
      return setupInstallFailure(result.reason);
    },
    detectedClients: () => detectClients(homedir()),
    supportedClients: () => Promise.resolve(supportedClients(homedir())),
    configureClient: (client, providerEnvironment, command) =>
      client.format === "unsupported"
        ? Promise.resolve({ status: "skipped" })
        : configureClientConfiguration(client, providerEnvironment, command),
    clientNeedsConfigure: (client, providerEnvironment, command) =>
      clientConfigurationAligned(client, providerEnvironment, command).then(
        (aligned) => !aligned,
      ),
    inspectClientConfiguration: inspectClientConfiguration,
    skillNeedsInstall: () => canonicalSkillNeedsInstall(homedir()),
    installSkill: () => installCanonicalSkill(homedir()),
    doctor: (scope) => runDoctor(undefined, doctorHost, scope),
  };
};

/** Detect supported agents from their config files or stable installation markers. */
export const detectClients = async (
  home: string,
): Promise<readonly SetupClient[]> => {
  const detected: SetupClient[] = [];
  for (const candidate of supportedClients(home)) {
    const [hasConfig, hasMarker] = await Promise.all([
      exists(candidate.configPath),
      candidate.markerPath === undefined ? false : exists(candidate.markerPath),
    ]);
    if (hasConfig || hasMarker) detected.push(candidate);
  }
  return detected;
};

const major = (version: string): number =>
  Number.parseInt(version.split(".")[0] ?? "0", 10);
const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
