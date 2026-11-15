import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";

import { isAbsolute, resolve, sep } from "node:path";

import { Cli, z } from "incur";
import { nulFreeStringSchema } from "../domain/localPath.js";

import { logCliCommand } from "../cliLogging.js";
import {
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "../domain/javascript/electronObservation.js";
import { electronActiveObservationInputSchema } from "../domain/javascript/electronActiveObservation.js";
import { ELECTRON_TOOL_CONTRACTS } from "../contracts/javascript/electronToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  registerContractCommand,
  registerContractDocumentCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Logger } from "pino";
import { cliDomainInput } from "./domainInput.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { createElectronFuseService } from "../composition/electronFuses.js";
import {
  electronPageInspectionOptions,
  selectedCommandTimeout,
} from "../cliObservationOptions.js";
import {
  javaScriptApplicationCliProjection,
  runJavaScriptApplicationCommand,
} from "./javascriptApplicationAnalysis.js";
import { withCommandCancellation } from "./commandCancellation.js";
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
): void => {
  cli.command(CLI_COMMANDS.inspectElectronFuses, {
    description:
      "Inspect packaged Electron fuse bytes without launching the application",
    args: z.object({
      path: nulFreeStringSchema.describe(
        "Local Electron .app, Electron Framework binary, PE executable, or ELF executable",
      ),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectElectronFuses, async () => {
          const service = createElectronFuseService();
          return finishAnalysisCommand(
            () =>
              service.inspect(
                { path: absoluteElectronFusePath(args.path) },
                { signal },
              ),
            service,
            service.provider.identity.id,
            "inspect_electron_fuses",
            signal,
          ).then(projectCliAnalysisResult);
        }),
      ),
  });
};

/** Anchor relative input without changing which file symlink/.. selects. */
const absoluteElectronFusePath = (path: string): string => {
  if (path === "") return path;
  // Win32 resolves dot components before directory links, including drive-relative paths.
  if (sep === "\\") return resolve(path);
  if (isAbsolute(path)) return path;
  const base = process.cwd();
  return `${base}${base.endsWith(sep) ? "" : sep}${path}`;
};

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
  cli.command(CLI_COMMANDS.listElectronTargets, {
    description:
      "List local file pages exposed by the selected Electron CDP endpoint",
    args: z.object({
      endpoint: cliDomainInput(
        listElectronTargetsInputSchema.shape.cdp_endpoint,
      ).describe("Literal-loopback Electron CDP endpoint"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "list-electron-targets", async () => {
          const provider =
            await createCliElectronObservationProvider(environment);
          const input = {
            cdp_endpoint: args.endpoint,
          };
          const parsed = listElectronTargetsInputSchema.safeParse(input);
          if (!parsed.success)
            return inputError(
              "list_electron_targets",
              parsed.error.issues,
              input,
            );
          const { listElectronTargets } =
            await import("../application/javascript/ElectronObservationService.js");
          return await finishAnalysisCommand(
            () => listElectronTargets(provider, parsed.data, { signal }),
            {
              close: async () => {
                await provider.close?.();
              },
            },
            provider.identity().id,
            "list_electron_targets",
            signal,
          ).then(projectCliAnalysisResult);
        }),
      ),
  });
};

const registerElectronPageInspection = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  cli.command(CLI_COMMANDS.inspectElectronPage, {
    description: "Passively inspect one Electron file page",
    args: z.object({
      endpoint: cliDomainInput(
        listElectronTargetsInputSchema.shape.cdp_endpoint,
      ).describe("Literal-loopback Electron CDP endpoint"),
      targetId: z
        .string()
        .min(1)
        .describe("Target ID from list-electron-targets"),
    }),
    options: electronPageInspectionOptions,
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "inspect-electron-page", async () => {
          const provider =
            await createCliElectronObservationProvider(environment);
          const input = {
            cdp_endpoint: args.endpoint,
            target_id: args.targetId,
            observation_ms: options.observationMs,
            include_script_sources: options.includeScriptSources,
            ...selectedCommandTimeout(options.commandTimeoutMs),
          };
          const parsed = inspectElectronPageInputSchema.safeParse(input);
          if (!parsed.success)
            return inputError(
              "inspect_electron_page",
              parsed.error.issues,
              input,
            );
          const { inspectElectronPage } =
            await import("../application/javascript/ElectronObservationService.js");
          return await finishAnalysisCommand(
            () => inspectElectronPage(provider, parsed.data, { signal }),
            {
              close: async () => {
                await provider.close?.();
              },
            },
            provider.identity().id,
            "inspect_electron_page",
            signal,
          ).then(projectCliAnalysisResult);
        }),
      ),
  });
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
