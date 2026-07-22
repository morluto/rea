import { z } from "incur";

import {
  DOCTOR_PROVIDER_IDS,
  runDoctor,
  type DoctorScope,
} from "../application/Doctor.js";
import {
  runSetup,
  systemSetupHost,
  type SetupOptions,
} from "../application/Setup.js";
import { runUninstall } from "../application/Uninstall.js";
import { runUpgrade, systemUpgradeHost } from "../application/Upgrade.js";
import {
  conciseSetupResult,
  confirmInteractiveSetup,
  renderInteractiveSetupResult,
  renderSetupProgress,
} from "../cliSetup.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { logCliCommand } from "../cliLogging.js";
import { createSystemDoctorHost } from "../doctorRuntime.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";
import { SUPPORTED_CLIENT_DEFINITIONS } from "../application/SupportedClients.js";
import { projectDoctorReport } from "../application/DoctorProjection.js";

const supportedClientIds = SUPPORTED_CLIENT_DEFINITIONS.map(({ name }) => name);
const supportedClientSchema = z
  .string()
  .refine(
    (candidate) => supportedClientIds.some((name) => name === candidate),
    "Unsupported agent integration",
  );

/** Register setup, doctor, uninstall, and upgrade CLI commands. */
export const registerSetupCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerSetupCommand(cli, logger);
  registerDoctorCommand(cli, logger);
  registerMaintenanceCommands(cli, logger);
};

const registerSetupCommand = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.setup, {
    description: "Install requirements and configure agents",
    outputPolicy: "agent-only",
    options: z.object({
      yes: z
        .boolean()
        .default(false)
        .describe("Approve user-owned setup actions without prompting"),
      installHopper: z
        .boolean()
        .default(false)
        .describe("Also approve Hopper installation with --yes"),
      client: z
        .array(supportedClientSchema)
        .default([])
        .describe("Agent integration to configure; repeat for multiple agents"),
      allDetected: z
        .boolean()
        .default(false)
        .describe("Configure every detected supported agent"),
      skill: z
        .boolean()
        .optional()
        .describe(
          "Override the bundled skill included with agent integrations",
        ),
      dryRun: z
        .boolean()
        .default(false)
        .describe("Print the resolved plan without applying it"),
      accessible: z
        .boolean()
        .default(false)
        .describe("Use sequential accessible setup prompts"),
      detail: z
        .enum(["summary", "full"])
        .default("summary")
        .describe("Summary or complete setup and doctor diagnostics"),
    }),
    alias: { yes: "y" },
    run: ({ options, formatExplicit }) =>
      logCliCommand(logger, "setup", () =>
        runSetupCommand({ options, formatExplicit }),
      ),
  });
};

const registerDoctorCommand = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.doctor, {
    description: "Check whether REA is ready",
    options: z.object({
      target: z.string().optional().describe("Optional app path to check"),
      client: z
        .array(supportedClientSchema)
        .default([])
        .describe("Agent registration whose readiness is required; repeatable"),
      provider: z
        .array(z.enum(DOCTOR_PROVIDER_IDS))
        .default([])
        .describe("Deep-analysis provider whose readiness is required"),
      skill: z
        .boolean()
        .optional()
        .describe("Require the installed REA skill identity to be aligned"),
      detail: z
        .enum(["summary", "full"])
        .default("summary")
        .describe("Summary or complete doctor diagnostics"),
    }),
    run: ({ options }) =>
      logCliCommand(logger, "doctor", () =>
        runDoctor(
          options.target,
          createSystemDoctorHost(),
          doctorScope(options),
        ).then((report) => projectDoctorReport(report, options.detail)),
      ),
  });
};

const registerMaintenanceCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.uninstall, {
    description: "Remove REA-owned agent configuration and skill files",
    options: z.object({
      purgeData: z
        .boolean()
        .default(false)
        .describe("Also remove REA caches and state"),
    }),
    alias: { purgeData: "purge-data" },
    run: ({ options }) =>
      logCliCommand(logger, "uninstall", () => runUninstall(options.purgeData)),
  });
  cli.command(CLI_COMMANDS.upgrade, {
    description: "Upgrade a global npm installation to the latest REA release",
    run: ({ formatExplicit }) =>
      logCliCommand(logger, "upgrade", () =>
        runUpgrade(
          PRODUCT_IDENTITY.packageVersion,
          systemUpgradeHost(),
          formatExplicit ? "structured" : "human",
        ),
      ),
  });
};

interface SetupCommandOptions {
  readonly yes: boolean;
  readonly installHopper: boolean;
  readonly client: readonly string[];
  readonly allDetected: boolean;
  readonly skill?: boolean | undefined;
  readonly dryRun: boolean;
  readonly accessible: boolean;
  readonly detail: "summary" | "full";
}

const runSetupCommand = async (input: {
  readonly options: SetupCommandOptions;
  readonly formatExplicit: boolean;
}) => {
  const { options } = input;
  const interactive = setupIsInteractive(options, input.formatExplicit);
  const hasExplicitScope = setupHasExplicitScope(options);
  if (options.yes && !hasExplicitScope)
    process.stderr.write(
      "!  Implicit `rea setup --yes` scope is deprecated; use `--all-detected` to retain it.\n",
    );
  const result = await runSetup(
    setupRunOptions(input, interactive, hasExplicitScope),
    systemSetupHost(createSystemDoctorHost()),
    interactive
      ? (actions) => confirmInteractiveSetup(actions, options.accessible)
      : undefined,
  );
  if (interactive) renderInteractiveSetupResult(result);
  return options.detail === "full" ? result : conciseSetupResult(result);
};

const setupRunOptions = (
  input: {
    readonly options: SetupCommandOptions;
    readonly formatExplicit: boolean;
  },
  interactive: boolean,
  hasExplicitScope: boolean,
): SetupOptions => {
  const { options } = input;
  const agentIntegrationSelected =
    options.allDetected || options.client.length > 0;
  const hasSelectedClients = hasExplicitScope && !options.allDetected;
  return {
    approved: options.yes && !options.dryRun,
    installHopper: options.installHopper,
    structured: input.formatExplicit || options.dryRun,
    proposeHopper: !hasExplicitScope || options.installHopper,
    ...(hasSelectedClients ? { clientIds: options.client } : {}),
    ...(hasExplicitScope
      ? { installSkill: options.skill ?? agentIntegrationSelected }
      : {}),
    ...(interactive ? { onProgress: renderSetupProgress } : {}),
    ...(hasSelectedClients
      ? {
          readinessScope: {
            clients: options.client,
            providers: options.installHopper ? ["hopper"] : [],
            skill: options.skill ?? agentIntegrationSelected,
          },
        }
      : {}),
  };
};

const setupIsInteractive = (
  options: SetupCommandOptions,
  formatExplicit: boolean,
): boolean =>
  !options.yes &&
  !options.dryRun &&
  !formatExplicit &&
  process.stdin.isTTY === true &&
  process.stderr.isTTY === true;

const setupHasExplicitScope = (options: SetupCommandOptions): boolean =>
  options.allDetected ||
  options.client.length > 0 ||
  options.skill !== undefined ||
  options.installHopper;

const doctorScope = (options: {
  readonly client: readonly string[];
  readonly provider: readonly string[];
  readonly skill?: boolean | undefined;
}): DoctorScope | undefined =>
  options.client.length === 0 &&
  options.provider.length === 0 &&
  options.skill === undefined
    ? undefined
    : {
        clients: options.client,
        providers: options.provider,
        skill: options.skill === true,
      };
