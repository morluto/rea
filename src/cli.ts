import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeAmpRegistrationBackup } from "./cli/ampRegistrationBackup.js";
import { snapshotEnvironment } from "./process/snapshotEnvironment.js";
import type { FridaInstrumentationPort } from "./application/frida/FridaInstrumentationPort.js";
import type { DirectAnalysis } from "./composition/directAnalysis.js";
import { Cli, z } from "incur";
import { redactExplicitText } from "./domain/explicitSensitiveValues.js";
import {
  adaptCliOutputArgumentsForIncur,
  classifyMcpAddDiscovery,
  expandMcpAddEqualsArguments,
  declaredSensitiveValues,
  readMcpAddArguments,
  normalizeCliArguments,
  splitIncurBuiltinArguments,
} from "./cliBuiltinArguments.js";
import {
  parseCliOutputArguments,
  renderCliDocument,
  renderCliOutputArgumentError,
} from "./cliOutput.js";

import { createLogger } from "./logger.js";
import { parseLogLevel } from "./config/processStart.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import { currentClientRegistrationCommand } from "./application/ClientRegistrationIdentity.js";
import { clientRegistrationCommandText } from "./cli/clientRegistrationCommandText.js";
import {
  CLI_COMMAND_GROUPS,
  type CliCommandGroup,
  type CliCommandGroupContext,
} from "./cli/commandGroups.js";
import { presentOmittableDefaults } from "./cli/omittableDefaults.js";
import type { CliInstance } from "./cli/types.js";
import {
  streamCliCommandResults,
  type CliResultOutput,
} from "./cli/cliResultOutput.js";
import { excludeDeclaredSensitiveArguments } from "./cli/explicitSensitiveArguments.js";
import { validateCliArguments } from "./cli/strictPositionals.js";
import {
  encodeCliArgumentErrors,
  presentCliArgumentErrors,
} from "./cli/argumentErrors.js";
import { completionHelpNote, createCliCompletions } from "./cli/completions.js";
import { reportUnknownMcpSubcommand } from "./cli/mcpBuiltinCommands.js";
import { closeCliGuidanceResources } from "./cli/cliGuidanceResources.js";
import { closeCliJavaScriptResources } from "./cli/cliJavaScriptResources.js";
import { RECORDED_CLI_COMMAND_GROUPS } from "./recordedCliCommandGroups.js";

/** Close every process-owned resource used by CLI commands. */
export const closeCliResources = async (): Promise<void> => {
  const results = await Promise.allSettled([
    closeCliJavaScriptResources(),
    closeCliGuidanceResources(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "CLI resource cleanup failed");
};

/**
 * The groups to load for one top-level command token. A token the build did
 * not record, including help, completions and Incur's built-in commands,
 * loads every group so routing, suggestions and root help stay complete.
 */
const selectedCommandGroups = (
  command: string | undefined,
): readonly CliCommandGroup[] => {
  if (command === undefined || RECORDED_CLI_COMMAND_GROUPS === undefined)
    return CLI_COMMAND_GROUPS;
  const id = Object.hasOwn(RECORDED_CLI_COMMAND_GROUPS, command)
    ? RECORDED_CLI_COMMAND_GROUPS[command]
    : undefined;
  const group = CLI_COMMAND_GROUPS.find((candidate) => candidate.id === id);
  return group === undefined ? CLI_COMMAND_GROUPS : [group];
};

/**
 * Build the one-shot Incur CLI without starting Hopper at import time.
 * Analysis commands acquire and close their own sessions; bare `mcp` and
 * `--mcp` are intercepted by the executable dispatcher before this module loads.
 * With `command`, only the group that registers that recorded top-level
 * command is imported; otherwise every group is.
 */
export const createCli = (
  selectedEnvironment: Readonly<
    Record<string, string | undefined>
  > = process.env,
  resultOutput?: CliResultOutput,
  fridaInstrumentation?: FridaInstrumentationPort,
  command?: string,
): Promise<CliInstance> =>
  assembleCli(
    selectedEnvironment,
    resultOutput,
    fridaInstrumentation,
    selectedCommandGroups(command),
  );

/** Top-level command and alias names each group registers, for the build recorder. */
export const recordCliCommandGroups = async (
  selectedEnvironment: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<Record<string, string>>> => {
  const recorded: Record<string, string> = {};
  for (const group of CLI_COMMAND_GROUPS) {
    const cli = await assembleCli(selectedEnvironment, undefined, undefined, [
      group,
    ]);
    const commands = Cli.toCommands.get(
      cli as unknown as Parameters<typeof Cli.toCommands.get>[0],
    );
    if (commands === undefined)
      throw new Error("Incur did not expose the registered REA CLI commands");
    for (const name of commands.keys()) {
      const owner = recorded[name];
      if (owner !== undefined)
        throw new Error(
          `CLI command ${name} is registered by both ${owner} and ${group.id}`,
        );
      recorded[name] = group.id;
    }
  }
  return recorded;
};

const assembleCli = async (
  selectedEnvironment: Readonly<Record<string, string | undefined>>,
  resultOutput: CliResultOutput | undefined,
  fridaInstrumentation: FridaInstrumentationPort | undefined,
  groups: readonly CliCommandGroup[],
): Promise<CliInstance> => {
  const environment = snapshotEnvironment(selectedEnvironment);
  // Groups that run analysis share one composition, created on first use.
  let analysis: Promise<DirectAnalysis> | undefined;
  const sharedAnalysis = (): Promise<DirectAnalysis> => {
    analysis ??= import("./composition/directAnalysis.js").then(
      ({ createDirectAnalysis }) => createDirectAnalysis(environment),
    );
    return analysis;
  };
  // The executable reports an invalid level before every command except doctor.
  // Doctor keeps going so its readiness report can name REA_LOG_LEVEL.
  const level =
    environment.REA_LOG_LEVEL === undefined
      ? undefined
      : parseLogLevel(environment.REA_LOG_LEVEL);
  const logger = createLogger(
    "cli",
    level?.ok === true ? level.value : "silent",
  );
  const timedCli = Cli.create(PRODUCT_IDENTITY.cliBinary, {
    version: PRODUCT_IDENTITY.packageVersion,
    description: "Reverse engineer anything from your terminal or agent.",
    globals: z.object({
      timings: z
        .boolean()
        .default(false)
        .describe("Write measured command timing to stderr."),
    }),
    mcp: {
      command: clientRegistrationCommandText(
        currentClientRegistrationCommand({ environment }),
      ),
      instructions:
        "Ask what software, artifact, protocol, or behavior the user wants to understand, then choose the available investigation capabilities that can produce evidence.",
    },
    sync: false,
    update: {
      // Incur's update:false only suppresses notices. Reject its explicit
      // installer so ambiguous flags cannot bypass REA's verified workflow.
      install: () => {
        throw new Error(
          "Use 'rea update' to update the identified installation. The '--update' alias accepts only global output flags.",
        );
      },
    },
  });

  timedCli.use(async (context, next) => {
    if (!context.globals.timings) return next();
    const started = performance.now();
    try {
      await next();
    } finally {
      // This interval covers CLI command dispatch, including result delivery.
      // It is not a provider-only or analysis-only measurement.
      process.stderr.write(
        `${JSON.stringify({ rea_timings: { version: 1, command_ms: Math.round(performance.now() - started) } })}\n`,
      );
    }
  });
  // Command registrars do not inspect global options; preserve their existing
  // type while Incur owns parsing and the middleware owns this added flag.
  const cli = timedCli as unknown as CliInstance;

  const context: CliCommandGroupContext = {
    cli,
    logger,
    environment,
    analysis: sharedAnalysis,
    fridaInstrumentation,
  };
  // Import selected groups concurrently, then register in catalog order.
  const registrations = await Promise.all(
    groups.map((group) => group.load(context)),
  );
  for (const register of registrations) register(context);
  presentOmittableDefaults(cli);
  if (resultOutput !== undefined) streamCliCommandResults(cli, resultOutput);
  const serveStrict = validateCliArguments(cli);
  presentCliArgumentErrors(cli);
  const serveDeclared = excludeDeclaredSensitiveArguments(cli);
  encodeCliArgumentErrors(cli);
  const serve = cli.serve.bind(cli);
  const complete = createCliCompletions(
    cli as unknown as Parameters<typeof createCliCompletions>[0],
    environment,
  );
  cli.serve = (arguments_ = process.argv.slice(2), options) => {
    if (complete(arguments_, options ?? {})) return Promise.resolve();
    let normalized = normalizeCliArguments(arguments_);
    const { command, flags } = splitIncurBuiltinArguments(normalized);
    const builtin = command[0] === PRODUCT_IDENTITY.cliBinary ? 1 : 0;
    const discovery = classifyMcpAddDiscovery(flags);
    if (
      command[builtin] === "mcp" &&
      command[builtin + 1] === "add" &&
      discovery !== "bypass"
    ) {
      const write =
        options?.stdout ?? ((text: string) => process.stdout.write(text));
      if (discovery === "version") {
        write(`${PRODUCT_IDENTITY.packageVersion}\n`);
        return Promise.resolve();
      }
      if (discovery === "schema") {
        const output = parseCliOutputArguments(normalized);
        if (!output.validation.ok)
          write(renderCliOutputArgumentError(output.validation));
        else if (output.format === "csv" || output.format === "tsv")
          write(
            renderCliOutputArgumentError({
              ok: false,
              format: "json",
              code: "UNSUPPORTED_OUTPUT_COMBINATION",
              message:
                "CSV/TSV output cannot represent the mcp add schema discovery error. Use a document format instead.",
            }),
          );
        else
          write(
            renderCliDocument(
              {
                code: "SCHEMA_UNAVAILABLE",
                message:
                  "Schema discovery is not supported for mcp add. Use 'rea mcp add --help' for its options.",
              },
              output.format,
              process.stdout.isTTY === true,
            ),
          );
        (
          options?.exit ??
          ((code: number) => {
            process.exitCode = code;
          })
        )(1);
        return Promise.resolve();
      }
      // Validate before reading settings, creating a backup or invoking Incur's
      // writer. The same owner supplies the agent selection used below.
      const parsedRegistration = readMcpAddArguments(
        command.slice(builtin + 2),
      );
      if (!parsedRegistration.validation.ok) {
        const failure = parsedRegistration.validation.error;
        const message = redactExplicitText(
          failure.kind === "missing_value"
            ? `Missing value for flag: ${failure.flag}`
            : `Unexpected argument: ${failure.token}`,
          declaredSensitiveValues(command),
        );
        const field =
          failure.kind === "missing_value" ? failure.field : "arguments";
        const output = parseCliOutputArguments(normalized);
        if (!output.validation.ok)
          write(renderCliOutputArgumentError(output.validation));
        else
          write(
            renderCliDocument(
              {
                code: "VALIDATION_ERROR",
                message,
                fieldErrors: [
                  {
                    code: "invalid_value",
                    missing: false,
                    path: field,
                    message,
                  },
                ],
              },
              output.format,
              process.stdout.isTTY === true,
            ),
          );
        (
          options?.exit ??
          ((code: number) => {
            process.exitCode = code;
          })
        )(1);
        return Promise.resolve();
      }
      // Incur's mcp add parser only understands spaced `--agent amp` forms; an
      // equals form like `--agent=amp` is silently ignored, which would drop
      // the requested agent and register against the default target. Normalize
      // equals forms back to spaced forms before handing over to Incur.
      // Shared with the project-scope guard through
      // `expandMcpAddEqualsArguments`, so both read the same agent selection.
      const serveArguments = expandMcpAddEqualsArguments(normalized);
      // Incur's Amp registration overwrites an existing rea entry (dropping its
      // environment map) and reports success even when the settings file
      // prevents a save. Guard that path: reject a settings file REA cannot
      // update, back up the file, preserve the caller's environment, and verify
      // the registration landed.
      // SyncMcp.register also writes Amp when no agents are selected. Mode
      // switches return before registration and must not touch its settings.
      // Use the same normalized arguments for selection and dispatch, including
      // non-Amp equals forms. Incur consumes command values before agent flags.
      normalized = serveArguments;
      const registration = splitIncurBuiltinArguments(serveArguments);
      const { agents } = parsedRegistration;
      const ampRequested =
        ![
          "--help",
          "-h",
          "--llms",
          "--llms-full",
          "--mcp",
          "--update",
          "--incur-update-check",
        ].some((flag) => registration.flags.has(flag)) &&
        (agents.length === 0 || agents.includes("amp"));
      if (ampRequested) {
        const settingsPath = join(homedir(), ".config", "amp", "settings.json");
        let priorEnv: unknown;
        let guardError: string | undefined;
        let settingsText: string | undefined;
        let parsedSettings: Record<string, unknown> | undefined;
        try {
          if (existsSync(settingsPath))
            settingsText = readFileSync(settingsPath, "utf8");
        } catch (cause) {
          guardError = `Unable to read Amp settings.json: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        }
        if (settingsText !== undefined) {
          try {
            const parsed: unknown = JSON.parse(settingsText);
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              Array.isArray(parsed)
            )
              guardError = "Amp settings.json must contain a JSON object.";
            else parsedSettings = parsed as Record<string, unknown>;
          } catch (cause) {
            guardError = `Amp settings.json is not valid JSON: ${
              cause instanceof Error ? cause.message : String(cause)
            }`;
          }
        }
        if (parsedSettings !== undefined && settingsText !== undefined) {
          const servers = parsedSettings["amp.mcpServers"];
          if (
            servers !== undefined &&
            (typeof servers !== "object" ||
              servers === null ||
              Array.isArray(servers))
          )
            guardError =
              "amp.mcpServers must be an object in Amp settings.json.";
          else {
            const entry =
              typeof servers === "object" && servers !== null
                ? (servers as Record<string, unknown>)["rea"]
                : undefined;
            if (typeof entry === "object" && entry !== null)
              priorEnv = (entry as Record<string, unknown>)["env"];
          }
        }
        const reportValidationError = (message: string): void => {
          const output = parseCliOutputArguments(normalized);
          if (!output.validation.ok)
            write(renderCliOutputArgumentError(output.validation));
          else
            write(
              renderCliDocument(
                {
                  code: "VALIDATION_ERROR",
                  message,
                  fieldErrors: [
                    {
                      code: "invalid_value",
                      missing: false,
                      path: "amp",
                      message,
                    },
                  ],
                },
                output.format,
                process.stdout.isTTY === true,
              ),
            );
          (
            options?.exit ??
            ((code: number) => {
              process.exitCode = code;
            })
          )(1);
        };
        if (guardError !== undefined) {
          reportValidationError(`${guardError} Fix it before registering.`);
          return Promise.resolve();
        }

        const runRegistration = (backupPath?: string): Promise<void> => {
          let failed = false;
          const result = serveStrict(
            serveArguments,
            {
              ...options,
              exit: (code) => {
                failed ||= code !== 0;
                if (options?.exit !== undefined) options.exit(code);
                else process.exitCode = code;
              },
            },
            (tokens, selected) =>
              serveDeclared(tokens, selected, (declared, declaredOptions) =>
                serve(
                  adaptCliOutputArgumentsForIncur(declared),
                  declaredOptions,
                ),
              ),
          );
          return result.then(() => {
            if (failed) return;
            let failure: string | undefined;
            try {
              if (!existsSync(settingsPath))
                failure = "Amp settings.json was not created.";
              else {
                const text = readFileSync(settingsPath, "utf8");
                const parsed = JSON.parse(text) as Record<string, unknown>;
                const servers = parsed["amp.mcpServers"];
                if (
                  typeof servers !== "object" ||
                  servers === null ||
                  Array.isArray(servers) ||
                  !("rea" in servers)
                )
                  failure =
                    "Amp settings.json does not contain the rea registration after mcp add.";
                else {
                  const entry = (servers as Record<string, unknown>)["rea"];
                  if (
                    priorEnv !== undefined &&
                    typeof entry === "object" &&
                    entry !== null &&
                    (entry as Record<string, unknown>)["env"] === undefined
                  ) {
                    (entry as Record<string, unknown>)["env"] = priorEnv;
                    writeFileSync(
                      settingsPath,
                      `${JSON.stringify(parsed, null, 2)}\n`,
                    );
                  }
                }
              }
            } catch (cause) {
              failure = cause instanceof Error ? cause.message : String(cause);
            }
            if (failure !== undefined) {
              const output = parseCliOutputArguments(normalized);
              if (output.validation.ok)
                write(
                  renderCliDocument(
                    {
                      code: "VALIDATION_ERROR",
                      message: failure,
                      fieldErrors: [
                        {
                          code: "invalid_value",
                          missing: false,
                          path: "amp",
                          message: failure,
                        },
                      ],
                    },
                    output.format,
                    process.stdout.isTTY === true,
                  ),
                );
              (
                options?.exit ??
                ((code: number) => {
                  process.exitCode = code;
                })
              )(1);
            } else if (backupPath !== undefined)
              process.stderr.write(
                `Amp MCP registration backup retained at ${backupPath}\n`,
              );
          });
        };

        if (settingsText === undefined) return runRegistration();
        return writeAmpRegistrationBackup(settingsPath, settingsText).then(
          (backup) => {
            if (!backup.ok) {
              const { kind, path, detail } = backup.error;
              reportValidationError(
                `Unable to create Amp settings backup (${kind}) at ${path}: ${detail}`,
              );
              return;
            }
            return runRegistration(backup.value);
          },
          (cause: unknown) => {
            const detail =
              cause instanceof Error ? cause.message : String(cause);
            reportValidationError(
              `Unable to create Amp settings backup: ${detail}`,
            );
          },
        );
      }
    }
    const result = serveStrict(normalized, options ?? {}, (tokens, selected) =>
      serveDeclared(tokens, selected, (declared, declaredOptions) =>
        reportUnknownMcpSubcommand(cli.name, declared, declaredOptions)
          ? Promise.resolve()
          : serve(adaptCliOutputArgumentsForIncur(declared), declaredOptions),
      ),
    );
    const note = completionHelpNote(normalized);
    if (note === undefined) return result;
    return result.then(() => {
      const write =
        options?.stdout ?? ((text: string) => process.stdout.write(text));
      write(`\n${note}`);
    });
  };
  return cli;
};
