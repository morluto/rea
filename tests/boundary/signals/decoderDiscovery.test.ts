import { expect, it } from "vitest";
import {
  inspectSignalDecodersInputSchema,
  SIGNAL_DECODER_PAGE_RECORDS,
} from "../../../src/domain/signals/signalDecoders.js";
import { parseDecoderDiscovery } from "../../../src/signals/parseDecoderDiscovery.js";

it("rejects malformed catalogs and the wrong decoder identity", () => {
  for (const text of [
    "",
    "Supported protocol decoders:\n",
    "Supported protocol decoders:\n  uart UART\n  uart Duplicate",
    "Supported protocol decoders:\n  malformed",
  ]) {
    expect(() =>
      parseDecoderDiscovery(
        text,
        inspectSignalDecodersInputSchema.parse({ limit: 1 }),
      ),
    ).toThrow();
  }
  expect(() =>
    parseDecoderDiscovery(
      "ID: spi\nOptions:",
      inspectSignalDecodersInputSchema.parse({ decoder: "uart" }),
    ),
  ).toThrow();
});

it("keeps help line ordinals, blank lines and literal special characters through selection", () => {
  const text = "ID: uart\r\nOptions:\r\n\r\n- mode: A[0] (default 'x')\r\n";
  const result = parseDecoderDiscovery(
    text,
    inspectSignalDecodersInputSchema.parse({
      decoder: "uart",
      query: "[0]",
      offset: 0,
      limit: 1,
    }),
  );
  expect(result.help_lines).toEqual([
    { line_number: 4, text: "- mode: A[0] (default 'x')" },
  ]);
  expect(result.output_window.examined).toBe(4);
});

it("ends a help page at the page record budget without refusing longer output", () => {
  const text = "ID: uart" + "\n".repeat(SIGNAL_DECODER_PAGE_RECORDS + 4);
  const all = parseDecoderDiscovery(
    text,
    inspectSignalDecodersInputSchema.parse({ decoder: "uart", limit: null }),
  );
  expect(all.help_lines).toHaveLength(SIGNAL_DECODER_PAGE_RECORDS);
  expect(all.output_window).toEqual({
    unit: "help-lines",
    examined: SIGNAL_DECODER_PAGE_RECORDS + 4,
    matching: SIGNAL_DECODER_PAGE_RECORDS + 4,
    returned: SIGNAL_DECODER_PAGE_RECORDS,
    has_more: true,
    record_budget_reached: true,
  });
  expect(
    parseDecoderDiscovery(
      text,
      inspectSignalDecodersInputSchema.parse({
        decoder: "uart",
        offset: SIGNAL_DECODER_PAGE_RECORDS,
        limit: null,
      }),
    ),
  ).toEqual({
    decoders: [],
    help_lines: [
      { line_number: SIGNAL_DECODER_PAGE_RECORDS + 1, text: "" },
      { line_number: SIGNAL_DECODER_PAGE_RECORDS + 2, text: "" },
      { line_number: SIGNAL_DECODER_PAGE_RECORDS + 3, text: "" },
      { line_number: SIGNAL_DECODER_PAGE_RECORDS + 4, text: "" },
    ],
    output_window: {
      unit: "help-lines",
      examined: SIGNAL_DECODER_PAGE_RECORDS + 4,
      matching: SIGNAL_DECODER_PAGE_RECORDS + 4,
      returned: 4,
      has_more: false,
      record_budget_reached: false,
    },
  });
});
