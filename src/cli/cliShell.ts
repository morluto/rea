import { Cli, z } from "incur";

import type { FridaInstrumentationPort } from "../application/frida/FridaInstrumentationPort.js";
import { currentClientRegistrationCommand } from "../application/ClientRegistrationIdentity.js";
import {
  adaptCliOutputArgumentsForIncur,
  normalizeCliArguments,
} from "../cliBuiltinArguments.js";
import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { parseLogLevel } from "../config/processStart.js";
import { parseClientRegistrationCommand } from "../domain/clientRegistrationCommand.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { createLogger } from "../logger.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  encodeCliArgumentErrors,
  presentCliArgumentErrors,
} from "./argumentErrors.js";
import type {
  CliCommandRegistration,
  CliRegistrationContext,
} from "./cliCommandRegistration.js";
import {
  streamCliCommandResults,
  type CliResultOutput,
} from "./cliResultOutput.js";
import { completionHelpNote, createCliCompletions } from "./completions.js";
import { excludeDeclaredSensitiveArguments } from "./explicitSensitiveArguments.js";
import { reportUnknownMcpSubcommand } from "./mcpBuiltinCommands.js";
import { serveMcpRegistration } from "./mcpRegistration.js";
import { presentOmittableDefaults } from "./omittableDefaults.js";
import { validateCliArguments } from "./strictPositionals.js";
import type { CliInstance } from "./types.js";

/** A registrar and the module it was loaded from. */
export interface LoadedCliCommandRegistration {
  readonly registration: CliCommandRegistration;
  readonly module: unknown;
}

export interface CliShellOptions {
  readonly selectedEnvironment: Readonly<Record<string, string | undefined>>;
  /** Registrars to run, in registration order. */
  readonly registrations: readonly LoadedCliCommandRegistration[];
  /** Required when any registrar declares analysis. */
  readonly createAnalysis?: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => DirectAnalysis;
  readonly resultOutput?: CliResultOutput | undefined;
  readonly fridaInstrumentation?: FridaInstrumentationPort | undefined;
}

/** Run each registrar, creating analysis once for those that declare it. */
const registerCommands = (
  context: CliRegistrationContext,
  options: CliShellOptions,
): void => {
  let analysis: DirectAnalysis | undefined;
  for (const { registration, module } of options.registrations) {
    if (!registration.analysis) {
      registration.register(module, context);
      continue;
    }
    if (options.createAnalysis === undefined)
      throw new Error("A CLI registrar needs analysis that was not provided");
    analysis ??= options.createAnalysis(context.environment);
    registration.register(module, { ...context, analysis });
  }
};

/**
 * Build the Incur CLI around the given registrars. Identity, global options,
 * argument policy, completions, and registration builtins are the same for
 * every set of registrars; they apply to whichever commands were registered.
 */
export const createCliShell = (options: CliShellOptions): CliInstance => {
  const environment = snapshotEnvironment(options.selectedEnvironment);
  const defaultRegistration = parseClientRegistrationCommand(
    currentClientRegistrationCommand({ environment }),
  );
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

  registerCommands(
    {
      cli,
      logger,
      environment,
      fridaInstrumentation: options.fridaInstrumentation,
    },
    options,
  );

  presentOmittableDefaults(cli);
  if (options.resultOutput !== undefined)
    streamCliCommandResults(cli, options.resultOutput);
  const serveStrict = validateCliArguments(cli);
  presentCliArgumentErrors(cli);
  const serveDeclared = excludeDeclaredSensitiveArguments(cli);
  encodeCliArgumentErrors(cli);
  const serve = cli.serve.bind(cli);
  const complete = createCliCompletions(
    cli as unknown as Parameters<typeof createCliCompletions>[0],
    environment,
  );
  cli.serve = (arguments_ = process.argv.slice(2), serveOptions) => {
    if (complete(arguments_, serveOptions ?? {})) return Promise.resolve();
    const normalized = normalizeCliArguments(arguments_);
    const registration = serveMcpRegistration(
      normalized,
      environment,
      defaultRegistration,
      serveOptions ?? {},
    );
    if (registration !== undefined) return registration;
    const result = serveStrict(
      normalized,
      serveOptions ?? {},
      (tokens, selected) =>
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
        serveOptions?.stdout ?? ((text: string) => process.stdout.write(text));
      write(`\n${note}`);
    });
  };
  return cli;
};
