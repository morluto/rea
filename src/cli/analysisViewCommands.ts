import { z } from "incur";

import { inspectAnalysisViewValidated } from "../application/analysisView/AnalysisViewService.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { logCliCommand } from "../cliLogging.js";
import { inspectAnalysisViewInputSchema } from "../domain/analysisView/analysisView.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";

/** Project selected views of completed analysis Evidence through the CLI. */
export const registerAnalysisViewCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectAnalysisView, {
    description:
      "Project a selected view of completed layout or JavaScript application Evidence JSON",
    args: z.object({
      inputJson: z.string().describe("Inline workflow JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, CLI_COMMANDS.inspectAnalysisView, async () => {
        const input = await parseCliJsonInput(
          args.inputJson,
          CLI_COMMANDS.inspectAnalysisView,
        );
        if (!input.ok) return input.error;
        const parsed = inspectAnalysisViewInputSchema.safeParse(input.value);
        if (!parsed.success)
          return {
            error: "Application workflow failed",
            ...projectAnalysisError(
              analysisInputErrorFromIssues(
                CLI_COMMANDS.inspectAnalysisView,
                parsed.error.issues,
                input.value,
              ),
            ),
          };
        const result = inspectAnalysisViewValidated(parsed.data);
        return result.ok
          ? jsonValueSchema.parse(result.value)
          : {
              error: "Application workflow failed",
              ...projectAnalysisError(result.error),
            };
      }),
  });
};
