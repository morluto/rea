import { Cli, z } from "incur";

import {
  captureProcessScenarioFile,
  projectCaptureFileFailure,
  projectProcessCliInputCleanupError,
} from "../application/process/ProcessCli.js";
import {
  compareParsedProcessEvidence,
  readProcessComparisonSource,
} from "../application/process/ProcessComparisonService.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/sessionToolContracts.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import type { CliInstance } from "./types.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Register direct process capture and comparison commands. */
export const registerProcessCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  cli.command(CLI_COMMANDS.captureProcess, {
    description: "Capture one caller-selected process scenario",
    args: z.object({
      scenario: localPathStringSchema.describe("Scenario JSON path"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "capture-process", () =>
          captureProcessScenarioFile(args.scenario, environment, signal).catch(
            projectProcessCliInputCleanupError,
          ),
        ),
      ),
  });
  registerContractCommand(
    cli as CliInstance,
    logger,
    contractNamed(SESSION_TOOL_CONTRACTS, "compare_process_captures"),
    {
      description: "Compare two process capture Evidence JSON files",
      positionals: ["left", "right", "trace_spec"],
      jsonInputs: {
        left: "left must be capture Evidence JSON or a JSON file path",
        right: "right must be capture Evidence JSON or a JSON file path",
        trace_spec: "traceSpec must be JSON or a JSON file path",
      },
      // Authenticate the left capture before the right one is read, and the
      // right one before the trace specification.
      jsonInputChecks: {
        left: (value) =>
          readProcessComparisonSource("left", value, projectCaptureFileFailure),
        right: (value) =>
          readProcessComparisonSource(
            "right",
            value,
            projectCaptureFileFailure,
          ),
      },
      fields: {
        left: { description: "Left capture Evidence JSON path" },
        right: { description: "Right capture Evidence JSON path" },
        trace_spec: {
          name: "traceSpec",
          description:
            "Optional partial-order or finite-trace specification path",
        },
        max_capture_age_ms: {
          description:
            "Refuse a capture completed more than this many milliseconds ago; omitted applies no age limit",
        },
      },
    },
    async (_input, { checked, parsed }) => {
      const result = compareParsedProcessEvidence(
        checked.left!,
        checked.right!,
        {
          ...(parsed?.max_capture_age_ms === undefined
            ? {}
            : { maxCaptureAgeMs: parsed.max_capture_age_ms }),
          ...(parsed?.trace_spec === undefined
            ? {}
            : { traceSpecification: parsed.trace_spec }),
        },
      );
      return result.ok
        ? result.value.evidence
        : projectAnalysisError(result.error);
    },
  );
};
