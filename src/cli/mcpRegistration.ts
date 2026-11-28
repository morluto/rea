import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { cliResultDestination } from "./cliDestination.js";

import { z } from "zod";

import {
  mcpClientRegistrationWritten,
  registerMcpClients,
  type McpClientRegistrationOutcome,
} from "../application/McpClientRegistration.js";
import {
  currentClientRegistrationCommand,
  defaultClientRegistrationBlocker,
} from "../application/ClientRegistrationIdentity.js";
import {
  resolveMcpRegistrationClients,
  type McpRegistrationClient,
} from "../application/McpRegistrationCatalog.js";
import { runningClientRewriteNotice } from "../application/SupportedClients.js";
import {
  ArtifactReaderFailure,
  ArtifactResourceScope,
} from "../resources/index.js";
import {
  classifyMcpAddDiscovery,
  declaredSensitiveValues,
  readMcpAddArguments,
  type CliGlobalArguments,
} from "../cliBuiltinArguments.js";
import {
  CLI_DOCUMENT_OUTPUT_FORMATS,
  readCliOutputArguments,
  renderCliDocument,
  renderCliOutputArgumentError,
  type CliOutputArgumentValidation,
} from "./cliOutput.js";
import { homeDirectoryFromEnvironment } from "../config/homeDirectory.js";
import {
  mcpRegistrationOptionsSchema,
  mcpRegistrationReportSchema,
  type McpRegistrationReport,
} from "../contracts/mcpRegistration.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  parseClientRegistrationCommand,
  type ClientRegistrationCommand,
} from "../domain/clientRegistrationCommand.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { redactExplicitText } from "../domain/explicitSensitiveValues.js";
import { err, ok, type Result } from "../domain/result.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { createCliResultOutput } from "./cliResultOutput.js";
import { isMcpRegistrationCommand } from "./mcpBuiltinCommands.js";
import { formatCommandHelp } from "./help.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";
import { ownCliProcessResource } from "./cliResources.js";

let retainedResources: ArtifactResourceScope | undefined;

/** Close the exact registration cleanup owners, retaining failures for retry. */
export const closeCliMcpRegistrationResources = async (): Promise<void> => {
  const resources = retainedResources;
  if (resources === undefined) return;
  await resources.close();
  if (retainedResources === resources) retainedResources = undefined;
};

ownCliProcessResource("mcp-registration", closeCliMcpRegistrationResources);

type ServeOptions = NonNullable<Parameters<CliInstance["serve"]>[1]>;
interface RegistrationRequest {
  readonly agents: readonly string[];
  readonly global: boolean;
  readonly launcher: ClientRegistrationCommand;
}
interface RegistrationInputIssue {
  readonly code: "invalid_value" | "unsupported_transport";
  readonly message: string;
  readonly field: string;
}
interface RegistrationPresentation {
  write(text: string): void;
  document(value: unknown, failure?: boolean): Promise<void>;
  validation(
    message: string,
    field: string,
    error?: AnalysisError,
    code?: RegistrationInputIssue["code"],
  ): Promise<void>;
  fail(): void;
}

/** Route only the named REA registration operation; other builtin commands keep their owners. */
export const serveMcpRegistration = (
  global: CliGlobalArguments,
  environment: Readonly<NodeJS.ProcessEnv>,
  options: ServeOptions,
): Promise<void> | undefined => {
  if (!isMcpRegistrationCommand(global)) return undefined;
  const offset = global.command[0] === PRODUCT_IDENTITY.cliBinary ? 1 : 0;
  return (async () => {
    const presentation = createRegistrationPresentation(global, options);
    if (
      presentation === undefined ||
      (await serveRegistrationDiscovery(global.flags, presentation))
    )
      return Promise.resolve();
    const request = readRegistrationRequest(
      global.command.slice(offset + 2),
      environment,
    );
    if (!request.ok) {
      await presentation.validation(
        request.error.message,
        request.error.field,
        undefined,
        request.error.code,
      );
      return Promise.resolve();
    }
    return withCommandCancellation((signal) =>
      executeRegistration(request.value, environment, signal, presentation),
    );
  })();
};

/** Bind one invocation's rendering, explicit redaction and exit behavior. */
const createRegistrationPresentation = (
  global: CliGlobalArguments,
  options: ServeOptions,
): RegistrationPresentation | undefined => {
  const write =
    options.stdout ?? ((text: string) => process.stdout.write(text));
  let exitRequested = false;
  const fail = () => {
    if (exitRequested) return;
    exitRequested = true;
    if (options.exit !== undefined) options.exit(1);
    else process.exitCode = 1;
  };
  const output = readCliOutputArguments(global);
  const validation: CliOutputArgumentValidation =
    output.validation.ok && (output.format === "csv" || output.format === "tsv")
      ? {
          ok: false,
          format: "json",
          code: "UNSUPPORTED_OUTPUT_COMBINATION",
          message:
            "MCP registration returns a complete document. Use --format json, yaml, md, toon, or jsonl; CSV/TSV requires a selected row collection.",
        }
      : output.validation;
  if (!validation.ok) {
    write(renderCliOutputArgumentError(validation));
    fail();
    return undefined;
  }
  const destination = cliResultDestination(options.stdout);
  const result = createCliResultOutput(output, destination);
  const document = async (value: unknown, failure = false) => {
    const handled = await result?.write(value, {
      command: "mcp add",
      duration: "0ms",
      failure,
    });
    if (!handled)
      write(
        renderCliDocument(value, output.format, process.stdout.isTTY === true),
      );
    if (result?.error !== undefined) fail();
  };
  return {
    write,
    document,
    fail,
    async validation(message, field, error, code = "invalid_value") {
      const retained = redactExplicitText(
        message,
        declaredSensitiveValues(global.command),
      );
      await document(
        {
          code: "VALIDATION_ERROR",
          message: retained,
          ...(error === undefined
            ? {}
            : { error: projectAnalysisError(error) }),
          fieldErrors: [
            {
              code,
              missing: false,
              path: field,
              message: retained,
            },
          ],
        },
        true,
      );
      fail();
    },
  };
};

/** Discovery never resolves configuration locations or acquires resource owners. */
const serveRegistrationDiscovery = async (
  flags: ReadonlySet<string>,
  presentation: RegistrationPresentation,
): Promise<boolean> => {
  if (flags.has("--help") || flags.has("-h")) {
    presentation.write(
      `${formatCommandHelp("rea mcp add", {
        description:
          "Register exact stdio launcher arguments in selected client settings, with backups and verified publication.",
        options: mcpRegistrationOptionsSchema,
        alias: { command: "c" },
        hint: "No package acquisition or server execution. --no-global never writes global settings.",
        globalOptions: { formats: CLI_DOCUMENT_OUTPUT_FORMATS },
      })}\n`,
    );
    return true;
  }
  const discovery = classifyMcpAddDiscovery(flags);
  if (discovery === "version") {
    presentation.write(`${PRODUCT_IDENTITY.packageVersion}\n`);
    return true;
  }
  if (discovery !== "schema") return false;
  await presentation.document({
    inputSchema: z.toJSONSchema(mcpRegistrationOptionsSchema),
    outputSchema: z.toJSONSchema(mcpRegistrationReportSchema),
  });
  return true;
};

const readRegistrationRequest = (
  arguments_: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
): Result<RegistrationRequest, RegistrationInputIssue> => {
  const request = readMcpAddArguments(arguments_);
  if (!request.validation.ok) {
    const issue = request.validation.error;
    return err({
      code: "invalid_value",
      message:
        issue.kind === "missing_value"
          ? `Missing value for flag: ${issue.flag}`
          : `Unexpected argument: ${issue.token}`,
      field: issue.kind === "missing_value" ? issue.field : "arguments",
    });
  }
  let command: string | readonly string[];
  if (request.commandText === undefined) {
    const { platform } = HOST_PLATFORM;
    command = currentClientRegistrationCommand({ platform, environment });
    const blocker = defaultClientRegistrationBlocker(
      command,
      platform,
      homeDirectoryFromEnvironment(environment, platform),
      environment,
    );
    if (blocker !== undefined)
      return err({ code: "invalid_value", field: "command", message: blocker });
  } else {
    command = request.commandText;
  }
  const launcher = parseClientRegistrationCommand(command);
  return launcher.ok
    ? ok({
        agents: request.agents,
        global: request.global,
        launcher: launcher.value,
      })
    : err({
        code:
          launcher.error.kind === "unsupported_transport"
            ? "unsupported_transport"
            : "invalid_value",
        message: launcher.error.message,
        field: "command",
      });
};

const executeRegistration = async (
  request: RegistrationRequest,
  environment: Readonly<NodeJS.ProcessEnv>,
  signal: AbortSignal,
  presentation: RegistrationPresentation,
): Promise<void> => {
  const resources = (retainedResources ??= new ArtifactResourceScope());
  const outcomes = await resources
    .run(async () => {
      const { platform } = HOST_PLATFORM;
      const targets = await resolveMcpRegistrationClients(
        {
          agents: request.agents,
          global: request.global,
          cwd: process.cwd(),
          home: homeDirectoryFromEnvironment(environment, platform),
          platform,
          environment,
          signal,
        },
        resources,
      );
      if (!targets.ok) {
        await presentation.validation(
          targets.error.message,
          "agent",
          targets.error,
        );
        return undefined;
      }
      return {
        targets: targets.value,
        outcomes: await registerMcpClients(
          targets.value,
          request.launcher,
          signal,
          resources,
          platform,
        ),
      };
    })
    .catch(async (cause: unknown) => {
      if (!(cause instanceof ArtifactReaderFailure)) throw cause;
      const error = new ConfigurationError(
        "Registration cannot continue until retained resource cleanup completes.",
        {
          cause,
          cleanup: ArtifactReaderFailure.cleanupObservation(
            cause,
            resources.cleanupResources,
          ),
        },
      );
      await presentation.validation(error.message, "registration", error);
      return undefined;
    });
  if (outcomes !== undefined)
    await presentRegistration(
      outcomes.outcomes,
      outcomes.targets,
      request.launcher,
      presentation,
    );
};

const clientReport = (
  outcome: McpClientRegistrationOutcome,
): McpRegistrationReport["clients"][number] => {
  const labels = {
    client: outcome.client,
    config_path: outcome.configPath,
    scope: outcome.scope,
  };
  if (outcome.status === "not_started")
    return { ...labels, status: "not_started" };
  if (!outcome.result.ok)
    return {
      ...labels,
      status: "failed",
      error: {
        ...projectAnalysisError(outcome.result.error),
        reason: outcome.result.error.message,
      },
    };
  const receipt = outcome.result.value;
  const permissions =
    receipt.permissions === undefined
      ? {}
      : { permissions: receipt.permissions };
  return receipt.status === "unchanged"
    ? { ...labels, ...permissions, status: "unchanged" }
    : {
        ...labels,
        ...permissions,
        status: "configured",
        ...(receipt.backupPath === undefined
          ? {}
          : { backup_path: receipt.backupPath }),
      };
};

const presentRegistration = async (
  outcomes: readonly McpClientRegistrationOutcome[],
  targets: readonly McpRegistrationClient[],
  launcher: ClientRegistrationCommand,
  presentation: RegistrationPresentation,
): Promise<void> => {
  const clients = outcomes.map(clientReport);
  const report: McpRegistrationReport = {
    name: "rea",
    command: launcher.command,
    args: [...launcher.args],
    ok: clients.every(
      (client) =>
        client.status === "configured" || client.status === "unchanged",
    ),
    clients,
  };
  await presentation.document(report, !report.ok);
  for (const outcome of outcomes) {
    if (outcome.status !== "completed") continue;
    const target = targets.find(
      ({ id, configPath }) =>
        id === outcome.client && configPath === outcome.configPath,
    );
    const name = target?.displayName ?? outcome.client;
    const { result } = outcome;
    if (result.ok && result.value.backupPath !== undefined)
      process.stderr.write(
        `${name} MCP registration backup retained at ${result.value.backupPath}\n`,
      );
    const notice =
      mcpClientRegistrationWritten(result) && target?.setupClient !== undefined
        ? runningClientRewriteNotice(target.setupClient)
        : undefined;
    if (notice !== undefined) process.stderr.write(`${notice}\n`);
  }
  if (!report.ok) presentation.fail();
};
