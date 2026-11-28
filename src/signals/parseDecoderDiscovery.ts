import type { InspectSignalDecodersInput } from "../domain/signals/signalDecoders.js";
import { literalSubstringPredicate } from "../domain/analysisSearch.js";
import { SIGNAL_DECODER_PAGE_RECORDS } from "../domain/signals/signalDecoders.js";

const copyText = (value: string): string =>
  Buffer.from(value, "utf16le").toString("utf16le");

function* discoveryLines(text: string): Generator<string, void> {
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) {
      yield text.slice(start);
      return;
    }
    const end = text.charCodeAt(newline - 1) === 13 ? newline - 1 : newline;
    yield text.slice(start, end);
    start = newline + 1;
  }
}

/** Parse only the 0.7.2 catalog grammar; help remains literal producer text. */
export const parseDecoderDiscovery = (
  text: string,
  input: InspectSignalDecodersInput,
) => {
  const matches = literalSubstringPredicate(input.query, false);
  const decoders: { id: string; name: string }[] = [];
  const help: { line_number: number; text: string }[] = [];
  let examined = 0;
  let matching = 0;
  let recordBudgetReached = false;
  // Copy selected strings so a page does not retain the complete producer
  // output. A page ends early at the record budget, so a short line cannot
  // expand into an unbounded number of records; it stays contiguous.
  const select = (): boolean => {
    const index = matching++ - input.offset;
    if (index < 0 || (input.limit !== null && index >= input.limit))
      return false;
    if (index >= SIGNAL_DECODER_PAGE_RECORDS) {
      recordBudgetReached = true;
      return false;
    }
    return true;
  };
  const lines = discoveryLines(text);
  const catalog = input.decoder === null;
  if (catalog) {
    const heading = findCatalogHeading(lines);
    if (!heading) throw new Error("sigrok decoder catalog heading is missing");
    const seen = new Set<string>();
    for (let next = lines.next(); !next.done; next = lines.next()) {
      if (next.value === "") continue;
      const match = /^ {2}([a-zA-Z0-9_+-]+) +(.+)$/u.exec(next.value);
      const id = match?.[1];
      const name = match?.[2];
      if (id === undefined || name === undefined || seen.has(id))
        throw new Error("Malformed or duplicate sigrok decoder catalog record");
      seen.add(id);
      examined += 1;
      if ((matches(id) || matches(name)) && select())
        decoders.push({ id: copyText(id), name: copyText(name) });
    }
    if (examined === 0)
      throw new Error("sigrok returned an empty decoder catalog");
  } else {
    const heading = lines.next();
    if (heading.done || heading.value !== `ID: ${input.decoder}`)
      throw new Error("Decoder help does not identify the selected decoder");
    for (
      let next: IteratorResult<string, void> = heading;
      !next.done;
      next = lines.next()
    ) {
      examined += 1;
      if (matches(next.value) && select())
        help.push({ line_number: examined, text: copyText(next.value) });
    }
  }
  const returned = decoders.length + help.length;
  return {
    decoders,
    help_lines: help,
    output_window: {
      unit: catalog ? "decoders" : "help-lines",
      examined,
      matching,
      returned,
      has_more: matching - input.offset > returned,
      record_budget_reached: recordBudgetReached,
    },
  };
};

const findCatalogHeading = (lines: Iterator<string, void>): boolean => {
  for (let next = lines.next(); !next.done; next = lines.next())
    if (next.value === "Supported protocol decoders:") return true;
  return false;
};
