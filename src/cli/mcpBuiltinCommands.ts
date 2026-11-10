import { z } from "incur";

import {
  adaptCliOutputArgumentsForIncur,
  declaredSensitiveValues,
  splitIncurBuiltinArguments,
} from "../cliBuiltinArguments.js";
import {
  parseCliOutputArguments,
  renderCliDocument,
  type CliOutputFormat,
} from "../cliOutput.js";
import { redactExplicitText } from "../domain/explicitSensitiveValues.js";
import type { CliInstance } from "./types.js";

type ServeOptions = NonNullable<Parameters<CliInstance["serve"]>[1]>;

/** Pinned Incur 0.6.1 `mcp` builtin subcommands; Incur does not export them. */
export const MCP_BUILTIN_SUBCOMMANDS = new Map([
  [
    "add",
    {
      description: "Register as MCP server",
      alias: { command: "c" },
      options: z.object({
        agent: z.string().optional(),
        command: z.string().optional(),
        noGlobal: z.boolean().optional(),
      }),
    },
  ],
  ["doctor", { description: "Validate MCP server startup and tool listing" }],
]);

/** Incur 0.6.1 builtins that it serves before its `mcp` subcommand branch. */
const PRECEDING_BUILTIN_FLAGS: ReadonlySet<string> = new Set([
  "--incur-update-check",
  "--update",
  "--llms",
  "--llms-full",
  "--mcp",
]);

// zsh expands a word that starts with `=` to an executable path.
const PLAIN_SHELL_WORD = /^(?!=)[\w./+=:,-]+$/u;

/**
 * Incur 0.6.1 rejects an unknown `mcp` subcommand in TOON regardless of the
 * selected format. Report the same envelope in the explicitly selected format;
 * without one, Incur's TOON or human rendering is already the selected output.
 * The arguments are the caller's normalized ones, before REA adapts output
 * flags for Incur, so the suggested command keeps the caller's selection.
 */
export const reportUnknownMcpSubcommand = (
  name: string,
  arguments_: readonly string[],
  options: ServeOptions,
): boolean => {
  const { command, commandIndices } = splitIncurBuiltinArguments(arguments_);
  const [entry, subcommand] = command;
  // Incur receives JSON for REA's delimited formats and no `--columns`.
  const incurArguments = adaptCliOutputArgumentsForIncur(arguments_);
  const incurOutputValues = new Set(
    splitIncurBuiltinArguments(incurArguments).outputValues.map(
      ({ index }) => index,
    ),
  );
  if (
    entry !== "mcp" ||
    // Incur shows group help for an empty token and owns flag-shaped globals.
    !subcommand ||
    subcommand.startsWith("-") ||
    MCP_BUILTIN_SUBCOMMANDS.has(subcommand) ||
    // Incur serves these builtins before its `mcp` subcommand branch. An
    // output flag's value is data, even when it is spelled like a builtin.
    incurArguments.some(
      (token, index) =>
        !incurOutputValues.has(index) && PRECEDING_BUILTIN_FLAGS.has(token),
    )
  )
    return false;
  const output = parseCliOutputArguments(incurArguments);
  // Invalid output controls keep Incur's own parse diagnostic.
  if (!output.formatExplicit || !output.validation.ok) return false;
  const sensitive = declaredSensitiveValues(command);
  const text = (value: string): string => redactExplicitText(value, sensitive);
  const suggestion = [...MCP_BUILTIN_SUBCOMMANDS.keys()].find((candidate) =>
    candidate.startsWith(subcommand.toLowerCase()),
  );
  const corrected = arguments_.map((token, index) =>
    index === commandIndices[1] ? suggestion : token,
  );
  // Joined tokens replay only when each one is a plain word in every shell;
  // quoting is shell-specific, and a redacted value cannot be replayed.
  const replayable =
    suggestion !== undefined &&
    corrected.every(
      (token) =>
        token !== undefined &&
        PLAIN_SHELL_WORD.test(token) &&
        text(token) === token,
    );
  const commands = [
    ...(replayable ? [{ command: `${name} ${corrected.join(" ")}` }] : []),
    {
      command: text(`${name} mcp --help`),
      description: text("see all available commands"),
    },
  ];
  const document = {
    code: "COMMAND_NOT_FOUND",
    message: text(
      `'${subcommand}' is not a command for '${name} mcp'.${suggestion === undefined ? "" : ` Did you mean '${suggestion}'?`}`,
    ),
    cta: {
      description: text(
        commands.length === 1 ? "Suggested command:" : "Suggested commands:",
      ),
      commands,
    },
  };
  (options.stdout ?? ((value: string) => process.stdout.write(value)))(
    // REA's document renderer owns JSON layout and Markdown escaping.
    renderCliDocument(
      document,
      output.format as CliOutputFormat,
      process.stdout.isTTY === true,
    ),
  );
  (options.exit ?? ((code: number) => process.exit(code)))(1);
  return true;
};
