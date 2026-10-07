import { Cli, z } from "incur";
import { createWebRuntimeService } from "../composition/webRuntime.js";
import { browserCliError } from "../cliBrowserContext.js";
import {
  browserScopeOptions,
  observationDuration,
} from "../cliObservationOptions.js";
import { logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import type { Logger } from "../logger.js";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** CLI progress exposes the actual armed point on stderr without corrupting JSON results. */
const runtimeProgress: ProgressReporter = {
  report: async (update) => {
    process.stderr.write(`${JSON.stringify({ rea_progress: update })}\n`);
  },
};

/** Register public equivalents of the two modular website runtime tools. */
export const registerWebRuntimeCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.observeWebExecution, {
    description:
      "Observe precise page execution; resets counters and temporarily disables optimization",
    args: z.object({
      endpoint: z.string().describe("Existing loopback browser CDP endpoint"),
      targetId: z
        .string()
        .describe("Selected page target ID from list-browser-targets"),
    }),
    options: z.object({
      ...browserScopeOptions,
      observationMs: observationDuration(10_000, 1),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "observe-web-execution", async () => {
        const result = await withCommandCancellation((signal) =>
          createWebRuntimeService().observe(
            {
              cdp_endpoint: args.endpoint,
              target_id: args.targetId,
              allowed_origins: options.allowedOrigins,
              observation_ms: options.observationMs,
            },
            { progress: runtimeProgress, signal },
          ),
        );
        return result.ok ? result.value : browserCliError(result.error);
      }),
  });
  cli.command(CLI_COMMANDS.inspectWebEventListeners, {
    description:
      "Inspect native listener source locations on the first main-document CSS match",
    args: z.object({
      endpoint: z.string().describe("Existing loopback browser CDP endpoint"),
      targetId: z
        .string()
        .describe("Selected page target ID from list-browser-targets"),
      selector: z
        .string()
        .describe("Native CSS selector; inspect the first main-document match"),
    }),
    options: z.object({ ...browserScopeOptions }),
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-web-event-listeners", async () => {
        const result = await withCommandCancellation((signal) =>
          createWebRuntimeService().inspect(
            {
              cdp_endpoint: args.endpoint,
              target_id: args.targetId,
              selector: args.selector,
              allowed_origins: options.allowedOrigins,
            },
            { signal },
          ),
        );
        return result.ok ? result.value : browserCliError(result.error);
      }),
  });
};
