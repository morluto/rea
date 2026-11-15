/**
 * Incur's hardcoded Global Options list omits `--json` even though Incur and
 * REA accept it as shorthand for `--format json`. Insert the missing line in
 * alphabetical order when help text is written.
 */
const JSON_HELP_LINE =
  "  --json                              Shorthand for --format json";

/** True when help already advertises the global `--json` switch. */
const helpListsJson = (text: string): boolean =>
  /^ {2}--json(?:\s|$)/mu.test(text);

/**
 * Insert `--json` into a Global Options section that lacks it. Other help
 * pages are returned unchanged.
 */
export const augmentCliGlobalHelp = (text: string): string => {
  if (!text.includes("Global Options:") || helpListsJson(text)) return text;
  const lines = text.split("\n");
  const section = lines.findIndex((line) => line === "Global Options:");
  if (section < 0) return text;
  let insertAt = section + 1;
  while (insertAt < lines.length) {
    const match = /^ {2}(\S+)/u.exec(lines[insertAt]!);
    if (match === null) break;
    if (match[1]!.localeCompare("--json") > 0) break;
    insertAt += 1;
  }
  lines.splice(insertAt, 0, JSON_HELP_LINE);
  return lines.join("\n");
};
