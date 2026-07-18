import type {
  SetupAction,
  SetupClient,
  SetupProviderEnvironment,
} from "./Setup.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  linuxHopperInstallDisclosure,
  type LinuxPackageFamily,
} from "./LinuxHopper.js";
import { macHopperInstallDisclosure } from "./MacHopper.js";

/** Preflighted client mutation admitted into the setup plan. */
export type SetupClientPlan = Readonly<{
  client: SetupClient;
  operation: "create" | "update";
  backupPath?: string;
}>;

/** Build the complete setup mutation plan before approval. */
export const setupPlan = (input: {
  readonly platform: NodeJS.Platform;
  readonly installHopper: boolean;
  readonly installSkill: boolean;
  readonly clients: readonly SetupClientPlan[];
  readonly providerEnvironment: SetupProviderEnvironment;
  readonly linuxPackageFamily?: LinuxPackageFamily;
}): readonly SetupAction[] => [
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
          target: join(
            homedir(),
            ".agents/skills",
            PRODUCT_IDENTITY.skillName,
            "SKILL.md",
          ),
          detail:
            "Install or update the bundled REA reverse-engineering skill.",
          external: false,
          operation: "install" as const,
        },
      ]
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
