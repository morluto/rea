import { z } from "zod";

import type { CliGlobalArguments } from "../cliBuiltinArguments.js";
import {
  CLI_DOCUMENT_OUTPUT_FORMATS,
  CLI_OUTPUT_FORMATS,
} from "../cliOutput.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { cliCommands } from "./commandRegistry.js";
import {
  formatCommandHelp,
  formatCommandListHelp,
  type HelpCommandRow,
} from "./help.js";
import { MCP_SUBCOMMANDS } from "./mcpBuiltinCommands.js";
import type { CliInstance } from "./types.js";

/** The root page's description of REA. */
export const CLI_DESCRIPTION =
  "Reverse engineer anything from your terminal or agent.";

/** Global options REA defines beyond the standard output controls. */
export const CLI_CUSTOM_GLOBAL_OPTIONS = z.object({
  timings: z
    .boolean()
    .default(false)
    .describe("Write measured command timing to stderr."),
});

export const MCP_GROUP_DESCRIPTION = "Register as MCP server";
export const COMPLETIONS_DESCRIPTION = "Generate shell completion script";

/** Shells in the order the completions page lists them. */
const HELP_SHELLS = ["bash", "fish", "nushell", "zsh"] as const;

const completionsHint = (name: string): string => {
  const rows = [
    ["bash", `eval "$(${name} completions bash)"`, "# add to ~/.bashrc"],
    [
      "fish",
      `${name} completions fish | source`,
      "# add to ~/.config/fish/config.fish",
    ],
    ["nushell", `see \`${name} completions nushell\``, "# add to config.nu"],
    ["zsh", `eval "$(${name} completions zsh)"`, "# add to ~/.zshrc"],
  ] as const;
  const shellWidth = Math.max(...rows.map(([shell]) => shell.length));
  const commandWidth = Math.max(...rows.map(([, command]) => command.length));
  return `Setup:\n${rows
    .map(
      ([shell, command, comment]) =>
        `  ${shell.padEnd(shellWidth)}  ${command.padEnd(commandWidth)}  ${comment}`,
    )
    .join("\n")}`;
};

/** The global options block of a page for a command that renders results. */
const commandGlobalOptions = {
  formats: CLI_OUTPUT_FORMATS,
  custom: CLI_CUSTOM_GLOBAL_OPTIONS,
};

const rootPage = (cli: CliInstance): string =>
  formatCommandListHelp(cli.name, {
    version: PRODUCT_IDENTITY.packageVersion,
    description: CLI_DESCRIPTION,
    commands: cliCommands(cli)
      .map(({ name, definition }): HelpCommandRow => ({
        name,
        description: definition.description,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    globalOptions: {
      ...commandGlobalOptions,
      root: {
        integrations: [
          { name: "completions", description: COMPLETIONS_DESCRIPTION },
          {
            name: "mcp",
            description: `${MCP_GROUP_DESCRIPTION} (${[...MCP_SUBCOMMANDS.keys()].join(", ")})`,
          },
        ],
      },
    },
  });

/** The position of an integration command: first, or after the CLI's own name. */
const integrationIndex = (
  command: readonly string[],
  name: string,
  integration: string,
): number =>
  command[0] === integration
    ? 0
    : command[0] === name && command[1] === integration
      ? 1
      : -1;

/**
 * The help page an invocation asks for, or undefined when it asks for
 * something else. Precedence: the update check, `--update` without help,
 * `--mcp` and the LLM manifests answer first; then the integrations
 * (`completions` shows its page for help or without a shell, `mcp` shows its
 * page without a subcommand); then `--version` without help; then the root
 * page for no command; then a command's page for help. Help after an unknown
 * command shows the root page.
 */
const helpPage = (
  cli: CliInstance,
  { command, flags }: CliGlobalArguments,
): string | undefined => {
  const help = flags.has("--help") || flags.has("-h");
  if (
    flags.has("--incur-update-check") ||
    (flags.has("--update") && !help) ||
    flags.has("--mcp") ||
    flags.has("--llms") ||
    flags.has("--llms-full")
  )
    return undefined;
  const completions = integrationIndex(command, cli.name, "completions");
  if (completions >= 0)
    return help || command[completions + 1] === undefined
      ? formatCommandHelp(`${cli.name} completions`, {
          description: COMPLETIONS_DESCRIPTION,
          args: z.object({
            shell: z
              .enum(HELP_SHELLS)
              .describe("Shell to generate completions for"),
          }),
          hint: completionsHint(cli.name),
        })
      : undefined;
  const mcp = integrationIndex(command, cli.name, "mcp");
  if (mcp >= 0) {
    const subcommand = command[mcp + 1];
    if (subcommand === undefined)
      return formatCommandListHelp(`${cli.name} mcp`, {
        description: MCP_GROUP_DESCRIPTION,
        commands: [...MCP_SUBCOMMANDS].map(([name, { description }]) => ({
          name,
          description,
        })),
        globalOptions: { formats: CLI_DOCUMENT_OUTPUT_FORMATS },
      });
    // `mcp add` renders its own page; an unknown subcommand is an error.
    return help && subcommand === "doctor"
      ? formatCommandHelp(`${cli.name} mcp doctor`, {
          description: MCP_SUBCOMMANDS.get("doctor")!.description,
        })
      : undefined;
  }
  if (flags.has("--version") && !help) return undefined;
  if (command.length === 0) return rootPage(cli);
  if (!help) return undefined;
  const entry = cliCommands(cli).find(({ name }) => name === command[0]);
  if (entry === undefined) return rootPage(cli);
  const { definition } = entry;
  return formatCommandHelp(`${cli.name} ${entry.name}`, {
    description: definition.description,
    args: definition.args,
    options: definition.options,
    alias: definition.alias,
    globalOptions: commandGlobalOptions,
  });
};

/** Write the help page this invocation asks for; false when it asks for something else. */
export const writeHelpPage = (
  cli: CliInstance,
  global: CliGlobalArguments,
  write: (text: string) => void,
): boolean => {
  const page = helpPage(cli, global);
  if (page === undefined) return false;
  write(`${page}\n`);
  return true;
};
