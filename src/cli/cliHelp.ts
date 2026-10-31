const GLOBAL_OPTIONS_HEADING = "Global Options:";

/**
 * Restore the documented global `--json` switch in Incur's Global Options help list.
 *
 * Incur 0.6.1 accepts bare `--json` globally to select JSON output, but its
 * hardcoded help list omits the switch under Global Options. Insert `--json`
 * in alphabetical order immediately following `--help`.
 */
export const augmentCliHelpOutput = (output: string): string => {
  const index = output.indexOf(GLOBAL_OPTIONS_HEADING);
  if (index === -1) return output;
  const before = output.slice(0, index);
  const globalSection = output.slice(index);
  if (/^\s*--json(?:\s|$)/m.test(globalSection)) return output;
  return (
    before +
    globalSection.replace(
      /^(\s*--help\b[^\r\n]*)(\r?\n)/m,
      (_, helpLine: string, newline: string) =>
        `${helpLine}${newline}  --json                              Select JSON output format; equivalent to --format json${newline}`,
    )
  );
};
