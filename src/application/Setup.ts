import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { PRODUCT_IDENTITY } from "../identity.js";
import { supportsNodeVersion } from "../domain/runtimeVersion.js";
import {
  runDoctor,
  systemDoctorHost,
  type DoctorHost,
  type DoctorProviderInspection,
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
import { discoverSetupActions } from "./SetupPlan.js";
import {
  clientConfigurationAligned,
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
export type { SetupHopperInstallResult } from "./SetupInstallFailure.js";

/** Exact non-secret provider variables propagated into managed registrations. */
export type SetupProviderEnvironment = Readonly<Record<string, string>>;

export { canonicalSkillNeedsInstall, installCanonicalSkill };

const registrationCommand = (): readonly string[] =>
  process.env.npm_command === "exec"
    ? ["npx", "-y", PRODUCT_IDENTITY.packageSpecifier, "mcp"]
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
  doctor(): Promise<Awaited<ReturnType<typeof runDoctor>>>;
}
/** Structured setup outcome carrying remediation instead of prompting. */
export interface SetupResult {
  readonly status: "planned" | "needs_confirmation" | "ready" | "needs_human";
  readonly plannedActions: readonly SetupAction[];
  readonly appliedActions: readonly string[];
  readonly clients: Readonly<Record<string, ClientConfigurationResult>>;
  readonly doctor: Awaited<ReturnType<typeof runDoctor>>;
  readonly remediation?: string;
  readonly code?: SetupFailureCode;
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
}

/** Adapter-owned interactive confirmation for a fully discovered setup plan. */
export type SetupConfirmation = (
  actions: readonly SetupAction[],
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
  const fail = (remediation: string) =>
    setupFailure(remediation, [host, plannedActions, appliedActions, clients]);
  const unsupported = await hostRemediation(host, options.installHopper);
  if (unsupported !== undefined) return fail(unsupported);
  let hopperPath = await host.hopperPath();
  let providerEnvironment = await initialProviderEnvironment(host, hopperPath);
  const discovery = await discoverSetupActions({
    host,
    providerEnvironment,
    command: registrationCommand(),
    forceHopperInstall: options.installHopper,
    proposeHopper: options.proposeHopper ?? true,
    selectedClientIds: options.clientIds,
    installSkillSelection: options.installSkill,
  });
  if (discovery.blocker !== undefined) return fail(discovery.blocker);
  const selection = await resolveSetupSelection(options, discovery, confirm);
  plannedActions = selection.plannedActions;
  if (!selection.approved)
    return {
      status: confirm === undefined ? "needs_confirmation" : "planned",
      plannedActions,
      appliedActions,
      clients,
      doctor: await host.doctor(),
      remediation:
        "Review the setup plan, then rerun interactively or with --yes.",
    };

  let detectedClients: readonly SetupClient[] = selection.detectedClients;
  if (
    selection.installHopper &&
    (selection.interactiveApproval || options.installHopper)
  ) {
    const install = await installHopperAction({
      host,
      options,
      plannedActions,
      appliedActions,
      clients,
      detectedClients,
      providerEnvironment,
    });
    if ("failure" in install) return install.failure;
    ({ hopperPath, providerEnvironment, detectedClients } = install);
  }
  const clientFailure = await configureDetectedClients({
    host,
    detectedClients,
    providerEnvironment,
    command: registrationCommand(),
    clients,
    appliedActions,
    ...(options.onProgress === undefined
      ? {}
      : { onProgress: options.onProgress }),
  });
  if (clientFailure !== undefined) return fail(clientFailure);
  if (
    selection.installSkill &&
    !(await installSkillAction(host, options, appliedActions))
  )
    return fail(
      "REA analysis skill could not be installed or verified. Check permissions for `~/.agents/skills`, then rerun setup.",
    );
  const doctor = await host.doctor();
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
    ...(remediation === undefined ? {} : { remediation }),
  };
};

const resolveSetupSelection = async (
  options: SetupOptions,
  discovery: Awaited<ReturnType<typeof discoverSetupActions>>,
  confirm: SetupConfirmation | undefined,
) => {
  let { installHopper, installSkill, detectedClients, plannedActions } =
    discovery;
  let approved = options.approved || plannedActions.length === 0;
  let interactiveApproval = false;
  if (!approved && confirm !== undefined && !options.structured) {
    const decision = await confirm(plannedActions);
    if (typeof decision === "boolean") {
      interactiveApproval = decision;
      approved = decision;
    } else {
      const selected = new Set(decision.selectedActionIds);
      plannedActions = plannedActions.filter(({ id }) => selected.has(id));
      installHopper = plannedActions.some(
        ({ kind }) => kind === "install_hopper",
      );
      installSkill = plannedActions.some(
        ({ kind }) => kind === "install_skill",
      );
      detectedClients = detectedClients.filter((client) =>
        selected.has(`configure_client:${client.name}`),
      );
      interactiveApproval = decision.approved;
      approved = decision.approved || plannedActions.length === 0;
    }
  }
  return {
    approved,
    interactiveApproval,
    installHopper,
    installSkill,
    detectedClients,
    plannedActions,
  };
};

const installHopperAction = async (input: {
  readonly host: SetupHost;
  readonly options: SetupOptions;
  readonly plannedActions: readonly SetupAction[];
  readonly appliedActions: string[];
  readonly clients: Readonly<Record<string, ClientConfigurationResult>>;
  readonly detectedClients: readonly SetupClient[];
  readonly providerEnvironment: SetupProviderEnvironment;
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
        doctor: await input.host.doctor(),
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
    detectedClients: await filterClientsNeedingConfigure(
      input.host,
      input.detectedClients,
      providerEnvironment,
      registrationCommand(),
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
  [host, plannedActions, appliedActions, clients]: readonly [
    SetupHost,
    readonly SetupAction[],
    readonly string[],
    Readonly<Record<string, ClientConfigurationResult>>,
  ],
): Promise<SetupResult> => ({
  status: "needs_human",
  plannedActions,
  appliedActions,
  clients,
  doctor: await host.doctor(),
  remediation,
});

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

const hostRemediation = async (
  host: SetupHost,
  forceHopperInstall: boolean,
): Promise<string | undefined> => {
  if (host.platform !== "darwin" && host.platform !== "linux")
    return "REA supports Hopper on macOS and selected 64-bit Linux distributions.";
  if (!supportsNodeVersion(host.nodeVersion))
    return "Install Node.js 22.19+ or 24.11+ and rerun setup.";
  if (host.platform === "darwin") {
    const version = await host.macosVersion();
    return version === undefined || major(version) < 12
      ? "Upgrade to macOS 12 or newer."
      : undefined;
  }
  if ((await host.linuxDistribution())?.supported === true) return undefined;
  const providerEnvironment = await host.providerEnvironment?.();
  if (
    !forceHopperInstall &&
    providerEnvironment !== undefined &&
    Object.keys(providerEnvironment).length > 0
  )
    return undefined;
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
    configureClient: (client, providerEnvironment, command) =>
      client.format === "unsupported"
        ? Promise.resolve({ status: "skipped" })
        : client.format === "toml"
          ? configureTomlClient(client, providerEnvironment, command)
          : configureJsonClient(client, providerEnvironment, command),
    clientNeedsConfigure: (client, providerEnvironment, command) =>
      clientConfigurationAligned(client, providerEnvironment, command).then(
        (aligned) => !aligned,
      ),
    inspectClientConfiguration: inspectClientConfiguration,
    skillNeedsInstall: () => canonicalSkillNeedsInstall(homedir()),
    installSkill: () => installCanonicalSkill(homedir()),
    doctor: () => runDoctor(undefined, doctorHost),
  };
};

/** Detect supported agents from stable per-user installation markers. */
export const detectClients = async (
  home: string,
): Promise<readonly SetupClient[]> => {
  const detected: SetupClient[] = [];
  for (const candidate of supportedClients(home))
    if (await exists(candidate.markerPath ?? candidate.configPath))
      detected.push(candidate);
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
const providerRegistrationEnvironment = (
  inspections: readonly DoctorProviderInspection[],
): SetupProviderEnvironment =>
  Object.fromEntries(
    inspections
      .filter(({ available }) => available)
      .flatMap(({ registrationEnvironment }) =>
        Object.entries(registrationEnvironment),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
