import type { InspectSignalDecodersInput } from "../domain/signals/signalDecoders.js";
import { literalSubstringPredicate } from "../domain/analysisSearch.js";
import { decodeLimit } from "../domain/parseFailure.js";

/** The ParseFailure format of the `sigrok-cli` decoder catalog. */
export const DECODER_CATALOG_FORMAT = "sigrok-decoder-catalog";
const DECODER_CATALOG_LINES = 65536;

const copyText = (value: string): string =>
  Buffer.from(value, "utf16le").toString("utf16le");

/** Keep the budget refusal ahead of grammar checking. The final empty line counts here. */
const assertDiscoveryLineBudget = (text: string): void => {
  let separators = 0;
  let end = text.indexOf("\n");
  while (end >= 0) {
    if (++separators >= DECODER_CATALOG_LINES)
      throw decodeLimit(
        DECODER_CATALOG_FORMAT,
        "Decoder discovery exceeds the 65,536-line representation budget",
        { name: "line_budget", maximum: DECODER_CATALOG_LINES },
      );
    end = text.indexOf("\n", end + 1);
  }
};

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
  assertDiscoveryLineBudget(text);
  const matches = literalSubstringPredicate(input.query, false);
  const decoders: { id: string; name: string }[] = [];
  const help: { line_number: number; text: string }[] = [];
  let examined = 0;
  let matching = 0;
  // Copy selected strings so a page does not retain the complete producer output.
  const select = (): boolean => {
    const index = matching++ - input.offset;
    return index >= 0 && (input.limit === null || index < input.limit);
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
    },
  };
};

const findCatalogHeading = (lines: Iterator<string, void>): boolean => {
  for (let next = lines.next(); !next.done; next = lines.next())
    if (next.value === "Supported protocol decoders:") return true;
  return false;
};
