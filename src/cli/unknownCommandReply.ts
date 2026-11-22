import {
  declaredSensitiveValues,
  type CliGlobalArguments,
} from "../cliBuiltinArguments.js";
import { redactExplicitText } from "../domain/explicitSensitiveValues.js";
import type { CallToAction } from "./outputEnvelope.js";

// Joined tokens replay only as plain words in every supported shell. Quoting
// is shell-specific, and a redacted command cannot be replayed faithfully.
const PLAIN_SHELL_WORD = /^(?!=)[\w./+=:,-]+$/u;

/** One owner for unknown-command text and safe, declaration-aware guidance. */
export const unknownCommandReply = ({
  name,
  scope = [],
  global,
  commandIndex,
  suggestion,
  additionalCommands = [],
}: {
  readonly name: string;
  readonly scope?: readonly string[];
  readonly global: CliGlobalArguments;
  readonly commandIndex: number;
  readonly suggestion: string | undefined;
  readonly additionalCommands?: CallToAction["commands"];
}) => {
  const sensitive = declaredSensitiveValues(global.command);
  const text = (value: string): string => redactExplicitText(value, sensitive);
  const parent = [name, ...scope].join(" ");
  const unknown = global.command[commandIndex]!;
  const corrected = [
    name,
    ...global.arguments.map((token, index) =>
      index === global.commandIndices[commandIndex] ? suggestion : token,
    ),
  ];
  const replayable =
    suggestion !== undefined &&
    corrected.every(
      (token) =>
        token !== undefined &&
        PLAIN_SHELL_WORD.test(token) &&
        text(token) === token,
    );
  const commands = [
    ...(replayable ? [{ command: corrected.join(" ") }] : []),
    { command: `${parent} --help`, description: "see all available commands" },
  ];
  return {
    command: text(unknown),
    failure: {
      code: "COMMAND_NOT_FOUND",
      message: text(
        `'${unknown}' is not a command for '${parent}'.${suggestion === undefined ? "" : ` Did you mean '${suggestion}'?`}`,
      ),
    },
    cta: {
      description: text(
        commands.length === 1 ? "Suggested command:" : "Suggested commands:",
      ),
      commands: [...commands, ...additionalCommands].map(
        ({ command, description }) => ({
          command: text(command),
          ...(description === undefined
            ? {}
            : { description: text(description) }),
        }),
      ),
    },
  };
};
