import { mcpRegistrationOptionsSchema } from "../contracts/mcpRegistration.js";

import {
  adaptCliOutputArgumentsForIncur,
  parseCliGlobalArguments,
  type CliGlobalArguments,
} from "../cliBuiltinArguments.js";
import {
  readCliOutputArguments,
  renderCliDocument,
  type CliOutputFormat,
} from "../cliOutput.js";
import { renderFailure } from "./outputEnvelope.js";
import { suggestCommand } from "./commandSuggestion.js";
import { unknownCommandReply } from "./unknownCommandReply.js";
import type { CliInstance } from "./types.js";

type ServeOptions = NonNullable<Parameters<CliInstance["serve"]>[1]>;

/** Named MCP commands shared by completion and unknown-command guidance. */
export const MCP_SUBCOMMANDS = new Map([
  [
    "add",
    {
      description: "Register as MCP server",
      alias: { command: "c" },
      options: mcpRegistrationOptionsSchema,
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

/**
 * Incur 0.6.1 rejects an unknown `mcp` subcommand in TOON regardless of the
 * selected format. Report the same document in the explicitly selected format,
 * or preserve the default TOON/human presentation. Both paths honor explicit
 * sensitive-value declarations before rendering.
 * The caller's arguments are read before REA adapts output flags for Incur,
 * so the suggested command keeps the caller's selection.
 */
export const reportUnknownMcpSubcommand = (
  name: string,
  global: CliGlobalArguments,
  options: ServeOptions,
): boolean => {
  const started = performance.now();
  const { arguments: arguments_, command } = global;
  const [entry, subcommand] = command;
  // Incur receives JSON for REA's delimited formats and no `--columns`.
  const incur = parseCliGlobalArguments(
    adaptCliOutputArgumentsForIncur(arguments_),
  );
  const incurArguments = incur.arguments;
  const incurOutputValues = new Set(
    incur.outputValues.map(({ index }) => index),
  );
  if (
    entry !== "mcp" ||
    // Incur shows group help for an empty token and owns flag-shaped globals.
    !subcommand ||
    subcommand.startsWith("-") ||
    MCP_SUBCOMMANDS.has(subcommand) ||
    // Incur serves these builtins before its `mcp` subcommand branch. An
    // output flag's value is data, even when it is spelled like a builtin.
    incurArguments.some(
      (token, index) =>
        !incurOutputValues.has(index) && PRECEDING_BUILTIN_FLAGS.has(token),
    )
  )
    return false;
  const output = readCliOutputArguments(incur);
  // Invalid output controls keep Incur's own parse diagnostic.
  if (!output.validation.ok) return false;
  // Preserve the existing explicit-format prefix policy and the default
  // dispatcher's edit-distance ranking while moving both replies to one owner.
  const suggestion = output.formatExplicit
    ? [...MCP_SUBCOMMANDS.keys()].find((candidate) =>
        candidate.startsWith(subcommand.toLowerCase()),
      )
    : suggestCommand(subcommand, MCP_SUBCOMMANDS.keys());
  const {
    command: displayCommand,
    cta,
    failure,
  } = unknownCommandReply({
    name,
    scope: ["mcp"],
    global,
    commandIndex: 1,
    suggestion,
  });
  (options.stdout ?? ((value: string) => process.stdout.write(value)))(
    // REA's document renderer owns JSON layout and Markdown escaping.
    output.formatExplicit
      ? renderCliDocument(
          { ...failure, cta },
          output.format as CliOutputFormat,
          process.stdout.isTTY === true,
        )
      : renderFailure(
          failure,
          {
            command: displayCommand,
            duration: `${Math.round(performance.now() - started)}ms`,
          },
          cta,
          {
            format: "toon",
            human: process.stdout.isTTY === true,
            fullOutput: false,
            tokenCount: false,
            tokenLimit: undefined,
            tokenOffset: undefined,
          },
        ),
  );
  (options.exit ?? ((code: number) => process.exit(code)))(1);
  return true;
};
