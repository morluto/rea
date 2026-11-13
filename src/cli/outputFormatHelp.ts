import type { CliInstance } from "../cli/types.js";
import { splitIncurBuiltinArguments } from "../cliBuiltinArguments.js";
import { CLI_OUTPUT_FORMATS } from "../cliOutput.js";

type ServeOptions = NonNullable<Parameters<CliInstance["serve"]>[1]>;

/** Entry rows in Incur's global section: indent, flag, gap, description. */
const GLOBAL_OPTION_ROW = /^(\s*)(\S.*?)\s{2,}(\S.*)$/u;

const GLOBAL_SECTION_HEADING = "Global Options:";
const INDENT = "  ";
const GAP = "  ";

/**
 * Incur's global `--format` line names the five formats its formatter renders.
 * REA accepts CSV and TSV outside Incur through `adaptCliOutputArgumentsForIncur`,
 * so repeating that list alone hides a supported export choice.
 */
const DELIMITED_FORMATS_HINT =
  "CSV and TSV export requires --filter-output <row-array-path> and --columns <column,...>; they are not available for every complete document.";

const outputFormatFlag = (): string =>
  `--format <${CLI_OUTPUT_FORMATS.join("|")}>`;

const globalSectionBounds = (
  lines: readonly string[],
): { readonly start: number; readonly end: number } | undefined => {
  const start = lines.findIndex(
    (line) => line.trim() === GLOBAL_SECTION_HEADING,
  );
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && lines[end]!.startsWith(INDENT)) end += 1;
  return { start, end };
};

const parseRow = (
  line: string,
): { readonly flag: string; readonly description: string } | undefined => {
  const match = GLOBAL_OPTION_ROW.exec(line);
  return match === null
    ? undefined
    : { flag: match[2]!, description: match[3]! };
};

/**
 * Advertise the complete `--format` choices in the global option section.
 *
 * The section is re-rendered from its parsed rows because widening the
 * `--format` choice list shifts every other row's description column.
 */
export const describeReaOutputFormats = (help: string): string => {
  const lines = help.split("\n");
  const bounds = globalSectionBounds(lines);
  if (bounds === undefined) return help;
  const rows = lines
    .slice(bounds.start + 1, bounds.end)
    .map(parseRow)
    .filter((row) => row !== undefined)
    .map((row) =>
      row.flag.startsWith("--format ")
        ? { ...row, flag: outputFormatFlag() }
        : row,
    );
  if (rows.length === 0) return help;
  const width = Math.max(...rows.map((row) => row.flag.length));
  const rendered = rows.map(
    (row) =>
      `${INDENT}${row.flag}${" ".repeat(width - row.flag.length)}${GAP}${row.description}`,
  );
  const remainder = lines.slice(bounds.end);
  // The section is followed by a blank separator or the document's end.
  if (remainder[0]?.trim() === "") remainder.shift();
  return [
    ...lines.slice(0, bounds.start + 1),
    ...rendered,
    "",
    DELIMITED_FORMATS_HINT,
    ...remainder,
  ].join("\n");
};

/**
 * Incur answers these before it renders help, so their output is not help.
 */
const PRECEDING_FEATURE_FLAGS: ReadonlySet<string> = new Set([
  "--llms",
  "--llms-full",
  "--mcp",
]);

/** Whether this invocation will render help text for the caller. */
export const requestsHelpText = (arguments_: readonly string[]): boolean => {
  const { flags } = splitIncurBuiltinArguments(arguments_);
  if (!flags.has("--help") && !flags.has("-h")) return false;
  return !arguments_.some((argument) => PRECEDING_FEATURE_FLAGS.has(argument));
};

export interface HelpOutputRecorder {
  /** Options to hand every downstream writer for this invocation. */
  readonly options: ServeOptions;
  /** Release the recorded output, describing REA's own format choices. */
  finish(result: Promise<void>): Promise<void>;
}

/**
 * Buffer one help invocation so the format list can name every accepted choice.
 *
 * Help output is a single bounded document, so buffering cannot delay a
 * streaming result. Non-help invocations pass their options through untouched.
 */
export const recordHelpOutput = (
  arguments_: readonly string[],
  options: ServeOptions,
): HelpOutputRecorder => {
  if (!requestsHelpText(arguments_)) {
    return { options, finish: async (result) => result };
  }
  const write =
    options.stdout ?? ((text: string) => process.stdout.write(text));
  let recorded = "";
  return {
    options: {
      ...options,
      stdout: (text) => {
        recorded += text;
      },
    },
    finish: async (result) => {
      await result;
      write(describeReaOutputFormats(recorded));
    },
  };
};
