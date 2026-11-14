import { Writable } from "node:stream";

import { Help, z } from "incur";

import {
  registerMcpClients,
  type McpClientRegistrationOutcome,
} from "../application/McpClientRegistration.js";
import { resolveMcpRegistrationClients } from "../application/McpRegistrationCatalog.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  classifyMcpAddDiscovery,
  declaredSensitiveValues,
  readMcpAddArguments,
  splitIncurBuiltinArguments,
} from "../cliBuiltinArguments.js";
import {
  parseCliOutputArguments,
  renderCliDocument,
  renderCliOutputArgumentError,
  type CliOutputArgumentValidation,
} from "../cliOutput.js";
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
  type ClientRegistrationCommandIssue,
} from "../domain/clientRegistrationCommand.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { redactExplicitText } from "../domain/explicitSensitiveValues.js";
import { err, ok, type Result } from "../domain/result.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { createCliResultOutput } from "./cliResultOutput.js";
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

const precedingFlags = [
  "--llms",
  "--llms-full",
  "--mcp",
  "--update",
  "--incur-update-check",
];

/** Route only the named REA registration operation; other Incur commands remain theirs. */
export const serveMcpRegistration = (
  arguments_: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  defaultCommand: Result<
    ClientRegistrationCommand,
    ClientRegistrationCommandIssue
  >,
  options: ServeOptions,
): Promise<void> | undefined => {
  const split = splitIncurBuiltinArguments(arguments_);
  const offset = split.command[0] === PRODUCT_IDENTITY.cliBinary ? 1 : 0;
  if (
    split.command[offset] !== "mcp" ||
    split.command[offset + 1] !== "add" ||
    precedingFlags.some((flag) => split.flags.has(flag))
  )
    return undefined;
  return (async () => {
    const presentation = createRegistrationPresentation(
      arguments_,
      split.command,
      options,
    );
    if (
      presentation === undefined ||
      (await serveRegistrationDiscovery(split.flags, presentation))
    )
      return Promise.resolve();
    const request = readRegistrationRequest(
      split.command.slice(offset + 2),
      defaultCommand,
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
  arguments_: readonly string[],
  command: readonly string[],
  options: ServeOptions,
): RegistrationPresentation | undefined => {
  const write =
    options.stdout ?? ((text: string) => process.stdout.write(text));
  const fail = () => {
    if (options.exit !== undefined) options.exit(1);
    else process.exitCode = 1;
  };
  const output = parseCliOutputArguments(arguments_);
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
  const destination =
    options.stdout === undefined
      ? process.stdout
      : new Writable({
          write(chunk: Buffer, _encoding, callback) {
            try {
              write(chunk.toString());
              callback();
            } catch (error) {
              callback(
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          },
        });
  const result = createCliResultOutput(output, destination);
  const document = async (value: unknown, failure = false) => {
    const handled = await result?.write(value, {
      command: "mcp add",
      duration: "0ms",
      format: output.format,
      forceOutput: true,
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
        declaredSensitiveValues(command),
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
      `${Help.formatCommand("rea mcp add", {
        description:
          "Register exact stdio launcher arguments in selected client settings, with backups and verified publication.",
        options: mcpRegistrationOptionsSchema,
        alias: { command: "c" },
        hint: "No package acquisition or server execution. --no-global never writes global settings.",
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
  defaultCommand: Result<
    ClientRegistrationCommand,
    ClientRegistrationCommandIssue
  >,
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
  const launcher =
    request.commandText === undefined
      ? defaultCommand
      : parseClientRegistrationCommand(request.commandText);
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
      const targets = await resolveMcpRegistrationClients(
        {
          agents: request.agents,
          global: request.global,
          cwd: process.cwd(),
          home: homeDirectoryFromEnvironment(environment, process.platform),
          platform: process.platform,
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
      return registerMcpClients(
        targets.value,
        request.launcher,
        signal,
        resources,
      );
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
    await presentRegistration(outcomes, request.launcher, presentation);
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
  for (const outcome of outcomes)
    if (
      outcome.status === "completed" &&
      outcome.result.ok &&
      outcome.result.value.backupPath !== undefined
    )
      process.stderr.write(
        `${outcome.client === "amp" ? "Amp" : outcome.client} MCP registration backup retained at ${outcome.result.value.backupPath}\n`,
      );
  if (!report.ok) presentation.fail();
};
