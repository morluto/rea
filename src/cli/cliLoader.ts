import type { CliGlobalArguments } from "../cliBuiltinArguments.js";
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
 * The registrars the command these arguments run needs, or undefined when the
 * complete CLI must answer, as it does for shell completion, which has no
 * global arguments. A standalone version or retired per-command MCP query
 * needs no registrar. Help, schemas, `--llms`, completions, other
 * CLI builtins, unknown names ("did you mean"), and a missing or unusable
 * recording all describe or search every command.
 */
const selectCliRegistrations = (
  global: CliGlobalArguments | undefined,
  recorded: Readonly<Record<string, string>> | undefined,
): readonly CliCommandRegistrationId[] | undefined => {
  if (global === undefined) return undefined;
  const { command, flags } = global;
  if (flags.has("--mcp") && command.length > 0) return [];
  if (command.length === 0 && flags.size === 1 && flags.has("--version"))
    return [];
  if (recorded === undefined) return undefined;
  for (const flag of flags)
    if (!COMMAND_OUTPUT_FLAGS.has(flag) && !flag.startsWith("--timings="))
      return undefined;
  const name = command[0];
  if (name === undefined || !Object.hasOwn(recorded, name)) return undefined;
  const id = recorded[name]!;
  return isRegistrationId(id) ? [id] : undefined;
};

/** The command runtime one invocation loaded, before its CLI is built. */
export interface CliRuntime {
  createCli(resultOutput: CliResultOutput | undefined): CliInstance;
  /** Closes the process-owned resources of this runtime's commands. */
  closeCliResources(): Promise<void>;
}

/**
 * Load the command runtime for one invocation. A recorded top-level command
 * loads only its registrar's module graph. A standalone version or retired
 * mode query loads none; anything else loads the complete CLI.
 */
export const loadCliRuntime = async (
  global: CliGlobalArguments | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<CliRuntime> => {
  const ids = selectCliRegistrations(
    global,
    RECORDED_CLI_COMMAND_REGISTRATIONS,
  );
  if (ids === undefined) {
    const { createCli, closeCliResources } = await import("../cli.js");
    return {
      createCli: (resultOutput) => createCli(environment, resultOutput),
      closeCliResources,
    };
  }
  const selected = ids.map((id) => CLI_COMMAND_REGISTRATIONS[id]);
  const [modules, { createCliShell }, { closeCliResources }, analysis] =
    await Promise.all([
      Promise.all(selected.map((registration) => registration.load())),
      import("./cliShell.js"),
      import("./cliResources.js"),
      selected.some((registration) => registration.analysis)
        ? import("../composition/directAnalysis.js")
        : undefined,
    ]);
  return {
    createCli: (resultOutput) =>
      createCliShell({
        selectedEnvironment: environment,
        resultOutput,
        registrations: selected.map((registration, index) => ({
          registration,
          module: modules[index],
        })),
        ...(analysis === undefined
          ? {}
          : { createAnalysis: analysis.createDirectAnalysis }),
      }),
    closeCliResources,
  };
};
