import { z } from "incur";

import { projectManagedApplicationGraphEvidence } from "../application/ManagedApplicationGraphService.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/errors.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";

/** Register managed static-Evidence application graph projection. */
export const registerProjectManagedApplicationGraph = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.projectManagedApplicationGraph, {
    description:
      "Project authenticated managed static Evidence into an application graph",
    args: z.object({
      inputJson: z
        .string()
        .describe("Inline managed application graph JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "project-managed-application-graph", async () => {
        const input = await parseCliJsonInput(
          args.inputJson,
          "project-managed-application-graph",
        );
        if (!input.ok) return input.error;
        const result = projectManagedApplicationGraphEvidence(input.value);
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
  });
};
