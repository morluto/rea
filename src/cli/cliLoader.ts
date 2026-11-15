import {
  cliCompletionShell,
  splitIncurBuiltinArguments,
} from "../cliBuiltinArguments.js";
import { RECORDED_CLI_COMMAND_REGISTRATIONS } from "../recordedCliCommandRegistrations.js";
import {
  CLI_COMMAND_REGISTRATIONS,
  type CliCommandRegistrationId,
} from "./cliCommandRegistrations.js";
import type { CliResultOutput } from "./cliResultOutput.js";
import type { CliInstance } from "./types.js";

/** Global switches that change only how a command's result is written. */
const COMMAND_OUTPUT_FLAGS: ReadonlySet<string> = new Set([
  "--json",
  "--full-output",
  "--token-count",
  "--timings",
  "--no-timings",
]);

const isRegistrationId = (id: string): id is CliCommandRegistrationId =>
  Object.hasOwn(CLI_COMMAND_REGISTRATIONS, id);

/**
 * The registrar that defines the command these arguments run, or undefined
 * when the complete CLI must answer. Help, schemas, `--llms`, completions,
 * Incur builtins, unknown names ("did you mean"), and a missing or unusable
 * recording all describe or search every command.
 */
export const selectCliRegistration = (
  arguments_: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  recorded: Readonly<Record<string, string>> | undefined,
): CliCommandRegistrationId | undefined => {
  if (recorded === undefined || cliCompletionShell(environment) !== undefined)
    return undefined;
  const { command, flags } = splitIncurBuiltinArguments(arguments_);
  for (const flag of flags)
    if (!COMMAND_OUTPUT_FLAGS.has(flag) && !flag.startsWith("--timings="))
      return undefined;
  const name = command[0];
  if (name === undefined || !Object.hasOwn(recorded, name)) return undefined;
  const id = recorded[name]!;
  return isRegistrationId(id) ? id : undefined;
};

/** The command runtime one invocation loaded, before its CLI is built. */
export interface CliRuntime {
  createCli(resultOutput: CliResultOutput | undefined): CliInstance;
  /** Closes the process-owned resources of this runtime's commands. */
  closeCliResources(): Promise<void>;
}

/**
 * Load the command runtime for one invocation. A recorded top-level command
 * loads only its registrar's module graph; anything else loads the complete
 * CLI.
 */
export const loadCliRuntime = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CliRuntime> => {
  const id = selectCliRegistration(
    arguments_,
    environment,
    RECORDED_CLI_COMMAND_REGISTRATIONS,
  );
  if (id === undefined) {
    const { createCli, closeCliResources } = await import("../cli.js");
    return {
      createCli: (resultOutput) => createCli(environment, resultOutput),
      closeCliResources,
    };
  }
  const registration = CLI_COMMAND_REGISTRATIONS[id];
  const [module, { createCliShell }, { closeCliResources }, analysis] =
    await Promise.all([
      registration.load(),
      import("./cliShell.js"),
      import("./cliResources.js"),
      registration.analysis
        ? import("../composition/directAnalysis.js")
        : undefined,
    ]);
  return {
    createCli: (resultOutput) =>
      createCliShell({
        selectedEnvironment: environment,
        resultOutput,
        registrations: [{ registration, module }],
        ...(analysis === undefined
          ? {}
          : { createAnalysis: analysis.createDirectAnalysis }),
      }),
    closeCliResources,
  };
};
