import { z } from "incur";
import { createInterface } from "node:readline/promises";

import { runDoctor } from "../application/Doctor.js";
import {
  runSetup,
  systemSetupHost,
  type SetupAction,
} from "../application/Setup.js";
import { runUninstall } from "../application/Uninstall.js";
import { runUpgrade, systemUpgradeHost } from "../application/Upgrade.js";
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
    options: z.object({
      yes: z
        .boolean()
        .default(false)
        .describe("Approve user-owned setup actions without prompting"),
      installHopper: z
        .boolean()
        .default(false)
        .describe("Also approve Hopper installation with --yes"),
    }),
    alias: { yes: "y", installHopper: "install-hopper" },
    run: ({ options, formatExplicit }) =>
      logCliCommand(logger, "setup", () =>
        runSetup(
          {
            approved: options.yes,
            installHopper: options.installHopper,
            structured: formatExplicit,
          },
          systemSetupHost(createSystemDoctorHost()),
          options.yes || formatExplicit || process.stdin.isTTY !== true
            ? undefined
            : confirmSetup,
        ),
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

const confirmSetup = async (
  actions: readonly SetupAction[],
): Promise<boolean> => {
  process.stdout.write("\nREA setup plan\n");
  for (const action of actions)
    process.stdout.write(
      `  - ${action.detail}\n    ${action.target}${action.external ? " (external software)" : ""}\n`,
    );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await prompt.question("Continue? [Y/n] "))
      .trim()
      .toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
};
