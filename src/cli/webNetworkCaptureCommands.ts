import { z } from "incur";
import { createWebNetworkCaptureService } from "../composition/webNetworkCaptures.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Expose offline historical capture inspection with the same selection contract as MCP. */
export const registerWebNetworkCaptureCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = createWebNetworkCaptureService(environment);
  cli.command(CLI_COMMANDS.inspectWebNetworkCapture, {
    description:
      "Inspect retained HAR or native mitmproxy records without fetching recorded URLs",
    args: z.object({
      capturePath: z.string().describe("Absolute local capture path"),
      format: z.enum(["har", "mitmproxy"]).describe("Producer capture format"),
    }),
    options: z.object({
      record: z
        .array(z.coerce.number().int().nonnegative())
        .optional()
        .describe("Zero-based producer ordinals; repeat to select several"),
      sensitiveValue: z
        .array(z.string().min(1))
        .default([])
        .describe(
          "Literal string values explicitly marked sensitive; repeat as needed",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.inspectWebNetworkCapture,
          async () => {
            const result = await service.inspect(
              {
                capture_path: args.capturePath,
                format: args.format,
                sensitive_values: options.sensitiveValue,
                ...(options.record === undefined
                  ? {}
                  : { record_ordinals: options.record }),
              },
              { signal },
            );
            return result.ok
              ? result.value
              : projectAnalysisError(result.error);
          },
        ),
      ),
  });
};
