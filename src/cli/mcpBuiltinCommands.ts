import { mcpRegistrationOptionsSchema } from "../contracts/mcpRegistration.js";

import type { CliGlobalArguments } from "../cliBuiltinArguments.js";
import { readCliOutputArguments, renderCliDocument } from "../cliOutput.js";
import { jsonLinesErrorRecord } from "./jsonLines.js";
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

/** Global documents take precedence over an unknown MCP subcommand. */
const PRECEDING_BUILTIN_FLAGS: ReadonlySet<string> = new Set([
  "--incur-update-check",
  "--update",
  "--llms",
  "--llms-full",
  "--mcp",
]);

/**
 * Report an unknown MCP subcommand through REA's diagnostic renderer, retaining
 * caller arguments for suggestions and explicit sensitive-value declarations.
 */
export const reportUnknownMcpSubcommand = (
  name: string,
  global: CliGlobalArguments,
  options: ServeOptions,
): boolean => {
  const started = performance.now();
  const { arguments: arguments_, command } = global;
  const [entry, subcommand] = command;
  const outputValues = new Set(global.outputValues.map(({ index }) => index));
  if (
    entry !== "mcp" ||
    // An empty token shows group help.
    !subcommand ||
    MCP_SUBCOMMANDS.has(subcommand) ||
    // Global documents precede the MCP subcommand branch. An
    // output flag's value is data, even when it is spelled like a builtin.
    arguments_.some(
      (token, index) =>
        !outputValues.has(index) && PRECEDING_BUILTIN_FLAGS.has(token),
    )
  )
    return false;
  const output = readCliOutputArguments(global);
  // The invocation boundary owns invalid output controls.
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
  const diagnostic = { ...failure, cta };
  const format =
    output.format === "csv" || output.format === "tsv" ? "json" : output.format;
  (options.stdout ?? ((value: string) => process.stdout.write(value)))(
    // REA's document renderer owns JSON layout and Markdown escaping.
    output.formatExplicit
      ? renderCliDocument(
          format === "jsonl" ? jsonLinesErrorRecord(diagnostic) : diagnostic,
          format,
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
