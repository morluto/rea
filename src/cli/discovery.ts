import { z } from "zod";

import {
  CLI_COMPLETION_SHELLS,
  declaredSensitiveValues,
  parseCliGlobalArguments,
  type CliGlobalArguments,
} from "../cliBuiltinArguments.js";
import { redactExplicitText } from "../domain/explicitSensitiveValues.js";
import {
  CLI_DOCUMENT_OUTPUT_FORMATS,
  CLI_OUTPUT_FORMATS,
  readCliOutputArguments,
  renderCliDocument,
  renderCliOutputArgumentError,
  type CliOutputFormat,
} from "./cliOutput.js";
import { formatCliOutput } from "./cliOutputFormatter.js";
import { estimateTokenCount } from "tokenx";
import { jsonLinesErrorRecord } from "./jsonLines.js";
import { sliceTextByTokenWindow } from "./tokenWindow.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import {
  commandSchemaDocument,
  formatLlmsFull,
  formatLlmsIndex,
  llmsFullManifest,
  llmsIndexManifest,
} from "./commandManifests.js";
import { cliCommands, type CliCommandEntry } from "./commandRegistry.js";
import { suggestCommand } from "./commandSuggestion.js";
import { unknownCommandReply } from "./unknownCommandReply.js";
import { renderFailure } from "./outputEnvelope.js";
import {
  availableUpdate,
  refreshUpdateCache,
  UPDATE_CHECK_FLAG,
  updateNoticeCta,
  type UpdateEnvironment,
} from "./updateNotice.js";
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

/** REA's verified update command is the only CLI installation workflow. */
export const CLI_UPDATE_REFUSAL = {
  code: "UPDATE_FAILED",
  message:
    "Use 'rea update' to update the identified installation. The '--update' alias accepts only global output flags.",
} as const;

/** Shells in the order the completions page lists them. */
const HELP_SHELLS = [...CLI_COMPLETION_SHELLS].sort();

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

/** A document REA writes instead of running a command, and the status it ends with. */
type DiscoveryAnswer =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly exitCode: number;
    }
  | {
      readonly kind: "rendered";
      readonly text: string;
      readonly exitCode: number;
    }
  | { readonly kind: "markup"; readonly text: string; readonly exitCode: 0 }
  | {
      readonly kind: "document";
      readonly value: unknown;
      readonly format: CliOutputFormat;
      readonly tokens: boolean;
      readonly exitCode: number;
    };

const answer = (text: string, exitCode = 0): DiscoveryAnswer => ({
  kind: "text",
  text: text.endsWith("\n") ? text : `${text}\n`,
  exitCode,
});
const renderedAnswer = (text: string, exitCode = 0): DiscoveryAnswer => ({
  kind: "rendered",
  text,
  exitCode,
});
const markupAnswer = (text: string): DiscoveryAnswer => ({
  kind: "markup",
  text,
  exitCode: 0,
});
const documentAnswer = (
  value: unknown,
  format: CliOutputFormat,
  tokens = true,
  exitCode = 0,
): DiscoveryAnswer => ({ kind: "document", value, format, tokens, exitCode });

const presentDiscoveryAnswer = (
  result: DiscoveryAnswer,
  global: CliGlobalArguments,
): string => {
  if (result.kind === "rendered") return result.text;
  const controls = readCliOutputArguments(global);
  if (result.kind === "text")
    return result.exitCode !== 0 && controls.format === "jsonl"
      ? renderCliDocument(jsonLinesErrorRecord(result.text), "jsonl", false)
      : result.text;
  let encoded: string;
  if (result.kind === "markup") encoded = result.text;
  else {
    const value =
      result.format === "jsonl" && result.exitCode !== 0
        ? jsonLinesErrorRecord(result.value)
        : result.value;
    encoded =
      result.format === "json" || result.format === "jsonl"
        ? renderCliDocument(value, result.format, process.stdout.isTTY === true)
        : formatCliOutput(value, result.format);
  }
  const text = encoded.endsWith("\n") ? encoded : `${encoded}\n`;
  if ((result.kind === "document" && !result.tokens) || result.exitCode !== 0)
    return text;
  if (controls.tokenCount) return `${estimateTokenCount(text)}\n`;
  if (!controls.tokenWindow) return text;
  const window = sliceTextByTokenWindow(
    text,
    controls.tokenOffset ?? 0,
    controls.tokenLimit,
  );
  return window.truncated
    ? `${window.text}\n[truncated: showing tokens ${window.start}–${window.end} of ${window.total}]\n`
    : text;
};

const sortedCommands = (cli: CliInstance): readonly CliCommandEntry[] =>
  [...cliCommands(cli)].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

/**
 * `--llms` and `--llms-full`: Markdown unless a structured format is chosen.
 * A known command first scopes the manifest to that command.
 */
const llmsAnswer = (
  cli: CliInstance,
  global: CliGlobalArguments,
  full: boolean,
): DiscoveryAnswer => {
  const { format, formatExplicit, validation } = readCliOutputArguments(global);
  if (!validation.ok)
    return renderedAnswer(renderCliOutputArgumentError(validation), 1);
  const scoped = cliCommands(cli).find(
    ({ name }) => name === global.command[0],
  );
  const commands = scoped === undefined ? sortedCommands(cli) : [scoped];
  if (!formatExplicit || format === "md")
    return markupAnswer(
      full
        ? formatLlmsFull(cli.name, commands)
        : formatLlmsIndex(cli.name, commands, CLI_DESCRIPTION),
    );
  return documentAnswer(
    full
      ? llmsFullManifest(commands, CLI_CUSTOM_GLOBAL_OPTIONS)
      : llmsIndexManifest(commands, CLI_CUSTOM_GLOBAL_OPTIONS),
    format,
  );
};

/**
 * `--schema` for a command, or the error for an unknown one. Known-command
 * Markdown stays with the dispatcher until the remaining execution migration.
 */
const schemaAnswer = (
  cli: CliInstance,
  global: CliGlobalArguments,
): DiscoveryAnswer | undefined => {
  const name = global.command[0]!;
  const entry = cliCommands(cli).find((command) => command.name === name);
  if (entry === undefined) {
    const suggestion = suggestCommand(
      name,
      cliCommands(cli).map((command) => command.name),
    );
    const { failure } = unknownCommandReply({
      name: cli.name,
      global,
      commandIndex: 0,
      suggestion,
    });
    return answer(`Error: ${failure.message}`, 1);
  }
  const { format, formatExplicit, validation } = readCliOutputArguments(global);
  if (!validation.ok)
    return renderedAnswer(renderCliOutputArgumentError(validation), 1);
  return documentAnswer(
    commandSchemaDocument(entry, CLI_CUSTOM_GLOBAL_OPTIONS),
    formatExplicit ? format : "toon",
  );
};

/** Facts about one invocation's process that discovery output depends on. */
interface Invocation {
  readonly environment: UpdateEnvironment;
  readonly stdoutIsTerminal: boolean;
  /** `performance.now()` when the dispatcher received the invocation. */
  readonly started: number;
}

/** Preserve the existing installer refusal without delegating to an installer. */
const updateRefusalAnswer = (
  global: CliGlobalArguments,
  invocation: Invocation,
): DiscoveryAnswer => {
  const controls = readCliOutputArguments(global);
  const failure = {
    ...CLI_UPDATE_REFUSAL,
    message: redactExplicitText(
      CLI_UPDATE_REFUSAL.message,
      declaredSensitiveValues(global.command),
    ),
  };
  return invocation.stdoutIsTerminal && !controls.formatExplicit
    ? answer(`Error (${failure.code}): ${failure.message}`, 1)
    : documentAnswer(failure, controls.format, false, 1);
};

/** The production MCP entry owns server startup; a command cannot start another. */
const retiredMcpAnswer = (
  cli: CliInstance,
  global: CliGlobalArguments,
  invocation: Invocation,
): DiscoveryAnswer => {
  const controls = readCliOutputArguments(global);
  const sensitive = declaredSensitiveValues(global.command);
  const text = (value: string): string => redactExplicitText(value, sensitive);
  return renderedAnswer(
    renderFailure(
      {
        code: "MCP_MODE_REMOVED",
        message: text(
          `Per-command --mcp has been removed. Use '${cli.name} mcp' to start REA's MCP server.`,
        ),
      },
      {
        command: text(global.command[0] ?? cli.name),
        duration: `${Math.round(performance.now() - invocation.started)}ms`,
      },
      {
        description: text("Suggested command:"),
        commands: [{ command: text(`${cli.name} mcp`) }],
      },
      {
        format:
          controls.format === "csv" || controls.format === "tsv"
            ? "json"
            : controls.format,
        human: invocation.stdoutIsTerminal && !controls.formatExplicit,
        fullOutput: controls.fullOutput,
        tokenCount: controls.tokenCount,
        tokenLimit: controls.tokenLimit,
        tokenOffset: controls.tokenOffset,
      },
    ),
    1,
  );
};

/**
 * An unknown command: the closest command name, the corrected invocation and
 * the help command. On a terminal without an explicit format the error is
 * text, followed by the update notice when one is due.
 */
const unknownCommandAnswer = (
  cli: CliInstance,
  global: CliGlobalArguments,
  { environment, stdoutIsTerminal, started }: Invocation,
): DiscoveryAnswer | undefined => {
  const controls = readCliOutputArguments(global);
  const selectedFormat = controls.formatExplicit ? controls.format : "toon";
  // Delimited exports require rows; a command diagnostic remains a document.
  const format =
    selectedFormat === "csv" || selectedFormat === "tsv"
      ? "json"
      : selectedFormat;
  const human = stdoutIsTerminal && !controls.formatExplicit;
  const unknown = global.command[0]!;
  const suggestion = suggestCommand(unknown, [
    ...cliCommands(cli).map(({ name }) => name),
    "completions",
    "mcp",
  ]);
  const update = human
    ? availableUpdate(cli.name, PRODUCT_IDENTITY.packageVersion, environment)
    : undefined;
  const notice =
    update === undefined ? [] : updateNoticeCta(cli.name, update).commands;
  const { command, cta, failure } = unknownCommandReply({
    name: cli.name,
    global,
    commandIndex: 0,
    suggestion,
    additionalCommands: notice,
  });
  return renderedAnswer(
    renderFailure(
      failure,
      {
        command,
        duration: `${Math.round(performance.now() - started)}ms`,
      },
      cta,
      {
        format,
        human,
        fullOutput: controls.fullOutput,
        tokenCount: controls.tokenCount,
        tokenLimit: controls.tokenLimit,
        tokenOffset: controls.tokenOffset,
      },
    ),
    1,
  );
};

/**
 * The document an invocation asks for instead of running a command, or
 * undefined. Precedence (after the detached update refresh): `--update`
 * without help is refused; per-command `--mcp` is retired and a root MCP
 * entry stays with the production launcher; the LLM manifests answer
 * next; then the
 * integrations (`completions` shows its page for help or without a shell,
 * `mcp` shows its page without a subcommand); then `--version` without help;
 * then the root page for no command; then a command's page for help (help
 * after an unknown command shows the root page); then `--schema`; then the
 * unknown-command error.
 */
const discoveryAnswer = (
  cli: CliInstance,
  global: CliGlobalArguments,
  invocation: Invocation,
): DiscoveryAnswer | undefined => {
  const { command, flags } = global;
  const help = flags.has("--help") || flags.has("-h");
  if (flags.has("--update") && !help)
    return updateRefusalAnswer(global, invocation);
  if (flags.has("--mcp"))
    return command.length === 0
      ? undefined
      : retiredMcpAnswer(cli, global, invocation);
  if (flags.has("--llms") || flags.has("--llms-full"))
    return llmsAnswer(cli, global, flags.has("--llms-full"));
  const completions = integrationIndex(command, cli.name, "completions");
  if (completions >= 0) {
    const shell = command[completions + 1];
    if (
      !help &&
      shell !== undefined &&
      !HELP_SHELLS.includes(shell as (typeof HELP_SHELLS)[number])
    )
      return answer(
        redactExplicitText(
          `Error (INVALID_SHELL): Unknown shell '${shell}'. Supported: ${HELP_SHELLS.join(", ")}`,
          declaredSensitiveValues(global.command),
        ),
        1,
      );
    if (!help && command.length > completions + 2)
      return answer(
        "Error (PARSE_ERROR): completions expects exactly one shell. Use 'rea completions --help' for usage.",
        1,
      );
    return help || shell === undefined
      ? answer(
          formatCommandHelp(`${cli.name} completions`, {
            description: COMPLETIONS_DESCRIPTION,
            args: z.object({
              shell: z
                .enum(HELP_SHELLS)
                .describe("Shell to generate completions for"),
            }),
            hint: completionsHint(cli.name),
          }),
        )
      : undefined;
  }
  const mcp = integrationIndex(command, cli.name, "mcp");
  if (mcp >= 0) {
    const subcommand = command[mcp + 1];
    if (!subcommand)
      return answer(
        formatCommandListHelp(`${cli.name} mcp`, {
          description: MCP_GROUP_DESCRIPTION,
          commands: [...MCP_SUBCOMMANDS].map(([name, { description }]) => ({
            name,
            description,
          })),
          globalOptions: { formats: CLI_DOCUMENT_OUTPUT_FORMATS },
        }),
      );
    // `mcp add` renders its own page; an unknown subcommand is an error.
    return help && subcommand === "doctor"
      ? answer(
          formatCommandHelp(`${cli.name} mcp doctor`, {
            description: MCP_SUBCOMMANDS.get("doctor")!.description,
          }),
        )
      : undefined;
  }
  if (flags.has("--version") && !help)
    return answer(PRODUCT_IDENTITY.packageVersion);
  if (command.length === 0) return answer(rootPage(cli));
  if (help) {
    const entry = cliCommands(cli).find(({ name }) => name === command[0]);
    if (entry === undefined) return answer(rootPage(cli));
    const { definition } = entry;
    return answer(
      formatCommandHelp(`${cli.name} ${entry.name}`, {
        description: definition.description,
        args: definition.args,
        options: definition.options,
        alias: definition.alias,
        globalOptions: commandGlobalOptions,
      }),
    );
  }
  if (flags.has("--schema")) return schemaAnswer(cli, global);
  if (cliCommands(cli).some(({ name }) => name === command[0]))
    return undefined;
  return unknownCommandAnswer(cli, global, invocation);
};

type ServeOptions = NonNullable<Parameters<CliInstance["serve"]>[1]>;

/**
 * Answer the detached update refresh, help, `--version`, `--schema`, the
 * LLM manifests and unknown commands, reading the arguments as the command dispatcher receives
 * them. Returns undefined when the invocation asks for something else.
 */
export const serveDiscovery = (
  cli: CliInstance,
  arguments_: readonly string[],
  options: ServeOptions,
  environment: UpdateEnvironment,
  parsed?: CliGlobalArguments,
): Promise<void> | undefined => {
  const global = parsed ?? parseCliGlobalArguments(arguments_);
  // The refresh writes nothing and answers before every other flag.
  if (global.flags.has(UPDATE_CHECK_FLAG))
    return refreshUpdateCache(
      cli.name,
      PRODUCT_IDENTITY.packageVersion,
      environment,
    );
  const result = discoveryAnswer(cli, global, {
    environment,
    stdoutIsTerminal: process.stdout.isTTY === true,
    started: performance.now(),
  });
  if (result === undefined) return undefined;
  (options.stdout ?? ((text: string) => process.stdout.write(text)))(
    presentDiscoveryAnswer(result, global),
  );
  if (result.exitCode !== 0)
    (options.exit ?? ((code: number) => process.exit(code)))(result.exitCode);
  return Promise.resolve();
};
