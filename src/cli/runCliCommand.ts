import {
  AGENT_RESULT_BUDGET_ENVIRONMENT,
  CLI_RETAINED_EVIDENCE_ENVIRONMENT,
  cliRetainedEvidenceBytes,
} from "../domain/agentResultBudget.js";
import {
  cliRetainedEvidenceDirectory,
  NO_RETAIN_FLAG,
  type CliEvidenceRetention,
} from "./cliEvidenceRetention.js";
import { Writable } from "node:stream";

import {
  declaredSensitiveValues,
  type CliGlobalArguments,
} from "../cliBuiltinArguments.js";
import {
  readCliOutputArguments,
  renderCliOutputArgumentError,
} from "./cliOutput.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { errorMessage } from "../kernel/errorMessage.js";
import {
  cliArgumentFailure,
  redactCliCommandFailure,
  renderCliCommandFailure,
  type CliCommandFailure,
} from "./argumentErrors.js";
import { parseCliArgv } from "./argvParser.js";
import { cliCommand, cliCommands } from "./commandRegistry.js";
import {
  withCliEvidencePublication,
  type CliPublicationInvocation,
} from "./cliEvidencePublication.js";
import { rebindLoggedCliFailure } from "../cliLogging.js";
import { RECORDED_CLI_COMMAND_REGISTRATIONS } from "../recordedCliCommandRegistrations.js";
import { projectCliCommandOutput } from "./projectCliAnalysisResult.js";
import {
  cliResultControls,
  withCliResultControls,
} from "./cliResultControls.js";
import {
  createCliResultOutput,
  type CliResultOutput,
} from "./cliResultOutput.js";
import {
  availableUpdate,
  updateNoticeCta,
  type UpdateEnvironment,
} from "./updateNotice.js";
import type { CliInstance, CliServeOptions } from "./types.js";

const writer = (options: CliServeOptions) =>
  options.stdout ??
  ((text: string) => {
    process.stdout.write(text);
  });
const exit = (options: CliServeOptions, code: number) => {
  if (options.exit !== undefined) options.exit(code);
  else process.exitCode = code;
};

/** A callback owns captured output; otherwise the process owns stdout directly. */
const destinationFor = (options: CliServeOptions): Writable => {
  if (options.stdout === undefined) return process.stdout;
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      try {
        options.stdout!(chunk.toString("utf8"));
        done();
      } catch (cause) {
        done(cause instanceof Error ? cause : new Error(String(cause)));
      }
    },
  });
  Object.defineProperty(destination, "isTTY", {
    value: process.stdout.isTTY === true,
  });
  return destination;
};

/**
 * Where this invocation keeps an over-budget result it was not told to save:
 * the private cache, unless --no-retain or a 0 setting turns that off, or the
 * environment names no home to put it under.
 */
const invocationRetention = (
  global: CliGlobalArguments,
  environment: UpdateEnvironment,
): CliEvidenceRetention | undefined => {
  if (global.flags.has(NO_RETAIN_FLAG)) return undefined;
  const capBytes = cliRetainedEvidenceBytes(
    environment.variables[CLI_RETAINED_EVIDENCE_ENVIRONMENT],
  );
  if (capBytes === 0) return undefined;
  try {
    return {
      directory: cliRetainedEvidenceDirectory(
        environment.variables,
        environment.platform,
      ),
      capBytes,
    };
  } catch {
    return undefined;
  }
};

/** What this invocation's delivery reads from its argv and environment. */
const publicationInvocation = (
  global: CliGlobalArguments,
  environment: UpdateEnvironment,
  controls: ReturnType<typeof readCliOutputArguments>,
): CliPublicationInvocation => ({
  agentBudgetSeed: environment.variables[AGENT_RESULT_BUDGET_ENVIRONMENT],
  hasFilterOutput: controls.filterOutput !== undefined,
  retention: invocationRetention(global, environment),
});

/** Bind, admit and run one registered command, retaining output/publication ownership. */
export const runCliCommand = async (
  cli: CliInstance,
  global: CliGlobalArguments,
  options: CliServeOptions,
  environment: UpdateEnvironment,
  providedOutput: CliResultOutput | undefined,
): Promise<void> => {
  const controls = readCliOutputArguments(global);
  if (!controls.validation.ok) {
    writer(options)(renderCliOutputArgumentError(controls.validation));
    exit(options, 1);
    return;
  }
  const entry = cliCommand(cli, global.command[0] ?? "");
  if (entry === undefined) {
    writer(options)(
      "Start REA's MCP server with 'rea mcp' through the public executable.\n",
    );
    exit(options, 1);
    return;
  }
  const output =
    providedOutput ?? createCliResultOutput(controls, destinationFor(options));
  if (output === undefined)
    throw new Error("Admitted CLI output has no output owner");
  output.begin(controls);
  const started = performance.now();
  const human = process.stdout.isTTY === true && !controls.formatExplicit;
  const update = human
    ? availableUpdate(cli.name, PRODUCT_IDENTITY.packageVersion, environment)
    : undefined;
  const cta =
    update === undefined ? undefined : updateNoticeCta(cli.name, update);
  const sensitive =
    entry.definition.options?.shape.sensitiveValue === undefined
      ? []
      : declaredSensitiveValues(global.command);
  const report = (failure: CliCommandFailure) => {
    writer(options)(
      renderCliCommandFailure(redactCliCommandFailure(failure, sensitive), {
        cli: cli.name,
        entry,
        duration: `${Math.round(performance.now() - started)}ms`,
        stdoutIsTerminal: process.stdout.isTTY === true,
        controls,
        cta,
      }),
    );
    exit(options, 1);
  };
  try {
    const parsed = parseCliArgv(global.command.slice(1), entry.definition);
    if (!parsed.ok) {
      report(cliArgumentFailure(cli.name, entry.name, parsed.error));
      return;
    }
    await withCliEvidencePublication(
      () =>
        withCliResultControls(async () => {
          const rawValue = await entry.definition.run({
            ...parsed.value,
            formatExplicit: controls.formatExplicit,
          });
          const value = projectCliCommandOutput(rawValue, {
            operations: entry.operations,
            commands: cliCommands(cli),
            cliName: cli.name,
            recordedCommands: RECORDED_CLI_COMMAND_REGISTRATIONS,
          });
          rebindLoggedCliFailure(rawValue, value);
          if (!output.handled)
            await output.write(value, {
              command: entry.name,
              duration: `${Math.round(performance.now() - started)}ms`,
              renderOutput:
                !human || entry.definition.outputPolicy !== "agent-only",
              collectCliControls: cliResultControls,
              cta,
            });
        }),
      publicationInvocation(global, environment, controls),
    );
    if (output.error !== undefined) exit(options, 1);
  } catch (cause: unknown) {
    // A started or failed destination retains ownership; never write a second
    // diagnostic into a partial document or replace a publication receipt.
    if (output.handled) throw cause;
    report({
      code: "UNKNOWN",
      message: errorMessage(cause),
    });
  } finally {
    if (providedOutput === undefined) await output.finish();
    if (global.timings)
      process.stderr.write(
        `${JSON.stringify({ rea_timings: { version: 1, command_ms: Math.round(performance.now() - started) } })}\n`,
      );
  }
};
