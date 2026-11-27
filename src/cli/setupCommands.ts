import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { z } from "zod";

import { omitEnvironmentSettings } from "../process/snapshotEnvironment.js";
import type { DoctorScope } from "../application/Doctor.js";
import {
  DESKTOP_BUILD_PROVIDER_ID,
  DOCTOR_PROVIDER_IDS,
} from "../domain/doctorProviderIds.js";
import {
  isSetupFailure,
  type SetupOptions,
} from "../application/SetupTypes.js";
import { isUninstallFailure } from "../application/UninstallFailure.js";
import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import {
  mcpToolFamiliesSchema,
  toolFamiliesConstraint,
} from "../config/mcpToolFamilies.js";
import { isUpdateFailure } from "../application/UpdateFailure.js";
import {
  mcpToolCatalogProfileSchema,
  type McpToolCatalogProfile,
} from "../config/mcpToolCatalogProfile.js";
import {
  confirmInteractiveSetup,
  createSetupJourney,
  renderSetupPlan,
  renderInteractiveSetupResult,
  renderSetupProgress,
} from "./interactiveSetup.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../contracts/cliCommandNames.js";
import type { Logger } from "pino";
import { registerCliCommand } from "./commandRegistry.js";
import type { CliInstance } from "./types.js";
import { skillClientSchema, supportedClientSchema } from "./clientNameInput.js";

/** Register setup, doctor, uninstall, and update CLI commands. */
export const registerSetupCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
  savedDefaults: ReadonlySet<string> | undefined,
): void => {
  registerSetupCommand(cli, logger, environment, savedDefaults);
  registerDoctorCommand(cli, logger, environment, savedDefaults);
  registerMaintenanceCommands(
    cli,
    logger,
    omitEnvironmentSettings(environment, savedDefaults),
  );
};

const registerSetupCommand = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
  savedDefaults: ReadonlySet<string> | undefined,
): void => {
  registerCliCommand(cli, CLI_COMMANDS.setup, {
    description: "Configure agent integrations and optional analysis providers",
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
      desktopBuild: z
        .boolean()
        .default(false)
        .describe(
          "Prepare this host for desktop builds: pack REA's build-computer runtime and record the build settings in the selected registrations",
        ),
      installAgentenv: z
        .boolean()
        .default(false)
        .describe(
          "With --desktop-build, also install the agentenv-framework release bundles target with uv",
        ),
      client: z
        .array(supportedClientSchema)
        .default([])
        .describe("Agent integration to configure; repeat for multiple agents"),
      skillClient: z
        .array(skillClientSchema)
        .default([])
        .describe("Existing client skill destination to update; repeatable"),
      toolFamilies: z
        .string()
        .optional()
        .refine(
          (value) =>
            value === undefined ||
            mcpToolFamiliesSchema.safeParse(value).success,
          { message: toolFamiliesConstraint },
        )
        .describe(
          "Comma-separated tool families this registration advertises; omit to preserve the saved selection, or advertise every tool if none is saved. To restore every tool, remove REA_MCP_TOOL_FAMILIES from the client's registration and restart the client.",
        ),
      toolCatalogProfile: mcpToolCatalogProfileSchema
        .optional()
        .describe(
          "MCP catalog: full advertises every in-scope tool; hot-cold loads tools on demand and requires client catalog refresh. Omit to preserve the saved profile, or use full if none is saved. Restart the client after changing it.",
        ),
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
    }),
    alias: { yes: "y" },
    run: ({ options, structuredOutput }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.setup,
          () =>
            runSetupCommand(
              { options, structuredOutput },
              environment,
              signal,
              savedDefaults,
            ),
          isSetupFailure,
        ),
      ),
  });
};

const registerDoctorCommand = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
  savedDefaults: ReadonlySet<string> | undefined,
): void => {
  registerCliCommand(cli, CLI_COMMANDS.doctor, {
    description: "Check whether REA is ready",
    options: z.object({
      target: localPathStringSchema
        .optional()
        .describe("Optional app path to check"),
      client: z
        .array(supportedClientSchema)
        .default([])
        .describe("Agent registration whose readiness is required; repeatable"),
      provider: z
        .array(z.enum(DOCTOR_PROVIDER_IDS))
        .default([])
        .describe(
          "Deep-analysis provider, or desktop_build for a desktop build host, whose readiness is required",
        ),
      skill: z
        .boolean()
        .optional()
        .describe("Require the installed REA skill identity to be aligned"),
    }),
    run: ({ options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "doctor", async () => {
          const [{ runDoctorOwned }, { createSystemDoctorHost }] =
            await Promise.all([
              import("../application/Doctor.js"),
              import("../doctorRuntime.js"),
            ]);
          return runDoctorOwned(
            options.target,
            createSystemDoctorHost(
              environment,
              signal,
              HOST_PLATFORM,
              savedDefaults,
            ),
            doctorScope(options),
          );
        }),
      ),
  });
};

const registerMaintenanceCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  registerCliCommand(cli, CLI_COMMANDS.uninstall, {
    description: "Remove REA-owned agent configuration and skill files",
    options: z.object({
      project: localPathStringSchema
        .optional()
        .describe(
          "Remove owned Pi and OpenCode registrations in this directory only",
        ),
      purgeData: z
        .boolean()
        .default(false)
        .describe("Also remove REA caches and state"),
    }),
    run: ({ options }) =>
      logCliCommand(
        logger,
        "uninstall",
        async () => {
          if (options.project !== undefined && options.purgeData)
            throw new ConfigurationError(
              "--project cannot be combined with --purge-data.",
            );
          const { runUninstall, systemUninstallHost } =
            await import("../application/Uninstall.js");
          return runUninstall(
            options.purgeData,
            systemUninstallHost(
              homeDirectoryFromEnvironment(environment, HOST_PLATFORM.platform),
              undefined,
              environment,
              HOST_PLATFORM.platform,
              undefined,
              options.project,
            ),
          );
        },
        isUninstallFailure,
      ),
  });
  registerCliCommand(cli, CLI_COMMANDS.update, {
    description:
      "Update this REA installation and verify the installed release",
    run: ({ structuredOutput }) =>
      logCliCommand(
        logger,
        CLI_COMMANDS.update,
        async () => {
          const [{ runUpdate }, { systemUpdateHost }] = await Promise.all([
            import("../application/Update.js"),
            import("../application/UpdateRuntime.js"),
          ]);
          return runUpdate(
            PRODUCT_IDENTITY.packageVersion,
            systemUpdateHost(
              undefined,
              undefined,
              environment,
              HOST_PLATFORM.platform,
            ),
            structuredOutput ? "structured" : "human",
          );
        },
        isUpdateFailure,
      ),
  });
};

interface SetupCommandOptions {
  readonly yes: boolean;
  readonly installHopper: boolean;
  readonly desktopBuild: boolean;
  readonly installAgentenv: boolean;
  readonly client: readonly string[];
  readonly skillClient: readonly string[];
  readonly toolFamilies?: string | undefined;
  readonly toolCatalogProfile?: McpToolCatalogProfile | undefined;
  readonly allDetected: boolean;
  readonly skill?: boolean | undefined;
  readonly dryRun: boolean;
  readonly accessible: boolean;
}

const runSetupCommand = async (
  input: {
    readonly options: SetupCommandOptions;
    readonly structuredOutput: boolean;
  },
  environment: Readonly<NodeJS.ProcessEnv>,
  signal: AbortSignal,
  savedDefaults: ReadonlySet<string> | undefined,
) => {
  const { options } = input;
  const interactive = setupIsInteractive(options, input.structuredOutput);
  const journey = createSetupJourney();
  const hasExplicitScope = setupHasExplicitScope(options);
  const [{ runSetup }, { systemSetupHost }, { createSystemDoctorHost }] =
    await Promise.all([
      import("../application/Setup.js"),
      import("../application/SetupHost.js"),
      import("../doctorRuntime.js"),
    ]);
  const result = await runSetup(
    { ...setupRunOptions(input, interactive, hasExplicitScope), signal },
    systemSetupHost(
      createSystemDoctorHost(
        environment,
        signal,
        HOST_PLATFORM,
        savedDefaults,
        "user",
      ),
      environment,
      savedDefaults,
    ),
    interactive
      ? (actions, context) =>
          confirmInteractiveSetup(
            actions,
            options.accessible,
            context,
            signal,
            journey,
          )
      : undefined,
  );
  if (interactive) renderInteractiveSetupResult(result, environment, journey);
  // Setup's output is agent-only, which the CLI hides when stdout is a
  // terminal and no document was requested, so that terminal gets a rendered
  // summary instead. A plan that was not applied is shown in full, because
  // its remediation asks the reader to review it.
  else if (!input.structuredOutput && process.stdout.isTTY === true) {
    if (result.status === "planned")
      renderSetupPlan(
        result.plannedActions,
        result.remediation,
        "Dry run complete. No changes were made.",
      );
    else if (result.status === "needs_confirmation")
      renderSetupPlan(
        result.plannedActions,
        result.remediation,
        "No changes were made.",
      );
    else renderInteractiveSetupResult(result, environment, journey);
  }
  return result;
};

const setupRunOptions = (
  input: {
    readonly options: SetupCommandOptions;
    readonly structuredOutput: boolean;
  },
  interactive: boolean,
  hasExplicitScope: boolean,
): SetupOptions => {
  const { options } = input;
  const desktopBuild = desktopBuildSelected(options);
  const agentIntegrationSelected =
    options.allDetected ||
    options.client.length > 0 ||
    options.skillClient.length > 0 ||
    desktopBuild;
  const hasSelectedClients =
    hasExplicitScope &&
    (options.client.length > 0 || options.skillClient.length > 0);
  return {
    approved: options.yes && !options.dryRun,
    installHopper: options.installHopper,
    structured: input.structuredOutput || options.dryRun,
    dryRun: options.dryRun,
    allDetectedClients: options.allDetected,
    proposeHopper: interactive || options.installHopper,
    ...desktopBuildOptions(options),
    ...(hasSelectedClients ? { clientIds: options.client } : {}),
    ...(options.skillClient.length > 0
      ? { skillClientIds: options.skillClient }
      : {}),
    ...(hasExplicitScope
      ? { installSkill: options.skill ?? agentIntegrationSelected }
      : {}),
    ...(options.toolFamilies === undefined
      ? {}
      : { toolFamilies: options.toolFamilies }),
    ...(options.toolCatalogProfile === undefined
      ? {}
      : { toolCatalogProfile: options.toolCatalogProfile }),
    ...(interactive ? { onProgress: renderSetupProgress } : {}),
    ...(hasSelectedClients && !options.allDetected
      ? {
          readinessScope: {
            clients: options.client,
            ...(options.skillClient.length > 0
              ? { skillClients: options.skillClient }
              : {}),
            providers: setupProviders(options),
            skill: options.skill ?? agentIntegrationSelected,
          },
        }
      : {}),
  };
};

/** `--install-agentenv` implies `--desktop-build`. */
const desktopBuildSelected = (options: SetupCommandOptions): boolean =>
  options.desktopBuild || options.installAgentenv;

const desktopBuildOptions = (
  options: SetupCommandOptions,
): Pick<SetupOptions, "desktopBuild" | "installAgentenv"> =>
  desktopBuildSelected(options)
    ? { desktopBuild: true, installAgentenv: options.installAgentenv }
    : {};

/** Providers whose readiness the selected setup requires. */
const setupProviders = (options: SetupCommandOptions): readonly string[] => [
  ...(options.installHopper ? ["hopper"] : []),
  ...(desktopBuildSelected(options) ? [DESKTOP_BUILD_PROVIDER_ID] : []),
];

const setupIsInteractive = (
  options: SetupCommandOptions,
  structuredOutput: boolean,
): boolean =>
  !options.yes &&
  !options.dryRun &&
  !structuredOutput &&
  hasInteractiveTerminal();

const hasInteractiveTerminal = (): boolean =>
  process.stdin.isTTY === true &&
  process.stdout.isTTY === true &&
  process.stderr.isTTY === true;

const setupHasExplicitScope = (options: SetupCommandOptions): boolean =>
  options.allDetected ||
  options.client.length > 0 ||
  options.skillClient.length > 0 ||
  options.skill !== undefined ||
  options.installHopper ||
  options.desktopBuild ||
  options.installAgentenv;

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
