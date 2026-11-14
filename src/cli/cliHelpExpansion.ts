/**
 * Human help prints Incur's built-in global `--format` option as
 * `toon|json|yaml|md|jsonl`, while REA also accepts `csv` and `tsv` delimited
 * row exports (with their row-selection requirements). REA owns those formats;
 * the pinned dependency does not know about them. This expands the option the
 * way REA advertises it, without patching the dependency and without touching
 * the parser, the emitter or any command's output.
 *
 * This only changes help text served to a terminal; structured output and
 * command parsing are unchanged.
 */
const INCUR_FORMAT_LINE = "--format <toon|json|yaml|md|jsonl>";
const REA_FORMAT_LINE = "--format <toon|json|yaml|md|jsonl|csv|tsv>";

/** The exact line Incur renders for the global format option, with its padding. */
const EXACT_LINE = `${INCUR_FORMAT_LINE}  Output format`;
const EXPANDED_LINE = `${REA_FORMAT_LINE}  Output format; csv/tsv require a selected row collection and scalar columns`;

/** Expand the Incur global format help to the formats REA supports. */
export const expandReaHelp = (text: string): string =>
  text
    .replaceAll(EXACT_LINE, EXPANDED_LINE)
    .replaceAll(INCUR_FORMAT_LINE, REA_FORMAT_LINE);
