import { z } from "incur";

import { runDoctor } from "../application/Doctor.js";
import { runSetup, systemSetupHost } from "../application/Setup.js";
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

export const registerSetupCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
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
        .array(
          z.enum([
            "claude_code",
            "claude_desktop",
            "codex",
            "cursor",
            "gemini_cli",
            "windsurf",
          ]),
        )
        .default([])
        .describe("Agent integration to configure; repeat for multiple agents"),
      allDetected: z
        .boolean()
        .default(false)
        .describe("Configure every detected supported agent"),
      skill: z
        .boolean()
        .optional()
        .describe("Install or skip the bundled REA skill"),
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
    run: ({ options, formatExplicit, agent }) =>
      logCliCommand(logger, "setup", () =>
        runSetupCommand({ options, formatExplicit, agent }),
      ),
  });
  cli.command(CLI_COMMANDS.doctor, {
    description: "Check whether REA is ready",
    options: z.object({
      target: z.string().optional().describe("Optional app path to check"),
    }),
    run: ({ options }) =>
      logCliCommand(logger, "doctor", () =>
        runDoctor(options.target, createSystemDoctorHost()),
      ),
  });
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
}

const runSetupCommand = async (input: {
  readonly options: SetupCommandOptions;
  readonly formatExplicit: boolean;
  readonly agent: boolean;
}) => {
  const { options } = input;
  const interactive =
    !options.yes &&
    !options.dryRun &&
    !input.formatExplicit &&
    process.stdin.isTTY === true &&
    process.stderr.isTTY === true;
  const hasExplicitScope = setupHasExplicitScope(options);
  if (options.yes && !hasExplicitScope)
    process.stderr.write(
      "!  Implicit `rea setup --yes` scope is deprecated; use `--all-detected --skill` to retain it.\n",
    );
  const result = await runSetup(
    {
      approved: options.yes && !options.dryRun,
      installHopper: options.installHopper,
      structured: input.formatExplicit || options.dryRun,
      proposeHopper: !hasExplicitScope || options.installHopper,
      ...(!hasExplicitScope || options.allDetected
        ? {}
        : { clientIds: options.client }),
      ...(!hasExplicitScope ? {} : { installSkill: options.skill ?? false }),
      ...(interactive ? { onProgress: renderSetupProgress } : {}),
    },
    systemSetupHost(createSystemDoctorHost()),
    interactive
      ? (actions) => confirmInteractiveSetup(actions, options.accessible)
      : undefined,
  );
  if (interactive) renderInteractiveSetupResult(result);
  return input.formatExplicit ? result : conciseSetupResult(result);
};

const setupHasExplicitScope = (options: SetupCommandOptions): boolean =>
  options.allDetected ||
  options.client.length > 0 ||
  options.skill !== undefined ||
  options.installHopper;
