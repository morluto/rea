import { HOST_PLATFORM } from "../platform/HostPlatform.js";

import type { FridaInstrumentationPort } from "../ports/frida/FridaInstrumentationPort.js";
import { currentClientRegistrationCommand } from "../application/ClientRegistrationIdentity.js";
import { parseCliGlobalArguments } from "../cliBuiltinArguments.js";
import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { parseLogLevel } from "../config/processStart.js";
import { parseClientRegistrationCommand } from "../domain/clientRegistrationCommand.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { createLogger } from "../logger.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import type {
  CliCommandRegistration,
  CliRegistrationContext,
} from "./cliCommandRegistration.js";
import type { CliResultOutput } from "./cliResultOutput.js";
import { runCliCommand } from "./runCliCommand.js";
import { completionHelpNote, createCliCompletions } from "./completions.js";
import { serveDiscovery } from "./discovery.js";
import { reportUnknownMcpSubcommand } from "./mcpBuiltinCommands.js";
import { serveMcpRegistration } from "./mcpRegistration.js";
import { presentOmittableDefaults } from "./omittableDefaults.js";
import type { CliInstance, CliServeOptions } from "./types.js";

/** A registrar and the module it was loaded from. */
export interface LoadedCliCommandRegistration {
  readonly registration: CliCommandRegistration;
  readonly module: unknown;
}

export interface CliShellOptions {
  readonly selectedEnvironment: Readonly<Record<string, string | undefined>>;
  readonly savedDefaults?: ReadonlySet<string> | undefined;
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
 * Build REA's CLI around the given registrars. Identity, global options,
 * argument policy, completions, and registration builtins are the same for
 * every set of registrars; they apply to whichever commands were registered.
 */
export const createCliShell = (options: CliShellOptions): CliInstance => {
  const environment = snapshotEnvironment(
    options.selectedEnvironment,
    HOST_PLATFORM.platform,
  );
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
  const cli: CliInstance = {
    name: PRODUCT_IDENTITY.cliBinary,
    serve,
  };

  registerCommands(
    {
      cli,
      logger,
      environment,
      savedDefaults: options.savedDefaults,
      fridaInstrumentation: options.fridaInstrumentation,
    },
    options,
  );

  presentOmittableDefaults(cli);
  const updateEnvironment = {
    variables: environment,
    platform: HOST_PLATFORM.platform,
  };
  const completions = createCliCompletions(cli, environment);
  function serve(
    arguments_: readonly string[] = process.argv.slice(2),
    serveOptions?: CliServeOptions,
  ): Promise<void> {
    if (completions.complete(arguments_, serveOptions ?? {}))
      return Promise.resolve();
    const global = parseCliGlobalArguments(arguments_);
    if (completions.writeScript(global, serveOptions ?? {}))
      return Promise.resolve();
    const registration = serveMcpRegistration(
      global,
      environment,
      defaultRegistration,
      serveOptions ?? {},
    );
    if (registration !== undefined) return registration;
    const result = reportUnknownMcpSubcommand(
      cli.name,
      global,
      serveOptions ?? {},
    )
      ? Promise.resolve()
      : (serveDiscovery(
          cli,
          global.arguments,
          serveOptions ?? {},
          updateEnvironment,
          global,
        ) ??
        runCliCommand(
          cli,
          global,
          serveOptions ?? {},
          updateEnvironment,
          options.resultOutput,
        ));
    const note = completionHelpNote(global);
    if (note === undefined) return result;
    return result.then(() => {
      const write =
        serveOptions?.stdout ?? ((text: string) => process.stdout.write(text));
      write(`\n${note}`);
    });
  }
  return cli;
};
