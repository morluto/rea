import type { Cli, z } from "incur";
import type { Logger } from "pino";

import { browserCliError } from "./browserCliError.js";
import {
  browserTargetProjection,
  observeThroughBrowser,
} from "./browserContractCommands.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  commandRoute,
  contractInputBranch,
  registerContractCommand,
  registerRoutedCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";
import {
  captureWebScreenshot,
  compareWebCaptureEvidence,
  compareWebScreenshotEvidence,
  discoverWebMcpTools,
} from "../application/BrowserObservationService.js";
import { CdpBrowserProvider } from "../browser/CdpBrowserProvider.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { BROWSER_TOOL_CONTRACTS } from "../contracts/browserToolContracts.js";
import {
  isScenarioCaptureDocument,
  type BrowserCaptureComparisonInput,
} from "../domain/browserCaptureComparison.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";

/** Register WebMCP, capture-diff, and screenshot CLI equivalents. */
export const registerAdvancedBrowserCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  const discoverWebMcp = contractNamed(
    BROWSER_TOOL_CONTRACTS,
    "discover_webmcp_tools",
  );
  registerContractCommand(
    cli,
    logger,
    discoverWebMcp,
    {
      command: CLI_COMMANDS.discoverWebMcpTools,
      description: "Passively discover page-declared WebMCP tools",
      ...browserTargetProjection,
      fields: {
        ...browserTargetProjection.fields,
        observation_ms: {
          description: "Observation duration in milliseconds",
        },
      },
    },
    observeThroughBrowser(discoverWebMcp, discoverWebMcpTools),
  );
  registerCaptureDiff(cli, logger);
  const screenshot = contractNamed(
    BROWSER_TOOL_CONTRACTS,
    "capture_web_screenshot",
  );
  registerContractCommand(
    cli,
    logger,
    screenshot,
    {
      command: CLI_COMMANDS.captureWebScreenshot,
      description:
        "Capture one visible page viewport within the supplied origin scope",
      ...browserTargetProjection,
    },
    observeThroughBrowser(screenshot, captureWebScreenshot),
  );
  registerScreenshotDiff(cli, logger);
};

const registerCaptureDiff = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  const contract = contractNamed(
    BROWSER_TOOL_CONTRACTS,
    "compare_web_captures",
  );
  const command = {
    command: CLI_COMMANDS.compareWebCaptures,
    description:
      "Compare two normalized passive captures or recorded browser scenarios",
  };
  // Scenario captures embed screenshots that can exceed the host's
  // command-line length limit, so each side may be a JSON file.
  const beforeJson = "beforeJson must be inline JSON or a JSON file path";
  const afterJson = "afterJson must be inline JSON or a JSON file path";
  const before = {
    name: "beforeJson",
    description: "Earlier normalized web capture JSON or JSON file path",
  };
  const after = {
    name: "afterJson",
    description: "Later normalized web capture JSON or JSON file path",
  };
  const scenarios = contractInputBranch(contract, "before_scenario");
  const passive = contractInputBranch(contract, "before");
  registerRoutedCommand(cli as unknown as CliInstance, logger, command, [
    commandRoute(
      scenarios,
      {
        ...command,
        positionals: ["before_scenario", "after_scenario"],
        jsonInputs: {
          before_scenario: beforeJson,
          after_scenario: afterJson,
          normalization:
            "normalizationJson must be inline JSON or a JSON file path",
        },
        fields: {
          before_scenario: before,
          after_scenario: after,
          normalization: {
            name: "normalizationJson",
            description:
              "Recorded literal normalization policy JSON or JSON file path for browser scenarios",
          },
        },
      },
      compareCaptures(scenarios),
      {
        takes: async (values) =>
          isScenarioCaptureDocument(values.beforeJson) ||
          isScenarioCaptureDocument(values.afterJson),
        requirement: "recorded browser scenario captures",
      },
    ),
    commandRoute(
      passive,
      {
        ...command,
        positionals: ["before", "after"],
        jsonInputs: { before: beforeJson, after: afterJson },
        fields: { before, after },
      },
      compareCaptures(passive),
      { requirement: "passive page captures" },
    ),
  ]);
};

/** Compare the captures that one input shape of the contract admits. */
const compareCaptures =
  (branch: { readonly name: string; readonly inputSchema: z.ZodType }) =>
  async (input: unknown): Promise<unknown> => {
    const parsed = branch.inputSchema.safeParse(input);
    if (!parsed.success)
      return browserCliError(
        analysisInputErrorFromIssues(branch.name, parsed.error.issues, input, {
          cause: parsed.error,
        }),
      );
    const result = await compareWebCaptureEvidence(
      new CdpBrowserProvider(),
      parsed.data as BrowserCaptureComparisonInput,
    );
    return result.ok ? result.value : browserCliError(result.error);
  };

const registerScreenshotDiff = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  const contract = contractNamed(
    BROWSER_TOOL_CONTRACTS,
    "compare_web_screenshots",
  );
  registerContractCommand(
    cli,
    logger,
    contract,
    {
      command: CLI_COMMANDS.compareWebScreenshots,
      description: "Compare two self-verifying PNG artifact JSON values",
      positionals: ["before", "after"],
      // Screenshot artifacts embed PNG bytes that can exceed the host's
      // command-line length limit, so each may be a JSON file.
      jsonInputs: {
        before: "beforeJson must be inline JSON or a JSON file path",
        after: "afterJson must be inline JSON or a JSON file path",
      },
      fields: {
        before: {
          name: "beforeJson",
          description: "Earlier screenshot artifact JSON or JSON file path",
        },
        after: {
          name: "afterJson",
          description: "Later screenshot artifact JSON or JSON file path",
        },
        channel_threshold: {
          description: "Per-channel difference threshold for changed pixels",
        },
      },
    },
    async (input) => {
      const parsed = contract.inputSchema.safeParse(input);
      if (!parsed.success)
        return browserCliError(
          analysisInputErrorFromIssues(
            contract.name,
            parsed.error.issues,
            input,
            { cause: parsed.error },
          ),
        );
      const result = await compareWebScreenshotEvidence(
        new CdpBrowserProvider(),
        parsed.data,
      );
      return result.ok ? result.value : browserCliError(result.error);
    },
  );
};
