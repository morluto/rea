import { Cli, z } from "incur";

import {
  compareApplicationVersionsEvidenceValidated,
  compareJavaScriptExportShapesEvidenceValidated,
  traceApplicationFeatureEvidenceValidated,
} from "./application/JavaScriptApplicationWorkflowService.js";
import { traceJavaScriptSemanticsEvidenceValidated } from "./application/JavaScriptSemanticTraceService.js";
import {
  resolveCompareApplicationVersionsRequest,
  resolveCompareJavaScriptExportShapesRequest,
  resolveTraceApplicationFeatureRequest,
  resolveTraceJavaScriptSemanticsRequest,
} from "./application/ApplicationWorkflowEvidenceResolver.js";
import type { EvidenceLookup } from "./application/EvidenceReferenceResolver.js";
import { readEvidenceBundle } from "./application/EvidenceBundleFiles.js";
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

type CliInstance = ReturnType<typeof Cli.create>;

/** Register CLI equivalents of provider-neutral application graph workflows. */
export const registerApplicationCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.traceApplicationFeature,
    description:
      "Trace a typed seed through authenticated application Evidence JSON",
    resolveInput: resolveTraceApplicationFeatureRequest,
    workflow: traceApplicationFeatureEvidenceValidated,
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.traceJavaScriptSemantics,
    description:
      "Trace bounded static semantic relations through authenticated application Evidence",
    resolveInput: resolveTraceJavaScriptSemanticsRequest,
    workflow: traceJavaScriptSemanticsEvidenceValidated,
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.compareApplicationVersions,
    description:
      "Compare two authenticated JavaScript Application Graph versions",
    resolveInput: resolveCompareApplicationVersionsRequest,
    workflow: compareApplicationVersionsEvidenceValidated,
  });
  registerJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.compareJavaScriptExportShapes,
    description:
      "Compare exact static JavaScript export return shapes without execution",
    resolveInput: resolveCompareJavaScriptExportShapesRequest,
    workflow: compareJavaScriptExportShapesEvidenceValidated,
  });
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
  registerAuthorizedJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.prepareNodeCharacterization,
    description:
      "Prepare one exact Node/JavaScript characterization without execution",
    workflow: (config, authority, input) =>
      prepareNodeCharacterization(replayDependencies(config, authority), input),
  });
  registerAuthorizedJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.executeNodeCharacterization,
    description:
      "Execute one separately approved exact Node/JavaScript characterization",
    workflow: (config, authority, input) =>
      executeNodeCharacterization(replayDependencies(config, authority), input),
  });
  registerCoverageCommands(cli, logger);
};

interface AuthorizedJsonCommandOptions {
  readonly cli: CliInstance;
  readonly logger: Logger;
  readonly name: string;
  readonly description: string;
  readonly workflow: (
    config: AppConfig,
    authority: PermissionAuthority,
    input: unknown,
  ) => Promise<
    | { readonly ok: true; readonly value: JsonValue }
    | { readonly ok: false; readonly error: AnalysisError }
  >;
}

const registerAuthorizedJsonCommand = ({
  cli,
  logger,
  name,
  description,
  workflow,
}: AuthorizedJsonCommandOptions): void => {
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
  registerAuthorizedJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.commitReconstructionCoverage,
    description:
      "Commit one canonical reconstruction coverage workspace revision",
    workflow: async (config, authority, input) => {
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
  });
  registerAuthorizedJsonCommand({
    cli,
    logger,
    name: CLI_COMMANDS.queryReconstructionCoverage,
    description: "Evaluate one fail-closed reconstruction coverage boundary",
    workflow: async (config, authority, input) => {
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
  });
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
  const configured = await loadConfiguredAuthority();
  return configured.ok
    ? configured
    : { ok: false, error: projectAnalysisError(configured.error) };
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

interface JsonCommandOptions<Input> {
  readonly cli: CliInstance;
  readonly logger: Logger;
  readonly name: string;
  readonly description: string;
  readonly resolveInput: (
    input: unknown,
    lookup?: EvidenceLookup,
  ) =>
    | { readonly ok: true; readonly value: Input }
    | { readonly ok: false; readonly error: AnalysisError };
  readonly workflow: (
    input: Input,
  ) =>
    | { readonly ok: true; readonly value: JsonValue }
    | { readonly ok: false; readonly error: AnalysisError };
}

const registerJsonCommand = <Input>({
  cli,
  logger,
  name,
  description,
  resolveInput,
  workflow,
}: JsonCommandOptions<Input>): void => {
  cli.command(name, {
    description,
    args: z.object({
      inputJson: z.string().describe("Inline workflow JSON or JSON file path"),
    }),
    options: z.object({
      evidenceBundle: z
        .string()
        .optional()
        .describe("Authorized Evidence bundle used to resolve Evidence IDs"),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, name, async () => {
        const input = await parseCliJsonInput(args.inputJson, name);
        if (!input.ok) return input.error;
        const lookup = await loadEvidenceLookup(options.evidenceBundle, name);
        if (!lookup.ok)
          return {
            error: "Application workflow failed",
            ...projectAnalysisError(lookup.error),
          };
        const resolved = resolveInput(input.value, lookup.value);
        if (!resolved.ok)
          return {
            error: "Application workflow failed",
            ...projectAnalysisError(resolved.error),
          };
        const result = workflow(resolved.value);
        return result.ok
          ? result.value
          : {
              error: "Application workflow failed",
              ...projectAnalysisError(result.error),
            };
      }),
  });
};

const loadEvidenceLookup = async (
  bundlePath: string | undefined,
  operation: string,
): Promise<
  | { readonly ok: true; readonly value: EvidenceLookup | undefined }
  | { readonly ok: false; readonly error: AnalysisError }
> => {
  if (bundlePath === undefined) return { ok: true, value: undefined };
  const configured = await loadConfiguredAuthority();
  if (!configured.ok) return configured;
  const authorized = await authorizeRootPermission(configured.authority, {
    capability: "evidence_read",
    roots: [bundlePath],
    access: "read",
    operation,
  });
  if (!authorized.ok) return authorized;
  const loaded = await readEvidenceBundle(
    bundlePath,
    configured.config.evidenceFilePolicy,
  );
  if (!loaded.ok) return loaded;
  const records = new Map(
    loaded.value.records.map((record) => [record.evidence_id, record]),
  );
  return { ok: true, value: (evidenceId) => records.get(evidenceId) };
};

const loadConfiguredAuthority = async (): Promise<
  | {
      readonly ok: true;
      readonly config: AppConfig;
      readonly authority: PermissionAuthority;
    }
  | { readonly ok: false; readonly error: AnalysisError }
> => {
  const config = parseConfig(process.env);
  if (!config.ok) return config;
  const authority = await loadConfiguredPermissionAuthority(config.value);
  return authority.ok
    ? { ok: true, config: config.value, authority: authority.value }
    : authority;
};
