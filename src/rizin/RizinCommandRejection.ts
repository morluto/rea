/**
 * Rizin 0.9.1 rejects an unknown command instead of failing the process: it
 * prints "ERROR: Command '<name>' does not exist." (usually followed by the
 * command's help) to stderr and exits 0 with stdout empty or carrying the help
 * text. This helper recognizes exactly those observed markers so a consumer can
 * surface the rejection instead of treating the capture as a valid answer.
 * It recognizes nothing else — other stderr content is not a command rejection.
 */
export interface RizinCommandRejection {
  /** The command Rizin rejected, as named by its stderr marker. */
  readonly command: string;
}

const namedCommand =
  /^ERROR: Command '([^'\n]{1,200})' does not exist\.[ \t]*\r?$/mu;
const helpOfKnownCommand =
  /^ERROR: Displaying the help of command '([^'\n]{1,200})'[. \t]*\r?$/mu;

export const rizinCommandRejection = (
  stderr: string,
): RizinCommandRejection | undefined => {
  const command =
    namedCommand.exec(stderr)?.[1] ?? helpOfKnownCommand.exec(stderr)?.[1];
  return command === undefined ? undefined : { command };
};
