import { join } from "node:path";

import { isOwnedClientRegistrationCommand } from "./ClientRegistrationIdentity.js";
import {
  linuxHopperInstallDisclosure,
  type LinuxPackageFamily,
} from "./LinuxHopper.js";
import { skillDestinations } from "./SetupSkill.js";
import { macHopperInstallDisclosure } from "./MacHopper.js";
import type {
  SetupAction,
  SetupClientState,
  SetupHost,
  SetupProviderEnvironment,
} from "./SetupTypes.js";
import type { SetupClient } from "./SupportedClients.js";
import type { DoctorReport } from "./Doctor.js";

/** Read-only setup facts shared by client selection and preflight. */
export interface SetupDiscovery {
  readonly initialDoctor: Awaited<ReturnType<SetupHost["doctor"]>>;
  readonly installHopper: boolean;
  readonly clients: readonly SetupClient[];
  readonly detectedClientIds: readonly string[];
  readonly defaultClientIds: readonly string[];
  readonly clientStates: readonly SetupClientState[];
  readonly linuxPackageFamily?: LinuxPackageFamily;
}

/** Discover supported clients and current registrations without mutation. */
export const discoverSetupState = async (input: {
  readonly host: SetupHost;
  readonly providerEnvironment: SetupProviderEnvironment;
  readonly forceHopperInstall: boolean;
  readonly proposeHopper: boolean;
  readonly initialDoctor: DoctorReport;
}): Promise<SetupDiscovery> => {
  const { initialDoctor } = input;
  const linuxHopperRepairNeeded = initialDoctor.checks.some(
    ({ name, ok, detail }) =>
      !ok &&
      (name === "hopper-demo-runtime" ||
        (name === "hopper-version" && detail === "/opt/hopper/bin/Hopper")),
  );
  const linuxDistribution =
    input.host.platform === "linux"
      ? await input.host.linuxDistribution()
      : undefined;
  const hopperInstallSupported =
    (input.host.platform === "darwin" &&
      majorVersion((await input.host.macosVersion()) ?? "0") >= 12) ||
    (input.host.platform === "linux" && linuxDistribution?.supported === true);
  const installHopper =
    input.forceHopperInstall ||
    (hopperInstallSupported &&
      input.proposeHopper &&
      (Object.keys(input.providerEnvironment).length === 0 ||
        linuxHopperRepairNeeded));
  const [clients, detectedClients] = await Promise.all([
    input.host.supportedClients(),
    input.host.detectedClients(),
  ]);
  const detectedIds = new Set(detectedClients.map(({ name }) => name));
  const registrations = initialDoctor.identity?.registrations ?? [];
  const registrationByClient = new Map(
    registrations.map((registration) => [registration.client, registration]),
  );
  const clientStates = clients.map((client): SetupClientState => {
    const registration = registrationByClient.get(client.name);
    const ownedRegistration =
      (registration?.state === "aligned" || registration?.state === "stale") &&
      isOwnedClientRegistrationCommand(registration.command);
    const configured = ownedRegistration;
    const status: SetupClientState["status"] =
      registration?.state === "invalid"
        ? "invalid"
        : ownedRegistration && registration.state === "aligned"
          ? "configured"
          : ownedRegistration && registration.state === "stale"
            ? "needs_configuration"
            : detectedIds.has(client.name)
              ? "needs_configuration"
              : "missing";
    return {
      client,
      detected: detectedIds.has(client.name),
      configured,
      status,
    };
  });
  const defaultClientIds = registrations
    .filter(
      (registration) =>
        (registration.state === "aligned" || registration.state === "stale") &&
        isOwnedClientRegistrationCommand(registration.command),
    )
    .map(({ client }) => client);
  return {
    initialDoctor,
    installHopper,
    clients,
    detectedClientIds: [...detectedIds],
    defaultClientIds,
    clientStates,
    ...(linuxDistribution?.packageFamily === undefined
      ? {}
      : { linuxPackageFamily: linuxDistribution.packageFamily }),
  };
};

/** Preflight exactly the selected clients and produce their concrete actions. */
export const planSetupActions = async (input: {
  readonly discovery: SetupDiscovery;
  readonly host: SetupHost;
  readonly providerEnvironment: SetupProviderEnvironment;
  readonly command: readonly string[];
  readonly clientIds: readonly string[];
  readonly skillClientIds: readonly string[];
  readonly installSkill: boolean;
}): Promise<{
  readonly plannedActions: readonly SetupAction[];
  readonly selectedClients: readonly SetupClient[];
  readonly clientsToConfigure: readonly SetupClient[];
  readonly blocker?: string;
}> => {
  const byId = new Map(
    input.discovery.clients.map((client) => [client.name, client]),
  );
  const unknownClient = input.clientIds.find((id) => !byId.has(id));
  if (unknownClient !== undefined) {
    return {
      plannedActions: [],
      selectedClients: [],
      clientsToConfigure: [],
      blocker: `Unsupported setup client: ${unknownClient}.`,
    };
  }
  const selectedClients = input.clientIds.flatMap((id) => {
    const client = byId.get(id);
    return client === undefined ? [] : [client];
  });
  const inspections = await Promise.all(
    selectedClients.map(async (client) => ({
      client,
      inspection: await input.host.inspectClientConfiguration(
        client,
        input.providerEnvironment,
        input.command,
      ),
    })),
  );
  const invalid = inspections.find(
    ({ inspection }) => inspection.status === "invalid",
  );
  if (invalid?.inspection.status === "invalid") {
    return {
      plannedActions: [],
      selectedClients,
      clientsToConfigure: [],
      blocker: `${invalid.client.displayName ?? invalid.client.name}: ${invalid.inspection.remediation}`,
    };
  }
  const clientPlans = inspections.flatMap(({ client, inspection }) =>
    client.format !== "unsupported" &&
    (inspection.status === "create" ||
      inspection.status === "update" ||
      (input.discovery.installHopper &&
        inspection.status === "already_current"))
      ? [
          {
            client,
            operation:
              inspection.status === "already_current"
                ? ("update" as const)
                : inspection.status,
            ...(inspection.status !== "already_current" &&
            inspection.backupPath !== undefined
              ? { backupPath: inspection.backupPath }
              : {}),
          },
        ]
      : [],
  );
  return {
    plannedActions: setupPlan({
      platform: input.host.platform,
      homeDirectory: input.host.homeDirectory,
      installHopper: input.discovery.installHopper,
      installSkill: input.installSkill,
      skillClientIds: input.skillClientIds,
      claudeCodeSkillsDirectory: input.host.claudeCodeSkillsDirectory,
      clients: clientPlans,
      providerEnvironment: input.providerEnvironment,
      ...(input.discovery.linuxPackageFamily === undefined
        ? {}
        : { linuxPackageFamily: input.discovery.linuxPackageFamily }),
      command: input.command,
    }),
    selectedClients,
    clientsToConfigure: selectedClients.filter((client) =>
      clientPlans.some(({ client: planned }) => planned.name === client.name),
    ),
  };
};

/** Describe every selected setup mutation before user approval. */
const setupPlan = (input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly installHopper: boolean;
  readonly installSkill: boolean;
  readonly skillClientIds: readonly string[];
  readonly claudeCodeSkillsDirectory: string;
  readonly clients: readonly {
    readonly client: SetupClient;
    readonly operation: "create" | "update";
    readonly backupPath?: string;
  }[];
  readonly providerEnvironment: SetupProviderEnvironment;
  readonly linuxPackageFamily?: LinuxPackageFamily;
  readonly command: readonly string[];
}): readonly SetupAction[] => [
  ...(input.installHopper
    ? [
        {
          id: "install_hopper",
          kind: "install_hopper" as const,
          label: "Hopper deep-analysis provider",
          target:
            input.platform === "darwin"
              ? join(
                  input.homeDirectory,
                  "Applications/Hopper Disassembler.app",
                )
              : "system package manager",
          detail:
            input.platform === "linux"
              ? "Download, verify, and install Hopper plus its Xvfb demo-session dependencies. For the supported demo build, REA uses a private display and selects Hopper's offered demo mode for each analysis session."
              : "Download the official Hopper package, verify it, and install it. Hopper may show its demo or license prompt when first opened.",
          external: true,
          operation: "install" as const,
          ...(input.platform === "linux"
            ? input.linuxPackageFamily === undefined
              ? {}
              : linuxDisclosure(input.linuxPackageFamily)
            : {
                networkOrigins: macHopperInstallDisclosure.networkOrigins,
                commands: macHopperInstallDisclosure.commands,
              }),
        },
      ]
    : []),
  ...input.clients
    .filter(({ client }) => client.format !== "unsupported")
    .map(({ client, operation, backupPath }): SetupAction => ({
      id: `configure_client:${client.name}`,
      kind: "configure_client",
      label: client.displayName ?? client.name,
      target: client.configPath,
      detail: clientConfigurationDetail(
        client.displayName ?? client.name,
        input.command,
        input.providerEnvironment,
        input.installHopper,
      ),
      external: false,
      operation,
      ...(backupPath === undefined ? {} : { backupPath }),
    })),
  ...(input.installSkill
    ? skillDestinations(
        input.homeDirectory,
        input.skillClientIds,
        input.claudeCodeSkillsDirectory,
      ).map(({ client, path }): SetupAction => ({
        id:
          client === "claude_code"
            ? "install_skill:claude_code"
            : "install_skill",
        kind: "install_skill",
        label:
          client === "claude_code"
            ? "REA skill for Claude Code"
            : "REA reverse-engineering skill",
        target: path,
        detail:
          client === "claude_code"
            ? "Install or update the REA skill in Claude Code's personal skill directory."
            : "Install or update the bundled REA reverse-engineering skill and on-demand references.",
        external: false,
        operation: "install",
      }))
    : []),
];

const linuxDisclosure = (family: LinuxPackageFamily) => {
  const disclosure = linuxHopperInstallDisclosure(
    family,
    process.getuid?.() === 0,
  );
  return {
    networkOrigins: [disclosure.downloadUrl],
    commands: disclosure.commands,
    integrity: `${String(disclosure.expectedBytes)} bytes · SHA-1 ${disclosure.expectedSha1}`,
  };
};

const majorVersion = (version: string): number =>
  Number.parseInt(version.split(".")[0] ?? "0", 10);

const clientConfigurationDetail = (
  client: string,
  command: readonly string[],
  environment: SetupProviderEnvironment,
  installHopper: boolean,
): string => {
  const entries = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`);
  const environmentDetail =
    entries.length === 0
      ? " No additional environment variables."
      : ` Environment: ${entries.join(", ")}.`;
  const hopperDetail = installHopper
    ? environment.HOPPER_LAUNCHER_PATH === undefined
      ? " If this plan installs Hopper, REA will add HOPPER_LAUNCHER_PATH using the launcher path reported by that installation."
      : " The HOPPER_LAUNCHER_PATH value shown above is the current fallback; if this plan installs Hopper, REA will replace it with the launcher path reported by that installation."
    : "";
  return `Add the REA MCP registration for ${client}; preserve unrelated configuration. Command: ${command.map((part) => JSON.stringify(part)).join(" ")}.${environmentDetail}${hopperDetail}`;
};
