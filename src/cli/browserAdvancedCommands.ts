import type { CliInstance } from "./types.js";
import type { Logger } from "pino";

import { browserCliError } from "./browserCliError.js";
import {
  browserTargetProjection,
  observeThroughBrowser,
} from "./browserContractCommands.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  admittedContractInput,
  registerContractCommand,
  type ContractCommandContext,
} from "./contractCommand.js";
import {
  commandRoute,
  contractInputBranch,
  registerRoutedCommand,
} from "./routedContractCommand.js";
import {
  captureWebScreenshot,
  compareParsedWebCaptureEvidence,
  compareWebScreenshotEvidence,
  discoverWebMcpTools,
} from "../application/BrowserObservationService.js";
import { CdpBrowserProvider } from "../browser/CdpBrowserProvider.js";
import { BROWSER_TOOL_CONTRACTS } from "../contracts/browserToolContracts.js";
import {
  isScenarioCaptureDocument,
  type BrowserCaptureComparisonRequest,
} from "../domain/browserCaptureComparison.js";

/** Register WebMCP, capture-diff, and screenshot CLI equivalents. */
export const registerAdvancedBrowserCommands = (
  cli: CliInstance,
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
      description:
        "Capture one visible page viewport within the supplied origin scope",
      ...browserTargetProjection,
    },
    observeThroughBrowser(screenshot, captureWebScreenshot),
  );
  registerScreenshotDiff(cli, logger);
};

const registerCaptureDiff = (cli: CliInstance, logger: Logger): void => {
  const contract = contractNamed(
    BROWSER_TOOL_CONTRACTS,
    "compare_web_captures",
  );
  const command = {
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
      compareCaptures,
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
      compareCaptures,
      { requirement: "passive page captures" },
    ),
  ]);
};

/**
 * Compare the captures one input shape admits. Admission parsed the decoded
 * captures with that shape, so the handler reuses its parse.
 */
const compareCaptures = async (
  _input: unknown,
  {
    operation,
    parsed,
  }: ContractCommandContext<
    Readonly<Record<string, unknown>>,
    BrowserCaptureComparisonRequest
  >,
): Promise<unknown> => {
  if (parsed === undefined)
    throw new Error(`${operation} admits its decoded captures`);
  const result = await compareParsedWebCaptureEvidence(
    new CdpBrowserProvider(),
    parsed,
  );
  return result.ok ? result.value : browserCliError(result.error);
};

const registerScreenshotDiff = (cli: CliInstance, logger: Logger): void => {
  const contract = contractNamed(
    BROWSER_TOOL_CONTRACTS,
    "compare_web_screenshots",
  );
  registerContractCommand(
    cli,
    logger,
    contract,
    {
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
    async (_input, context) => {
      const admitted = admittedContractInput(context);
      if (!admitted.ok) return browserCliError(admitted.error);
      const result = await compareWebScreenshotEvidence(
        new CdpBrowserProvider(),
        admitted.value,
      );
      return result.ok ? result.value : browserCliError(result.error);
    },
  );
};
