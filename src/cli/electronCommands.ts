import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";

import { Cli, z } from "incur";

import { electronActiveObservationInputSchema } from "../domain/javascript/electronActiveObservation.js";
import { ELECTRON_TOOL_CONTRACTS } from "../contracts/javascript/electronToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  inspectWithService,
  registerContractCommand,
  registerContractDocumentCommand,
  type ContractCommandContext,
} from "./contractCommand.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import type { CliInstance } from "./types.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { createElectronFuseService } from "../composition/electronFuses.js";
import { ELECTRON_FUSE_PROVIDER_IDENTITY } from "../electron/ElectronFuseProviderIdentity.js";

import {
  javaScriptApplicationCliProjection,
  runJavaScriptApplicationCommand,
} from "./javascriptApplicationAnalysis.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import type { ElectronActiveObservationPort } from "../application/javascript/ElectronActiveObservationPort.js";
import {
  evidenceBundleOption,
  runEvidenceInputCommand,
} from "./evidenceInputCommand.js";

/** Register CLI equivalents of the Electron MCP tools. */
export const registerElectronCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly createActiveProvider?: (
      environment: Readonly<Record<string, string | undefined>>,
    ) => ElectronActiveObservationPort;
  } = {},
): void => {
  registerElectronObservationCommands(cli, logger, environment);
  registerElectronFuseCommand(cli, logger);
  registerElectronActiveCommand(cli, logger, environment, options);
  registerJavaScriptApplicationCommand(cli, logger, environment);
  registerJavaScriptRuntimeReconciliationCommand(cli, logger);
};

const registerElectronFuseCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void =>
  registerContractCommand(
    cli,
    logger,
    contractNamed(ELECTRON_TOOL_CONTRACTS, "inspect_electron_fuses"),
    {
      command: CLI_COMMANDS.inspectElectronFuses,
      description:
        "Inspect packaged Electron fuse bytes without launching the application",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: {
          description:
            "Local Electron .app, Electron Framework binary, PE executable, or ELF executable",
        },
      },
    },
    inspectWithService(
      createElectronFuseService,
      ELECTRON_FUSE_PROVIDER_IDENTITY.id,
    ),
  );

const registerElectronActiveCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly createActiveProvider?: (
      environment: Readonly<Record<string, string | undefined>>,
    ) => ElectronActiveObservationPort;
  },
): void => {
  registerContractDocumentCommand(
    cli,
    logger,
    contractNamed(ELECTRON_TOOL_CONTRACTS, "capture_electron_scenario"),
    {
      command: CLI_COMMANDS.captureElectronScenario,
      description: "Run one owned Electron scenario with cancellable actions",
      document: "Inline JSON or a JSON file matching capture_electron_scenario",
      callerPaths: [
        ["executable_path"],
        ["application_path"],
        ["application_root"],
      ],
    },
    async (document, { signal, operation, spelled }) => {
      const parsed = electronActiveObservationInputSchema.safeParse(document);
      if (!parsed.success)
        return inputError(operation, parsed.error.issues, spelled);
      const { captureElectronScenario } =
        await import("../application/javascript/ElectronActiveObservationService.js");
      const provider =
        options.createActiveProvider === undefined
          ? await import("../composition/electronScenario.js").then(
              ({ createElectronScenarioProvider }) =>
                createElectronScenarioProvider(environment),
            )
          : options.createActiveProvider(environment);
      const result = await finishAnalysisCommand(
        () => captureElectronScenario(provider, parsed.data, { signal }),
        {
          close: async () => {
            await provider.close?.();
          },
        },
        provider.identity().id,
        operation,
        signal,
      );
      return result.ok
        ? result.value
        : { error: "Electron analysis failed", ...result.error };
    },
  );
};

const registerJavaScriptRuntimeReconciliationCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void =>
  registerContractDocumentCommand(
    cli,
    logger,
    contractNamed(ELECTRON_TOOL_CONTRACTS, "reconcile_javascript_runtime"),
    {
      command: CLI_COMMANDS.reconcileJavaScriptRuntime,
      description:
        "Reconcile static application and passive runtime Evidence JSON",
      document:
        "Inline JSON or a JSON file path matching reconcile_javascript_runtime",
      cliOptions: { evidenceBundle: evidenceBundleOption },
    },
    async (document, { signal, operation, cliOptions }) => {
      const { reconcileJavaScriptRuntimeEvidence } =
        await import("../application/javascript/JavaScriptRuntimeReconciliationService.js");
      const result = await runEvidenceInputCommand(
        operation,
        cliOptions.evidenceBundle,
        signal,
        async (lookup) => {
          const reconciled = reconcileJavaScriptRuntimeEvidence(
            document,
            lookup,
            { signal },
          );
          return reconciled.ok
            ? { ok: true, value: reconciled.value.evidence }
            : reconciled;
        },
      );
      return result.ok
        ? result.value
        : { error: "Application workflow failed", ...result.error };
    },
  );

const registerElectronObservationCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  registerElectronTargetList(cli, logger, environment);
  registerElectronPageInspection(cli, logger, environment);
};

const registerElectronTargetList = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const contract = contractNamed(
    ELECTRON_TOOL_CONTRACTS,
    "list_electron_targets",
  );
  registerContractCommand(
    cli as CliInstance,
    logger,
    contract,
    {
      command: CLI_COMMANDS.listElectronTargets,
      description:
        "List local file pages exposed by the selected Electron CDP endpoint",
      positionals: ["cdp_endpoint"],
      fields: { cdp_endpoint: electronEndpoint },
    },
    observeElectron(environment, contract, async (provider, input, signal) => {
      const { listElectronTargets } =
        await import("../application/javascript/ElectronObservationService.js");
      return listElectronTargets(provider, input, { signal });
    }),
  );
};

const registerElectronPageInspection = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const contract = contractNamed(
    ELECTRON_TOOL_CONTRACTS,
    "inspect_electron_page",
  );
  registerContractCommand(
    cli as CliInstance,
    logger,
    contract,
    {
      command: CLI_COMMANDS.inspectElectronPage,
      description: "Passively inspect one Electron file page",
      positionals: ["cdp_endpoint", "target_id"],
      fields: {
        cdp_endpoint: electronEndpoint,
        target_id: { description: "Target ID from list-electron-targets" },
        observation_ms: {
          description: "Observation duration in milliseconds",
        },
        include_script_sources: {
          description: "Include JavaScript source text",
        },
      },
    },
    observeElectron(environment, contract, async (provider, input, signal) => {
      const { inspectElectronPage } =
        await import("../application/javascript/ElectronObservationService.js");
      return inspectElectronPage(provider, input, { signal });
    }),
  );
};

const electronEndpoint = {
  name: "endpoint",
  description: "Literal-loopback Electron CDP endpoint",
};

/**
 * Admit the contract input, then observe through a disposable Electron
 * provider whose close the command awaits.
 */
const observeElectron =
  <Schema extends z.ZodType>(
    environment: Readonly<Record<string, string | undefined>>,
    contract: { readonly name: string; readonly inputSchema: Schema },
    run: (
      provider: Awaited<
        ReturnType<typeof createCliElectronObservationProvider>
      >,
      input: z.output<Schema>,
      signal: AbortSignal,
    ) => Promise<Result<Evidence, AnalysisError>>,
  ) =>
  async (input: unknown, { signal }: ContractCommandContext) => {
    const parsed = contract.inputSchema.safeParse(input);
    if (!parsed.success)
      return inputError(contract.name, parsed.error.issues, input);
    const provider = await createCliElectronObservationProvider(environment);
    return finishAnalysisCommand(
      () => run(provider, parsed.data, signal),
      {
        close: async () => {
          await provider.close?.();
        },
      },
      provider.identity().id,
      contract.name,
      signal,
    ).then(projectCliAnalysisResult);
  };

const registerJavaScriptApplicationCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  registerContractCommand(
    cli as CliInstance,
    logger,
    contractNamed(ELECTRON_TOOL_CONTRACTS, "analyze_javascript_application"),
    {
      command: CLI_COMMANDS.analyzeJavaScriptApplication,
      description:
        "Statically reconstruct a local JavaScript/Electron application",
      ...javaScriptApplicationCliProjection(
        "ASAR or extracted application path",
      ),
      evidenceDelivery: true,
      viewDelivery: { invalidJson: "view must be valid JSON" },
    },
    runJavaScriptApplicationCommand(environment),
  );
};

const createCliElectronObservationProvider = async (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const { createElectronObservationProvider } =
    await import("../composition/electronObservation.js");
  return createElectronObservationProvider(environment);
};

const inputError = (
  operation: string,
  issues?: Parameters<typeof projectInputIssues>[0],
  input?: unknown,
): JsonValue =>
  cliError(
    new AnalysisInputError(
      operation,
      undefined,
      issues === undefined ? [] : projectInputIssues(issues, input),
    ),
  );

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
  label = "Electron analysis failed",
): JsonValue => ({
  error: label,
  ...projectAnalysisError(error),
});
