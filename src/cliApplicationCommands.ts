import { Cli, z } from "incur";

import {
  compareApplicationVersionsEvidence,
  traceApplicationFeatureEvidence,
} from "./application/JavaScriptApplicationWorkflowService.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { parseCliJsonInput } from "./cliJsonInput.js";
import { logCliCommand } from "./cliLogging.js";
import { AnalysisInputError, projectAnalysisError } from "./domain/errors.js";
import type { JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "./logger.js";

/** Register CLI equivalents of provider-neutral application graph workflows. */
export const registerApplicationCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  registerJsonCommand(
    cli,
    logger,
    CLI_COMMANDS.traceApplicationFeature,
    "Trace a typed seed through authenticated application Evidence JSON",
    traceApplicationFeatureEvidence,
  );
  registerJsonCommand(
    cli,
    logger,
    CLI_COMMANDS.compareApplicationVersions,
    "Compare two authenticated JavaScript Application Graph versions",
    compareApplicationVersionsEvidence,
  );
};

const registerJsonCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  name: string,
  description: string,
  workflow: (
    input: unknown,
  ) =>
    | { readonly ok: true; readonly value: JsonValue }
    | { readonly ok: false; readonly error: Error },
): void => {
  cli.command(name, {
    description,
    args: z.object({
      inputJson: z.string().describe("Inline workflow JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, name, async () => {
        const input = await parseCliJsonInput(args.inputJson, name);
        if (!input.ok) return input.error;
        const result = workflow(input.value);
        return result.ok
          ? result.value
          : {
              error: "Application workflow failed",
              ...projectAnalysisError(
                result.error instanceof AnalysisInputError
                  ? result.error
                  : new AnalysisInputError(name),
              ),
            };
      }),
  });
};
