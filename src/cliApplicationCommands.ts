import { Cli, z } from "incur";

import {
  compareApplicationVersionsEvidence,
  traceApplicationFeatureEvidence,
} from "./application/JavaScriptApplicationWorkflowService.js";
import { runControlledReplay } from "./application/JavaScriptReplayService.js";
import {
  executeNodeCharacterization,
  prepareNodeCharacterization,
} from "./application/NodeRuntimeCharacterizationService.js";
import {
  commitReconstructionCoverage,
  queryReconstructionCoverage,
  reconstructionCoverageCommitInputSchema,
  reconstructionCoverageQueryInputSchema,
} from "./application/ReconstructionCoverageService.js";
import {
  authorizeFileReadWithDeferredWrite,
  authorizeRootPermission,
} from "./application/DeferredFileAuthorization.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { parseCliJsonInput } from "./cliJsonInput.js";
import { logCliCommand } from "./cliLogging.js";
import {
  AnalysisInputError,
  projectAnalysisError,
  type AnalysisError,
} from "./domain/errors.js";
import type { JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "./logger.js";
import { parseConfig } from "./config.js";
import { LinuxJavaScriptReplayRunner } from "./replay/LinuxJavaScriptReplayRunner.js";
import { SystemJavaScriptReplayHost } from "./replay/SystemJavaScriptReplayHost.js";
import type { AppConfig } from "./config.js";
import type { PermissionAuthority } from "./application/PermissionAuthority.js";

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
  registerAuthorizedJsonCommand(
    cli,
    logger,
    CLI_COMMANDS.prepareNodeCharacterization,
    "Prepare one exact Node/JavaScript characterization without execution",
    (config, authority, input) =>
      prepareNodeCharacterization(replayDependencies(config, authority), input),
  );
  registerAuthorizedJsonCommand(
    cli,
    logger,
    CLI_COMMANDS.executeNodeCharacterization,
    "Execute one separately approved exact Node/JavaScript characterization",
    (config, authority, input) =>
      executeNodeCharacterization(replayDependencies(config, authority), input),
  );
  registerCoverageCommands(cli, logger);
};

const registerAuthorizedJsonCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  name: string,
  description: string,
  workflow: (
    config: AppConfig,
    authority: PermissionAuthority,
    input: unknown,
  ) => Promise<
    | { readonly ok: true; readonly value: JsonValue }
    | { readonly ok: false; readonly error: AnalysisError }
  >,
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
        const configured = await configuredAuthority();
        if (!configured.ok) return configured.error;
        const result = await workflow(
          configured.config,
          configured.authority,
          input.value,
        );
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
  });
};

const registerCoverageCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  registerAuthorizedJsonCommand(
    cli,
    logger,
    CLI_COMMANDS.commitReconstructionCoverage,
    "Commit one canonical reconstruction coverage workspace revision",
    async (config, authority, input) => {
      const parsed = reconstructionCoverageCommitInputSchema.safeParse(input);
      if (!parsed.success)
        return {
          ok: false,
          error: new AnalysisInputError(
            CLI_COMMANDS.commitReconstructionCoverage,
            { cause: parsed.error },
          ),
        };
      const authorization = await authorizeFileReadWithDeferredWrite(
        authority,
        {
          path: parsed.data.workspace_path,
          readCapability: "investigation_workspace_read",
          writeCapability: "investigation_workspace_write",
          operation: CLI_COMMANDS.commitReconstructionCoverage,
        },
      );
      if (!authorization.ok) return authorization;
      const write = await authorization.value.authorizeWrite();
      if (!write.ok) return write;
      return commitReconstructionCoverage(
        parsed.data,
        config.evidenceFilePolicy,
      );
    },
  );
  registerAuthorizedJsonCommand(
    cli,
    logger,
    CLI_COMMANDS.queryReconstructionCoverage,
    "Evaluate one fail-closed reconstruction coverage boundary",
    async (config, authority, input) => {
      const parsed = reconstructionCoverageQueryInputSchema.safeParse(input);
      if (!parsed.success)
        return {
          ok: false,
          error: new AnalysisInputError(
            CLI_COMMANDS.queryReconstructionCoverage,
            { cause: parsed.error },
          ),
        };
      const authorized = await authorizeRootPermission(authority, {
        capability: "investigation_workspace_read",
        roots: [parsed.data.workspace_path],
        access: "read",
        operation: CLI_COMMANDS.queryReconstructionCoverage,
      });
      if (!authorized.ok) return authorized;
      return queryReconstructionCoverage(
        parsed.data,
        config.evidenceFilePolicy,
        Date.now(),
      );
    },
  );
};

const configuredAuthority = async (): Promise<
  | {
      readonly ok: true;
      readonly config: AppConfig;
      readonly authority: PermissionAuthority;
    }
  | {
      readonly ok: false;
      readonly error: ReturnType<typeof projectAnalysisError>;
    }
> => {
  const config = parseConfig(process.env);
  if (!config.ok)
    return { ok: false, error: projectAnalysisError(config.error) };
  const authority = await loadConfiguredPermissionAuthority(config.value);
  return authority.ok
    ? { ok: true, config: config.value, authority: authority.value }
    : { ok: false, error: projectAnalysisError(authority.error) };
};

const replayDependencies = (
  config: AppConfig,
  authority: PermissionAuthority,
) => ({
  policy: config.javascriptReplayPolicy,
  host: new SystemJavaScriptReplayHost(),
  runner: new LinuxJavaScriptReplayRunner(),
  authority,
});

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
