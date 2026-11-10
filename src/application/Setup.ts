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
import {
  manualRegistrationRemediation,
  type SetupClient,
} from "./SupportedClients.js";
import type { DoctorReport, DoctorScope } from "./Doctor.js";
import { configureDetectedClients } from "./SetupClients.js";
import {
  discoverSetupState,
  hopperInstallRefusal,
  planSetupActions,
} from "./SetupPlan.js";
import {
  filterClientsNeedingConfigure,
  hostRemediation,
  systemSetupHost,
} from "./SetupHost.js";
import {
  AnalysisError,
  type AnalysisCleanupObservation,
} from "../domain/analysisErrorBase.js";
import { setupCleanupError, setupCleanupReason } from "./SetupCleanupOwner.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  assertSetupActive,
  withSetupCancellation,
} from "./SetupCancellation.js";
import type {
  SetupSkillInstallError,
  SkillInstallResult,
} from "./SetupSkill.js";
import { planDesktopBuild } from "./SetupDesktopBuild.js";
import { DESKTOP_BUILD_PROVIDER_ID } from "./DoctorProviderIds.js";
import type {
  SetupHopperInstallFailure,
  SetupHopperInstallResult,
} from "./SetupInstallFailure.js";

/** Completed setup facts retained if a later step is cancelled. */
interface SetupProgress {
  plannedActions: readonly SetupAction[];
  appliedActions: string[];
  clients: Record<string, ClientConfigurationResult>;
  clientStates: readonly SetupClientState[];
  desktopFailure?: string | undefined;
  hopperOutcome?: SetupHopperInstallResult | undefined;
  skill?: SkillInstallResult | undefined;
}

const setupProgressFacts = (progress: SetupProgress) => {
  const skill = progress.skill;
  return jsonValueSchema.parse({
    plannedActions: progress.plannedActions,
    appliedActions: progress.appliedActions,
    clients: progress.clients,
    clientStates: progress.clientStates,
    ...(progress.desktopFailure === undefined
      ? {}
      : { desktopFailure: progress.desktopFailure }),
    ...(progress.hopperOutcome === undefined
      ? {}
      : { hopperOutcome: progress.hopperOutcome }),
    ...(skill === undefined
      ? {}
      : {
          skill: skill.ok
            ? { status: skill.value }
            : {
                status: "failed",
                path: skill.error.path,
                stage: skill.error.stage,
                reason: skill.error.reason,
                rollbackFailures: skill.error.rollbackFailures,
                recoveryBackupPaths: skill.error.recoveryBackupPaths,
                remediation: skill.error.remediation,
              },
        }),
  });
};

/** Discover, approve, and apply setup actions idempotently. */
export const runSetup = async (
  options: SetupOptions,
  host: SetupHost = systemSetupHost(),
  confirm?: SetupConfirmation,
): Promise<SetupResult> => {
  const progress: SetupProgress = {
    plannedActions: [],
    appliedActions: [],
    clients: {},
    clientStates: [],
  };
  let result: SetupResult | undefined;
  const pending: { skill?: SetupSkillInstallError } = {};
  let primaryFailure: unknown;
  let threw = false;
  const settledEffects: JsonValue[] = [];
  try {
    result = await runSetupWorkflow(
      options,
      withSetupCancellation(host, options.signal, (operation, value) => {
        settledEffects.push({ operation, result: value });
      }),
      progress,
      confirm,
      pending,
    );
  } catch (cause: unknown) {
    if (cause instanceof AnalysisCancelledError)
      cause.retainDiagnostics({ setup_progress: setupProgressFacts(progress) });
    threw = true;
    primaryFailure = cause;
  }

  let cleanup: AnalysisError | undefined;
  try {
    const report = await host.close?.();
    cleanup = report === undefined ? undefined : setupCleanupError(report);
  } catch (cause: unknown) {
    cleanup = setupCleanupError(cause);
  }
  if (cleanup !== undefined && !cleanup.cleanupIncomplete) cleanup = undefined;
  if (threw) {
    if (primaryFailure instanceof AnalysisError && options.signal?.aborted)
      primaryFailure.retainDiagnostics({ setup_effects: settledEffects });
    if (cleanup === undefined) throw primaryFailure;
    if (primaryFailure instanceof AnalysisError)
      throw analysisErrorWithCleanupFailure(
        primaryFailure,
        cleanup,
        "setup",
      ).bindCleanupDependencies([primaryFailure, cleanup]);
    throw new AggregateError(
      [primaryFailure, cleanup],
      "Setup and resource cleanup failed.",
      { cause: primaryFailure },
    );
  }
  if (result === undefined) throw new Error("Setup returned no result.");
  if (pending.skill !== undefined) {
    const settled =
      pending.skill.cleanupOwners.length > 0 &&
      pending.skill.cleanupOwners.every(({ lease }) => lease.released);
    if (settled)
      emitProgress(options, {
        actionId: "install_skill",
        label: "REA reverse-engineering skill",
        state: "completed",
      });
    else
      result = {
        ...result,
        status: "needs_human",
        code: result.code ?? "skill_install_failed",
        remediation:
          combineRemediation(pending.skill.remediation, result.remediation) ??
          pending.skill.remediation,
      };
  }
  // Cancellation observed only during the final doctor or cleanup is not success.
  if (options.signal?.aborted === true) {
    const cancelled = new AnalysisCancelledError("setup", {
      cause: options.signal.reason,
      diagnostics: {
        setup_result: jsonValueSchema.parse(result),
        setup_effects: settledEffects,
      },
    });
    if (cleanup !== undefined)
      throw analysisErrorWithCleanupFailure(
        cancelled,
        cleanup,
        "setup",
      ).bindCleanupDependencies([cancelled, cleanup]);
    throw cancelled;
  }
  if (cleanup === undefined) return result;
  const cleanupReason = setupCleanupReason(cleanup);
  const cleanupReport: AnalysisCleanupObservation = {
    reason: cleanupReason,
    get resources() {
      return cleanup.cleanupResources;
    },
  };
  return {
    ...result,
    status: "needs_human",
    code: result.code ?? "cleanup_failed",
    get cleanup() {
      return cleanup.cleanupIncomplete ? cleanupReport : undefined;
    },
    remediation: result.remediation
      ? `${result.remediation} ${cleanupReason}`
      : cleanupReason,
  };
};

const runSetupWorkflow = async (
  options: SetupOptions,
  host: SetupHost,
  progress: SetupProgress,
  confirm: SetupConfirmation | undefined,
  pending: { skill?: SetupSkillInstallError },
): Promise<SetupResult> => {
  assertSetupActive(options.signal);
  const appliedActions = progress.appliedActions;
  let plannedActions: readonly SetupAction[] = [];
  const clients = progress.clients;
  let clientStates: readonly SetupClientState[] = [];
  let readinessScope = options.readinessScope;
  const fail = (remediation: string) =>
    setupFailure(
      remediation,
      [host, plannedActions, appliedActions, clients, clientStates],
      readinessScope,
    );
  const failSkill = async (
    error: SetupSkillInstallError,
  ): Promise<SetupResult> => ({
    ...(await fail(error.remediation)),
    code: "skill_install_failed",
  });
  const unsupported = hostRemediation(host);
  if (unsupported !== undefined) return fail(unsupported);
  const initialState = await host.initialSetupState(options.readinessScope);
  let { hopperPath, providerEnvironment } = initialState;
  const discovery = await discoverSetupState({
    host,
    providerConfigured: initialState.providerConfigured,
    forceHopperInstall: options.installHopper,
    hopperLauncherConfigured: initialState.hopperLauncherConfigured === true,
    proposeHopper:
      options.proposeHopper ?? (confirm !== undefined && !options.structured),
    initialDoctor: initialState.doctor,
  });
  // The advertised family scope is a registration setting, not a detected
  // provider fact; merge it after discovery so it cannot suppress the
  // Hopper installation offer on an otherwise unconfigured machine.
  if (options.toolFamilies !== undefined)
    providerEnvironment = {
      ...providerEnvironment,
      REA_MCP_TOOL_FAMILIES: options.toolFamilies,
    };
  clientStates = discovery.clientStates;
  host.prepareClientSetup?.(discovery.installHopper, providerEnvironment);
  progress.clientStates = clientStates;
  const clientSelectionAllowed =
    options.clientIds === undefined &&
    options.readinessScope?.clients === undefined &&
    options.allDetectedClients !== true &&
    options.installHopper !== true &&
    options.skillClientIds === undefined &&
    options.installSkill === undefined;
  const interactiveSelection =
    confirm !== undefined && !options.structured && clientSelectionAllowed;
  const requestedClientIds =
    options.clientIds ?? options.readinessScope?.clients;
  let selectedClientIds = [
    ...new Set(
      options.allDetectedClients
        ? [...(requestedClientIds ?? []), ...discovery.detectedClientIds]
        : (requestedClientIds ?? discovery.defaultClientIds),
    ),
  ];
  let selectedSkillClientIds =
    options.skillClientIds ??
    options.readinessScope?.skillClients ??
    selectedClientIds;
  let skillNeedsInstall = await host.skillNeedsInstall(selectedSkillClientIds);
  let skillSelected =
    options.installSkill === true ||
    (options.installSkill !== false &&
      (selectedClientIds.length > 0 || selectedSkillClientIds.length > 0));
  let installSkill = skillSelected && skillNeedsInstall;
  let planDiscovery = discovery;
  if (interactiveSelection) {
    // The skill choice is intent; its final destination is determined after
    // selecting clients. An empty client selection names the shared CLI copy.
    const selectionSkillClientIds: readonly string[] = [];
    const offerSkillAction = options.installSkill !== false;
    const selectionActions = await planSetupActions({
      discovery,
      host,
      providerEnvironment,
      command: host.registrationCommand,
      clientIds: [],
      skillClientIds: selectionSkillClientIds,
      installSkill: offerSkillAction,
    });
    const decision = await confirm(selectionActions.plannedActions, {
      stage: "select",
      clientStates,
      selectedClientIds: discovery.defaultClientIds,
      clientSelectionAllowed,
    });
    assertSetupActive(options.signal);
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
    host.prepareClientSetup?.(planDiscovery.installHopper, providerEnvironment);
    skillNeedsInstall = await host.skillNeedsInstall(selectedClientIds);
    // The offered skill action can carry a client-specific ID (for example
    // `install_skill:claude_code`); without a selected client it means the
    // shared CLI skill.
    const skillActionSelected = selectionActions.plannedActions.some(
      ({ id, kind }) => kind === "install_skill" && selectedActionIds.has(id),
    );
    skillSelected =
      options.installSkill === true ||
      (skillActionSelected && selectedClientIds.length === 0) ||
      (options.installSkill !== false && selectedClientIds.length > 0);
    installSkill = skillSelected && skillNeedsInstall;
    selectedSkillClientIds = selectedClientIds;
  }
  const desktop = await planDesktopBuild(
    host.desktopBuild,
    options,
    selectedClientIds,
  );
  if (desktop.blocker !== undefined) return fail(desktop.blocker);
  const planned = await planSetupActions({
    discovery: planDiscovery,
    host,
    providerEnvironment,
    command: host.registrationCommand,
    clientIds: selectedClientIds,
    skillClientIds: selectedSkillClientIds,
    installSkill,
    clientEnvironments: desktop.clientEnvironments,
  });
  plannedActions = [...desktop.actions, ...planned.plannedActions];
  progress.plannedActions = plannedActions;
  if (planned.blocker !== undefined) return fail(planned.blocker);
  const hopperRefusal = hopperInstallRefusal(planDiscovery);
  if (hopperRefusal !== undefined) return fail(hopperRefusal);
  const planSelection = {
    installHopper: planDiscovery.installHopper,
    installSkill,
    skillSelected,
    selectedSkillClientIds,
    selectedClients: planned.selectedClients,
    clientsToConfigure: planned.clientsToConfigure,
  };
  readinessScope = resolvedReadinessScope(
    options.readinessScope,
    planSelection,
    desktop.selected,
  );

  const manualRemediation = combineRemediation(
    manualClientsRemediation(planned.selectedClients),
    desktop.remediation,
  );
  if (skillSelected) {
    const admission = await host.validateSkillDirectories(
      selectedSkillClientIds,
    );
    if (!admission.ok) return failSkill(admission.error);
  }
  if (options.dryRun === true)
    return {
      status: "planned",
      plannedActions,
      appliedActions,
      clients,
      doctor: summarizeDoctor(discovery.initialDoctor),
      clientStates,
      ...(manualRemediation === undefined
        ? {}
        : { remediation: manualRemediation }),
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
    assertSetupActive(options.signal);
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

  // Approval may pause while a skill manager changes a selected directory.
  if (planSelection.skillSelected) {
    const admission = await host.validateSkillDirectories(
      selectedSkillClientIds,
    );
    if (!admission.ok) return failSkill(admission.error);
  }
  assertSetupActive(options.signal);
  const desktopFailure = await desktop.apply(
    appliedActions,
    options.onProgress,
    options.signal,
  );
  progress.desktopFailure = desktopFailure;
  assertSetupActive(options.signal);
  let selectedClients: readonly SetupClient[] =
    planSelection.clientsToConfigure;
  let hopperWarning: string | undefined;
  let hopperFailure: SetupHopperInstallFailure | undefined;
  if (
    planSelection.installHopper &&
    (interactiveApproval || options.installHopper)
  ) {
    const install = await installHopperAction({
      host,
      options,
      appliedActions,
      selectedClients,
      providerEnvironment,
      clientEnvironments: desktop.clientEnvironments,
      recordResult: (result) => {
        progress.hopperOutcome = result;
      },
    });
    // Hopper is optional: a failed install still applies the client
    // registrations and skill approved with it (#5113).
    if ("failure" in install) hopperFailure = install.failure;
    else
      ({
        hopperPath,
        providerEnvironment,
        selectedClients,
        warning: hopperWarning,
      } = install);
  }
  assertSetupActive(options.signal);
  const clientFailure = await configureDetectedClients({
    host,
    detectedClients: selectedClients,
    providerEnvironment,
    clientEnvironments: desktop.clientEnvironments,
    command: host.registrationCommand,
    clients,
    appliedActions,
    signal: options.signal,
    ...(options.onProgress === undefined
      ? {}
      : { onProgress: options.onProgress }),
  });
  assertSetupActive(options.signal);
  // A later failure must not hide a failed Hopper install: keep its repair
  // steps, and its code when the later failure carries none.
  const withHopperFailure = (result: SetupResult): SetupResult =>
    hopperFailure === undefined
      ? result
      : {
          ...result,
          code: result.code ?? hopperFailure.code,
          remediation:
            combineRemediation(hopperFailure.remediation, result.remediation) ??
            hopperFailure.remediation,
          ...hopperDownload(hopperFailure),
        };
  if (clientFailure !== undefined)
    return withHopperFailure(await fail(clientFailure));
  if (planSelection.installSkill) {
    const skill = await installSkillAction(
      host,
      options,
      appliedActions,
      selectedSkillClientIds,
    );
    progress.skill = skill;
    if (!skill.ok && skill.error.completed) pending.skill = skill.error;
    assertSetupActive(options.signal);
    if (!skill.ok && !skill.error.completed) {
      return withHopperFailure(await failSkill(skill.error));
    }
  }
  const doctor = summarizeDoctor(await host.doctor(readinessScope));
  const remediation = combineRemediation(
    desktopFailure,
    ...(doctor.pluginChecks ?? [])
      .filter(({ ok }) => !ok)
      .map(({ remediation, detail }) => remediation ?? detail),
    hopperFailure?.remediation ??
      desktop.readinessRemediation(doctor.healthy) ??
      finalSetupRemediation(
        host.platform,
        appliedActions.includes("installed_hopper"),
        doctor.healthy,
        // Offer installation only where the explicit gate accepts it.
        hopperPath === undefined &&
          planDiscovery.hopperInstall.supported !== false,
      ),
    hopperWarning,
    manualRemediation,
  );
  return {
    status: remediation === undefined ? "ready" : "needs_human",
    plannedActions,
    appliedActions,
    clients,
    doctor,
    clientStates,
    ...(remediation === undefined ? {} : { remediation }),
    ...(hopperFailure === undefined
      ? {}
      : { code: hopperFailure.code, ...hopperDownload(hopperFailure) }),
  };
};

const hopperDownload = (
  failure: SetupHopperInstallFailure,
): Pick<SetupResult, "download"> =>
  failure.download === undefined ? {} : { download: failure.download };

const installHopperAction = async (input: {
  readonly host: SetupHost;
  readonly options: SetupOptions;
  readonly appliedActions: string[];
  readonly selectedClients: readonly SetupClient[];
  readonly providerEnvironment: SetupProviderEnvironment;
  readonly clientEnvironments: Readonly<
    Record<string, SetupProviderEnvironment>
  >;
  readonly recordResult: (result: SetupHopperInstallResult) => void;
}) => {
  const label = "Hopper deep-analysis provider";
  emitProgress(input.options, {
    actionId: "install_hopper",
    label,
    state: "started",
  });
  const installed = await input.host.installHopper(
    input.options.installHopper,
    input.options.signal,
  );
  input.recordResult(installed);
  if (installed.status === "failed") {
    emitProgress(input.options, {
      actionId: "install_hopper",
      label,
      state: "failed",
      detail: installed.remediation,
    });
    return { failure: installed };
  }
  input.appliedActions.push("installed_hopper");
  const warning = [installed.warning, installed.cleanupFailure]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  emitProgress(input.options, {
    actionId: "install_hopper",
    label,
    state: warning === "" ? "completed" : "warning",
    detail:
      warning === ""
        ? installed.launcherPath
        : `${installed.launcherPath}; ${warning}`,
  });
  const providerEnvironment = {
    ...input.providerEnvironment,
    HOPPER_LAUNCHER_PATH: installed.launcherPath,
  };
  return {
    hopperPath: installed.launcherPath,
    providerEnvironment,
    ...(warning === "" ? {} : { warning }),
    selectedClients: await filterClientsNeedingConfigure(
      input.host,
      input.selectedClients,
      { providerEnvironment, clientEnvironments: input.clientEnvironments },
      input.host.registrationCommand,
    ),
  };
};

const installSkillAction = async (
  host: SetupHost,
  options: SetupOptions,
  appliedActions: string[],
  skillClientIds: readonly string[],
): Promise<SkillInstallResult> => {
  const label = "REA reverse-engineering skill";
  emitProgress(options, {
    actionId: "install_skill",
    label,
    state: "started",
  });
  const skill = await host.installSkill(skillClientIds);
  if (!skill.ok) {
    if (skill.error.completed) appliedActions.push("installed_skill");
    emitProgress(options, {
      actionId: "install_skill",
      label,
      state: skill.error.completed ? "warning" : "failed",
      detail: skill.error.message,
    });
    return skill;
  }
  if (skill.value === "installed") appliedActions.push("installed_skill");
  emitProgress(options, {
    actionId: "install_skill",
    label,
    state: skill.value === "installed" ? "completed" : "warning",
    ...(skill.value === "unchanged" ? { detail: "Already current" } : {}),
  });
  return skill;
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

const manualClientsRemediation = (
  clients: readonly SetupClient[],
): string | undefined =>
  clients
    .map((client) => manualRegistrationRemediation(client.name))
    .find((remediation) => remediation !== undefined);

const combineRemediation = (
  ...parts: readonly (string | undefined)[]
): string | undefined => {
  const present = parts.filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return present.length === 0 ? undefined : present.join(" ");
};

const finalSetupRemediation = (
  platform: NodeJS.Platform,
  installedHopper: boolean,
  healthy: boolean,
  offerHopperInstall: boolean,
): string | undefined => {
  if (platform === "darwin" && installedHopper)
    return "Open Hopper, choose its demo mode or activate a license, then rerun rea doctor --json.";
  if (healthy) return undefined;
  return offerHopperInstall
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
    readonly selectedSkillClientIds: readonly string[];
  },
  desktopBuild: boolean,
): DoctorScope => ({
  clients: selection.selectedClients.map(({ name }) => name),
  providers: [
    ...new Set([
      ...(selection.installHopper ? ["hopper"] : (requested?.providers ?? [])),
      ...(desktopBuild ? [DESKTOP_BUILD_PROVIDER_ID] : []),
    ]),
  ],
  skill: selection.skillSelected === true || requested?.skill === true,
  ...(selection.skillSelected === true || requested?.skill === true
    ? { skillClients: selection.selectedSkillClientIds }
    : {}),
});

const summarizeDoctor = (report: DoctorReport): SetupDoctorSummary => ({
  healthy: report.healthy,
  environment_healthy: report.environment_healthy,
  scope: report.scope,
  ...(report.scope.plugin_clients === undefined
    ? {}
    : {
        pluginChecks: report.scope_checks.filter(({ name }) =>
          report.scope.plugin_clients?.some((id) => name === `plugin:${id}`),
        ),
      }),
  availableProviders: [
    ...(report.hopperPath !== undefined &&
    report.checks
      .filter(({ name }) => name.startsWith("hopper"))
      .every(({ ok }) => ok)
      ? ["hopper"]
      : []),
    ...(report.providerInspections ?? [])
      .filter(
        ({ available, checks }) => available && checks.every(({ ok }) => ok),
      )
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
