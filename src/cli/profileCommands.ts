import { z } from "incur";

import {
  profileTarget,
  MAX_PROFILE_MAX_BYTES,
} from "../application/ProfileTarget.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";

/**
 * Register the provider-free target profile command.
 *
 * Unlike most binary commands this needs no analysis provider: every fact it
 * reports is established from a bounded read of the target's own header, so
 * requiring a provider would make the command unavailable precisely when a
 * caller wants to know whether the target is worth opening at all.
 */
export const registerProfileCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.profile, {
    description:
      "Profile a target from its executable header, with per-fact confidence and explicit limitations",
    args: z.object({
      path: z.string().min(1).describe("Target file to profile"),
    }),
    options: z.object({
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(MAX_PROFILE_MAX_BYTES)
        .default(65_536)
        .describe(
          "Maximum bytes to read from the start of the file when inspecting its header",
        ),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.profile, () =>
        profileTarget(args.path, { maxBytes: options.maxBytes }),
      ),
  });
};
