import type { Logger } from "pino";

import { captureBrowserScenario } from "./application/BrowserScenarioCaptureService.js";
import type { BrowserScenarioCapturePort } from "./ports/BrowserScenarioCapturePort.js";
import { publishCliAnalysisEvidence } from "./cli/analysisEvidenceDelivery.js";
import { contractNamed } from "./cli/contractCliDescription.js";
import { registerContractDocumentCommand } from "./cli/contractCommand.js";
import { finishAnalysisCommand } from "./cli/finishAnalysisCommand.js";
import type { CliInstance } from "./cli/types.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { BROWSER_SCENARIO_TOOL_CONTRACTS } from "./contracts/browserScenarioToolContracts.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";
import {
  browserScenarioSchema,
  type BrowserScenario,
} from "./domain/browserScenario.js";
import { analysisInputErrorFromIssues } from "./domain/inputIssueProjection.js";
import type { JsonValue } from "./domain/jsonValue.js";
import { err, ok, type Result } from "./domain/result.js";

const contract = contractNamed(
  BROWSER_SCENARIO_TOOL_CONTRACTS,
  "capture_browser_scenario",
);
const PROVIDER_ID = "rea-playwright-browser-scenario";
const document =
  "Inline browser scenario JSON, JSON file path, or '-' for stdin";
const callerPaths = [["browser", "executable_path"]] as const;

/** Register controlled browser execution and offline validation commands. */
export const registerBrowserScenarioCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly createProvider?: (
      environment: Readonly<Record<string, string | undefined>>,
    ) => BrowserScenarioCapturePort;
  } = {},
): void => {
  registerContractDocumentCommand(
    cli,
    logger,
    contract,
    {
      description:
        "Run one bounded Playwright browser scenario and return Evidence",
      document,
      callerPaths,
      evidenceDelivery: true,
    },
    async (input, { signal, operation, delivery, spelled }) => {
      if (delivery === undefined)
        throw new Error(`${operation} declares evidenceDelivery`);
      const scenario = parseBrowserScenario(
        input,
        spelled,
        "Browser scenario capture failed",
      );
      if (!scenario.ok) return scenario.error;
      // Load Playwright only for this command, not during CLI startup.
      const provider =
        options.createProvider === undefined
          ? await import("./composition/browserScenario.js").then(
              ({ createBrowserScenarioProvider }) =>
                createBrowserScenarioProvider(environment),
            )
          : options.createProvider(environment);
      const result = await finishAnalysisCommand(
        () => captureBrowserScenario(provider, scenario.value, { signal }),
        {
          close: async () => {
            await provider?.close?.();
          },
        },
        PROVIDER_ID,
        operation,
        signal,
        undefined,
        { failureProjection: "initial" },
      );
      if (!result.ok)
        return { error: "Browser scenario capture failed", ...result.error };
      return publishCliAnalysisEvidence(result, {
        operation,
        signal,
        detail: delivery.detail,
        evidenceOutput: delivery.evidenceOutput,
      });
    },
  );
  // Validation admits the capture document without provider or environment
  // access.
  registerContractDocumentCommand(
    cli,
    logger,
    contract,
    {
      command: CLI_COMMANDS.validateBrowserScenario,
      description:
        "Validate one browser scenario without launching or attaching to a browser",
      document,
      callerPaths,
      omit: {
        detail:
          "validation runs no browser and delivers no Evidence; pass --detail to capture-browser-scenario",
      },
    },
    async (input, { spelled }) => {
      const scenario = parseBrowserScenario(
        input,
        spelled,
        "Browser scenario validation failed",
      );
      if (!scenario.ok) return scenario.error;
      return {
        valid: true,
        actions: scenario.value.actions.length,
        secrets: scenario.value.secrets.length,
      };
    },
  );
};

/**
 * Both commands report the canonical scenario parser's field diagnostics,
 * citing the document as the caller spelled it.
 */
const parseBrowserScenario = (
  input: unknown,
  spelled: unknown,
  headline: string,
): Result<BrowserScenario, JsonValue> => {
  const scenario = browserScenarioSchema.safeParse(input);
  return scenario.success
    ? ok(scenario.data)
    : err({
        error: headline,
        ...projectAnalysisError(
          analysisInputErrorFromIssues(
            contract.name,
            scenario.error.issues,
            spelled,
            { cause: scenario.error },
          ),
        ),
      });
};
