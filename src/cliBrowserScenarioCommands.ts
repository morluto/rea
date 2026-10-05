import { Cli } from "incur";
import { z } from "zod";

import { captureBrowserScenario } from "./application/BrowserScenarioCaptureService.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { PlaywrightBrowserScenarioProvider } from "./browser/PlaywrightBrowserScenarioProvider.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { parseCliJsonInput } from "./cliJsonInput.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig } from "./config.js";
import { AnalysisInputError, projectAnalysisError } from "./domain/errors.js";
import { browserScenarioSchema } from "./domain/browserScenario.js";
import type { JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "./logger.js";

const OPERATION = "capture_browser_scenario";

/** Register the one-shot controlled browser scenario command. */
export const registerBrowserScenarioCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void => {
  cli.command(CLI_COMMANDS.captureBrowserScenario, {
    description:
      "Run one approved, bounded Playwright browser scenario and return Evidence",
    args: z.object({
      inputJson: z
        .string()
        .describe("Inline browser scenario JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, CLI_COMMANDS.captureBrowserScenario, async () => {
        const input = await parseCliJsonInput(args.inputJson, OPERATION);
        if (!input.ok) return input.error;
        const scenario = browserScenarioSchema.safeParse(input.value);
        if (!scenario.success)
          return cliError(new AnalysisInputError(OPERATION));
        const config = parseConfig(environment);
        if (!config.ok) return cliError(config.error);
        const authority = await loadConfiguredPermissionAuthority(config.value);
        if (!authority.ok) return cliError(authority.error);
        const result = await captureBrowserScenario(
          new PlaywrightBrowserScenarioProvider(),
          authority.value,
          scenario.data,
        );
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "Browser scenario capture failed",
  ...projectAnalysisError(error),
});
