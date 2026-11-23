// GDB resolves its built-in aliases before abbreviations, so `p` is print, never
// python. Of the prefixes of the commands classified below, only these four
// name another command (checked against GDB 18.1).
const GDB_BUILTIN_ALIASES: ReadonlyMap<string, string> = new Map([
  ["d", "delete"],
  ["p", "print"],
  ["s", "step"],
  ["t", "thread"],
]);

/** The first console word, lowercased, with GDB's built-in aliases resolved. */
const gdbCommandWord = (command: string): string | undefined => {
  const word = /^\s*([^\s;]+)/u.exec(command)?.[1]?.toLowerCase();
  return word === undefined
    ? undefined
    : (GDB_BUILTIN_ALIASES.get(word) ?? word);
};

/** Classify one-shot GDB commands that can invalidate the configured output sink. */
export const gdbOneShotCommandMayInvalidateDetachProof = (
  command: string,
): boolean => {
  if (commandMayChangeInferiorOutput(command)) return true;
  const firstToken = gdbCommandWord(command);
  if (
    firstToken !== undefined &&
    (["source", "define", "alias"].some((name) =>
      name.startsWith(firstToken),
    ) ||
      firstToken === "py" ||
      "python".startsWith(firstToken))
  )
    return true;
  // One-shot execution cannot establish which shell/GDB context interprets
  // redirections, nor safely track multiline command definitions.
  return /[<>]{1,2}|&>|[\r\n;]/u.test(command);
};

/** Classify GDB commands that can invalidate the configured output sink. */
export const commandMayChangeInferiorOutput = (command: string): boolean => {
  // These exact read-only TTY inspections ("show inferior-tty", "help
  // inferior-tty", MI "-inferior-tty-show") cannot reconfigure the output
  // sink, so they must not revoke the startup verification. Keep compound
  // commands and abbreviations under the conservative rules below
  // (fail-closed).
  if (
    /^[ \t]*(?:show|help)[ \t]+inferior-tty[ \t]*$/iu.test(command) ||
    /^[ \t]*-inferior-tty-show[ \t]*$/iu.test(command)
  )
    return false;
  const setting = /^\s*(?:set|with)\s+(\S+)/iu.exec(command)?.[1];
  const maySetInferiorTty =
    setting !== undefined && "inferior-tty".startsWith(setting.toLowerCase());
  const firstToken = gdbCommandWord(command);
  const mayBeTtyCommand =
    firstToken !== undefined && "tty".startsWith(firstToken);
  const mayDefineAlias =
    firstToken !== undefined && "alias".startsWith(firstToken);
  const mayRunWithOutputRedirection =
    firstToken !== undefined &&
    ["run", "start", "starti"].some((name) => name.startsWith(firstToken)) &&
    /[<>]{1,2}|&>/u.test(command.slice(firstToken.length));
  return (
    maySetInferiorTty ||
    mayBeTtyCommand ||
    mayDefineAlias ||
    /\binferior-tty\b/iu.test(command) ||
    /^\s*(?:wit(?:h)?(?:\s|$)|tty(?:\s|$)|source\b|py\w*|define\b)/iu.test(
      command,
    ) ||
    mayRunWithOutputRedirection
  );
};
