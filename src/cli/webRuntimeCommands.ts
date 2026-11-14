import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { Cli, z } from "incur";
import { createWebRuntimeService } from "../composition/webRuntime.js";
import { cliDomainInput } from "./domainInput.js";
import { observeWebExecutionInputSchema } from "../domain/webExecution.js";
import { inspectWebEventListenersInputSchema } from "../domain/webEventListeners.js";
import {
  browserScopeOptions,
  selectedCommandTimeout,
} from "../cliObservationOptions.js";
import { logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { cliDecimalField } from "./options.js";
import type { Logger } from "pino";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { cliProgressReporter } from "./cliProgress.js";

/** Register public equivalents of the two modular website runtime tools. */
export const registerWebRuntimeCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.observeWebExecution, {
    description:
      "Observe precise page execution; resets counters and temporarily disables optimization",
    args: z.object({
      endpoint: cliDomainInput(
        observeWebExecutionInputSchema.shape.cdp_endpoint,
      ).describe("Existing loopback browser CDP endpoint"),
      targetId: observeWebExecutionInputSchema.shape.target_id.describe(
        "Selected page target ID from list-browser-targets",
      ),
    }),
    options: z.object({
      ...browserScopeOptions,
      observationMs: cliDecimalField(
        observeWebExecutionInputSchema.shape.observation_ms,
      ).describe("Observation duration in milliseconds"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "observe-web-execution", async () => {
          const service = createWebRuntimeService();
          return await finishAnalysisCommand(
            () =>
              service.observe(
                {
                  cdp_endpoint: args.endpoint,
                  target_id: args.targetId,
                  allowed_origins: options.allowedOrigins,
                  observation_ms: options.observationMs,
                  ...selectedCommandTimeout(options.commandTimeoutMs),
                },
                { progress: cliProgressReporter, signal },
              ),
            {
              close: async () => {
                await service.provider.close?.();
              },
            },
            service.provider.identity().id,
            "observe_web_execution",
            signal,
          ).then(projectCliAnalysisResult);
        }),
      ),
  });
  cli.command(CLI_COMMANDS.inspectWebEventListeners, {
    description:
      "Inspect native listener source locations on the first main-document CSS match",
    args: z.object({
      endpoint: cliDomainInput(
        inspectWebEventListenersInputSchema.shape.cdp_endpoint,
      ).describe("Existing loopback browser CDP endpoint"),
      targetId: inspectWebEventListenersInputSchema.shape.target_id.describe(
        "Selected page target ID from list-browser-targets",
      ),
      selector: inspectWebEventListenersInputSchema.shape.selector.describe(
        "Native CSS selector; inspect the first main-document match",
      ),
    }),
    options: z.object({ ...browserScopeOptions }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "inspect-web-event-listeners", async () => {
          const service = createWebRuntimeService();
          return await finishAnalysisCommand(
            () =>
              service.inspect(
                {
                  cdp_endpoint: args.endpoint,
                  target_id: args.targetId,
                  selector: args.selector,
                  allowed_origins: options.allowedOrigins,
                  ...selectedCommandTimeout(options.commandTimeoutMs),
                },
                { signal },
              ),
            {
              close: async () => {
                await service.provider.close?.();
              },
            },
            service.provider.identity().id,
            "inspect_web_event_listeners",
            signal,
          ).then(projectCliAnalysisResult);
        }),
      ),
  });
};
