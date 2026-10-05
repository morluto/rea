import type {
  ClientConfigurationResult,
  SetupAction,
  SetupClientState,
  SetupConfirmation,
  SetupConfirmationDecision,
  SetupDoctorSummary,
  SetupHost,
  SetupOptions,
  SetupProgressEvent,
  SetupProviderEnvironment,
  SetupResult,
} from "./SetupTypes.js";
import type { SetupClient } from "./SupportedClients.js";
import type { DoctorReport, DoctorScope } from "./Doctor.js";
import { configureDetectedClients } from "./SetupClients.js";
import { discoverSetupState, planSetupActions } from "./SetupPlan.js";
import {
  filterClientsNeedingConfigure,
  hostRemediation,
  initialProviderEnvironment,
  setupRegistrationCommand,
  systemSetupHost,
} from "./SetupHost.js";

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
