import type {
  SetupAction,
  SetupClient,
  SetupProviderEnvironment,
} from "./Setup.js";

/** Build the complete setup mutation plan before approval. */
export const setupPlan = (
  platform: NodeJS.Platform,
  installHopper: boolean,
  installSkill: boolean,
  clients: readonly SetupClient[],
  providerEnvironment: SetupProviderEnvironment,
): readonly SetupAction[] => [
  ...(installHopper
    ? [
        {
          kind: "install_hopper" as const,
          target:
            platform === "darwin"
              ? "~/Applications/Hopper Disassembler.app"
              : "system package manager",
          detail:
            platform === "linux"
              ? "Download, verify, and install Hopper plus its Xvfb demo-session dependencies. For the supported demo build, REA uses a private display and selects Hopper's offered demo mode for each analysis session."
              : "Download the official Hopper package, verify it, and install it. Hopper may show its demo or license prompt when first opened.",
          external: true,
        },
      ]
    : []),
  ...clients
    .filter(({ format }) => format !== "unsupported")
    .map(
      (client): SetupAction => ({
        kind: "configure_client",
        target: client.configPath,
        detail: clientConfigurationDetail(client.name, providerEnvironment),
        external: false,
      }),
    ),
  ...(installSkill
    ? [
        {
          kind: "install_skill" as const,
          target: "~/.agents/skills/rea-analysis/SKILL.md",
          detail: "Install or update the bundled REA analysis skill.",
          external: false,
        },
      ]
    : []),
];

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
