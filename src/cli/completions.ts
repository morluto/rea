import { z } from "zod";

import {
  CLI_BUILTIN_FLAGS,
  CLI_COMPLETION_SHELLS,
  cliCompletionShell,
  OUTPUT_SWITCHES,
  VALUED_OUTPUT_FLAGS,
  parseCliGlobalArguments,
  type CliGlobalArguments,
} from "../cliBuiltinArguments.js";
import { CLI_OUTPUT_FORMATS, readCliOutputArguments } from "../cliOutput.js";
import {
  completeWords,
  completionScript,
  formatCompletions,
  type CompletionCommand,
} from "./completionProtocol.js";
import { cliCommands } from "./commandRegistry.js";
import { COMPLETIONS_DESCRIPTION, MCP_GROUP_DESCRIPTION } from "./discovery.js";
import { MCP_SUBCOMMANDS } from "./mcpBuiltinCommands.js";
import type { CliInstance } from "./types.js";
import { MCP_DOCTOR_ALIAS, MCP_DOCTOR_OPTIONS } from "../mcpDoctorOptions.js";

type ServeOptions = NonNullable<Parameters<CliInstance["serve"]>[1]>;
const ROOT_FLAGS = new Set(["--mcp", "--update", "--version"]);

/** Supplement the completion setup page with Zsh initialization guidance. */
export const completionHelpNote = (
  global: CliGlobalArguments,
): string | undefined => {
  const words =
    global.command[0] === "rea" ? global.command.slice(1) : global.command;
  if (words[0] !== "completions") return undefined;
  const rest = words.slice(1);
  if (
    rest.length > 1 ||
    (rest.length === 1 &&
      !CLI_COMPLETION_SHELLS.includes(
        rest[0] as (typeof CLI_COMPLETION_SHELLS)[number],
      ))
  )
    return undefined;
  const values = new Set(global.outputValues.map(({ index }) => index));
  const flags = global.arguments.filter((_, index) => !values.has(index));
  if (
    flags.some((word) =>
      [
        "--schema",
        "--llms",
        "--llms-full",
        "--mcp",
        "--update",
        "--version",
      ].includes(word),
    )
  )
    return undefined;
  if (rest.length > 0 && !flags.includes("--help") && !flags.includes("-h"))
    return undefined;
  return "Zsh: initialize completion with `autoload -Uz compinit; compinit` before evaluating the zsh hook. If your shell already runs compinit, place the hook after it.\n";
};

const standardGlobals = (root: boolean): z.ZodObject =>
  z.object(
    Object.fromEntries([
      ...[...VALUED_OUTPUT_FLAGS].map(
        (flag) =>
          [
            flag.slice(2),
            flag === "--format"
              ? z.enum(CLI_OUTPUT_FORMATS).optional()
              : z.string().optional(),
          ] as const,
      ),
      ...[...CLI_BUILTIN_FLAGS]
        .filter(
          (flag) =>
            flag.startsWith("--") &&
            flag !== "--incur-update-check" &&
            (root || !ROOT_FLAGS.has(flag)),
        )
        .map((flag) => [flag.slice(2), z.boolean().optional()] as const),
      ...(root ? [["version", z.boolean().optional()] as const] : []),
    ]),
  );

/** Registered commands in registration order, then the builtin groups. */
const completionCommands = (
  cli: CliInstance,
): ReadonlyMap<string, CompletionCommand> => {
  const commands = new Map<string, CompletionCommand>(
    cliCommands(cli).map(({ name, definition }) => [
      name,
      {
        description: definition.description,
        options: definition.options,
        alias: definition.alias,
      },
    ]),
  );
  commands.set("mcp", {
    _group: true,
    description: MCP_GROUP_DESCRIPTION,
    commands: MCP_SUBCOMMANDS,
  });
  commands.set("completions", {
    _group: true,
    description: COMPLETIONS_DESCRIPTION,
    commands: new Map(CLI_COMPLETION_SHELLS.map((shell) => [shell, {}])),
  });
  return commands;
};

/**
 * One tree owns command scope; completionProtocol owns candidates and shell
 * encoding. `complete` answers the shell's completion protocol, whose words
 * are transport data; `writeScript` answers `completions <shell>`.
 */
export const createCliCompletions = (
  cli: CliInstance,
  environment: Readonly<NodeJS.ProcessEnv>,
): {
  complete(arguments_: readonly string[], options: ServeOptions): boolean;
  writeScript(global: CliGlobalArguments, options: ServeOptions): boolean;
} => {
  const script = (shell: (typeof CLI_COMPLETION_SHELLS)[number]) =>
    completionScript(shell, cli.name);
  const writer = (options: ServeOptions) =>
    options.stdout ?? ((text: string) => process.stdout.write(text));
  const complete = (
    arguments_: readonly string[],
    options: ServeOptions,
  ): boolean => {
    const shell = cliCompletionShell(environment);
    if (shell === undefined) return false;
    const write = writer(options);
    const separator = arguments_.indexOf("--");
    const words = separator < 0 ? arguments_ : arguments_.slice(separator + 1);
    if (words.length === 0) {
      write(script(shell));
      return true;
    }
    const index = Number(environment._COMPLETE_INDEX ?? words.length - 1);
    if (!Number.isSafeInteger(index) || index < 0 || index > words.length)
      return true;
    // Consume global option values before scope resolution. A value named
    // 'mcp' is still data; retain an unfinished flag for enum hints.
    const before = parseCliGlobalArguments(words.slice(1, index)).command;
    if (before.includes("--")) return true;
    const input = [cli.name, ...before, words[index] ?? ""];
    const doctor = before[0] === "mcp" && before[1] === "doctor";
    const candidates = completeWords(
      completionCommands(cli),
      input,
      input.length - 1,
      {
        schema: doctor
          ? // The launcher consumes this global before doctor parses options.
            MCP_DOCTOR_OPTIONS.extend({ timings: z.boolean().optional() })
          : standardGlobals(before.length === 0),
        alias: doctor ? MCP_DOCTOR_ALIAS : { help: "h" },
      },
    );
    const result = formatCompletions(shell, candidates);
    if (result !== "") write(result);
    return true;
  };
  const writeScript = (
    global: CliGlobalArguments,
    options: ServeOptions,
  ): boolean => {
    const { command } = global;
    const offset = command[0] === cli.name ? 1 : 0;
    const selected = CLI_COMPLETION_SHELLS.find(
      (value) => value === command[offset + 1],
    );
    if (
      command[offset] !== "completions" ||
      selected === undefined ||
      command.length !== offset + 2
    )
      return false;
    // Help, manifests and server controls precede a completion script.
    const values = new Set(global.outputValues.map(({ index }) => index));
    if (
      global.arguments.some(
        (token, index) =>
          !values.has(index) &&
          CLI_BUILTIN_FLAGS.has(token) &&
          token !== "--schema" &&
          !OUTPUT_SWITCHES.has(token),
      )
    )
      return false;
    if (!readCliOutputArguments(global).validation.ok) return false;
    writer(options)(`${script(selected)}\n`);
    return true;
  };
  return { complete, writeScript };
};
