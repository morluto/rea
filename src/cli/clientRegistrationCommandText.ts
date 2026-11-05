/** Incur takes a command string and splits quoted segments without backslash escapes. */
const isPlainArgument = (argument: string): boolean =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument);

/** Quote only arguments that need it, so plain paths reach client configs unchanged. */
export const clientRegistrationCommandText = (
  command: readonly string[],
): string =>
  command
    .map((argument) =>
      isPlainArgument(argument)
        ? argument
        : `'${argument.replaceAll("'", `'"'"'`)}'`,
    )
    .join(" ");
