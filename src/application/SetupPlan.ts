import { homedir } from "node:os";
import { join } from "node:path";

import { PRODUCT_IDENTITY } from "../identity.js";
import {
  linuxHopperInstallDisclosure,
  type LinuxPackageFamily,
} from "./LinuxHopper.js";
import { macHopperInstallDisclosure } from "./MacHopper.js";
import type {
  SetupAction,
  SetupClient,
  SetupHost,
  SetupProviderEnvironment,
} from "./Setup.js";
import type { DoctorScope } from "./Doctor.js";

/** Preflighted client mutation admitted into the setup plan. */
type SetupClientPlan = Readonly<{
  client: SetupClient;
  operation: "create" | "update";
  backupPath?: string;
}>;

/** Inputs used to build the setup mutation plan. */
interface SetupPlanOptions {
  readonly platform: NodeJS.Platform;
  readonly installHopper: boolean;
  readonly installSkill: boolean;
  readonly clients: readonly SetupClientPlan[];
  readonly providerEnvironment: SetupProviderEnvironment;
  readonly linuxPackageFamily?: LinuxPackageFamily;
}

/** Build the complete setup mutation plan before approval. */
const setupPlan = (input: SetupPlanOptions): readonly SetupAction[] => [
  ...(input.installHopper
    ? [
        {
          id: "install_hopper",
          kind: "install_hopper" as const,
          label: "Hopper deep-analysis provider",
          target:
            input.platform === "darwin"
              ? join(homedir(), "Applications/Hopper Disassembler.app")
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
    .map(
      ({ client, operation, backupPath }): SetupAction => ({
        id: `configure_client:${client.name}`,
        kind: "configure_client",
        label: client.displayName ?? client.name,
        target: client.configPath,
        detail: clientConfigurationDetail(
          client.displayName ?? client.name,
          input.providerEnvironment,
        ),
        external: false,
        operation,
        ...(backupPath === undefined ? {} : { backupPath }),
      }),
    ),
  ...(input.installSkill
    ? [
        {
          id: "install_skill",
          kind: "install_skill" as const,
          label: "REA reverse-engineering skill",
          target: join(homedir(), ".agents/skills", PRODUCT_IDENTITY.skillName),
          detail:
            "Install or update the bundled REA reverse-engineering skill and on-demand references.",
          external: false,
          operation: "install" as const,
        },
      ]
    : []),
];

/** Discover and preflight the complete set of selectable setup actions. */
export const discoverSetupActions = async (input: {
  readonly host: SetupHost;
  readonly providerEnvironment: SetupProviderEnvironment;
  readonly command: readonly string[];
  readonly forceHopperInstall: boolean;
  readonly proposeHopper: boolean;
  readonly selectedClientIds: readonly string[] | undefined;
  readonly installSkillSelection: boolean | undefined;
  readonly doctorScope: DoctorScope | undefined;
}) => {
  const { host, providerEnvironment, command } = input;
  const initialDoctor = await host.doctor(input.doctorScope);
  const linuxHopperRepairNeeded = initialDoctor.checks.some(
    ({ name, ok, detail }) =>
      !ok &&
      (name === "hopper-demo-runtime" ||
        (name === "hopper-version" && detail === "/opt/hopper/bin/Hopper")),
  );
  const installHopper =
    input.forceHopperInstall ||
    (input.proposeHopper &&
      (Object.keys(providerEnvironment).length === 0 ||
        linuxHopperRepairNeeded));
  const [allDetectedClients, skillNeedsInstall] = await Promise.all([
    host.detectedClients(),
    host.skillNeedsInstall(),
  ]);
  const selectedClientIdSet =
    input.selectedClientIds === undefined
      ? undefined
      : new Set(input.selectedClientIds);
  const detectedClients = allDetectedClients.filter(
    ({ name }) =>
      selectedClientIdSet === undefined || selectedClientIdSet.has(name),
  );
  const installSkill =
    input.installSkillSelection === false ? false : skillNeedsInstall;
  const clients = installHopper
    ? detectedClients
    : await filterClientsNeedingConfigure({
        host,
        clients: detectedClients,
        providerEnvironment,
        command,
      });
  const inspections = await inspectClients({
    host,
    clients,
    providerEnvironment,
    command,
  });
  const invalid = inspections.find(
    ({ inspection }) => inspection.status === "invalid",
  );
  const blocker =
    invalid?.inspection.status === "invalid"
      ? `${invalid.client.displayName ?? invalid.client.name}: ${invalid.inspection.remediation}`
      : undefined;
  const clientPlans = inspections.flatMap(({ client, inspection }) =>
    inspection.status === "create" ||
    inspection.status === "update" ||
    (installHopper && inspection.status === "already_current")
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
  const linuxDistribution =
    host.platform === "linux" ? await host.linuxDistribution() : undefined;
  return {
    initialDoctor,
    installHopper,
    installSkill,
    detectedClients: clientPlans.map(({ client }) => client),
    plannedActions: setupPlan({
      platform: host.platform,
      installHopper,
      installSkill,
      clients: clientPlans,
      providerEnvironment,
      ...(linuxDistribution?.packageFamily === undefined
        ? {}
        : { linuxPackageFamily: linuxDistribution.packageFamily }),
    }),
    blocker,
  };
};

const inspectClients = async (input: {
  readonly host: SetupHost;
  readonly clients: readonly SetupClient[];
  readonly providerEnvironment: SetupProviderEnvironment;
  readonly command: readonly string[];
}) =>
  Promise.all(
    input.clients.map(async (client) => ({
      client,
      inspection:
        (await input.host.inspectClientConfiguration?.(
          client,
          input.providerEnvironment,
          input.command,
        )) ?? ({ status: "update" } as const),
    })),
  );

const filterClientsNeedingConfigure = async (input: {
  readonly host: SetupHost;
  readonly clients: readonly SetupClient[];
  readonly providerEnvironment: SetupProviderEnvironment;
  readonly command: readonly string[];
}): Promise<readonly SetupClient[]> => {
  const needs = await Promise.all(
    input.clients.map((client) =>
      input.host.clientNeedsConfigure(
        client,
        input.providerEnvironment,
        input.command,
      ),
    ),
  );
  return input.clients.filter((_, index) => needs[index]);
};

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

const clientConfigurationDetail = (
  client: string,
  environment: SetupProviderEnvironment,
): string => {
  const entries = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`);
  const suffix =
    entries.length === 0 ? "" : ` Environment: ${entries.join(", ")}.`;
  return `Add the REA MCP registration for ${client}; preserve unrelated configuration.${suffix}`;
};
