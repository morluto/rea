import { Cli, z } from "incur";

import {
  compareApplicationVersionsEvidence,
  traceApplicationFeatureEvidence,
} from "./application/JavaScriptApplicationWorkflowService.js";
import { runControlledReplay } from "./application/JavaScriptReplayService.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { parseCliJsonInput } from "./cliJsonInput.js";
import { logCliCommand } from "./cliLogging.js";
import { AnalysisInputError, projectAnalysisError } from "./domain/errors.js";
import type { JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "./logger.js";
import { parseConfig } from "./config.js";
import { LinuxJavaScriptReplayRunner } from "./replay/LinuxJavaScriptReplayRunner.js";
import { SystemJavaScriptReplayHost } from "./replay/SystemJavaScriptReplayHost.js";

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
  cli.command(CLI_COMMANDS.runControlledReplay, {
    description:
      "Plan or execute an approved extracted-module replay in the Linux sandbox",
    args: z.object({
      inputJson: z.string().describe("Inline replay JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, CLI_COMMANDS.runControlledReplay, async () => {
        const input = await parseCliJsonInput(
          args.inputJson,
          CLI_COMMANDS.runControlledReplay,
        );
        if (!input.ok) return input.error;
        const config = parseConfig(process.env);
        if (!config.ok) return projectAnalysisError(config.error);
        const authority = await loadConfiguredPermissionAuthority(config.value);
        if (!authority.ok) return projectAnalysisError(authority.error);
        const result = await runControlledReplay(
          {
            policy: config.value.javascriptReplayPolicy,
            host: new SystemJavaScriptReplayHost(),
            runner: new LinuxJavaScriptReplayRunner(),
            authority: authority.value,
          },
          input.value,
        );
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
  });
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
