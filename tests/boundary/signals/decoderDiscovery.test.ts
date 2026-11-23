import { expect, it } from "vitest";
import { fixedAllowanceOptions } from "../../../src/domain/fixedAllowanceRemediation.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../../../src/domain/parseFailureAnalysisError.js";
import { inspectSignalDecodersInputSchema } from "../../../src/domain/signals/signalDecoders.js";
import {
  DECODER_CATALOG_FORMAT,
  parseDecoderDiscovery,
} from "../../../src/signals/parseDecoderDiscovery.js";

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

it("bounds line expansion before constructing help records", () => {
  const input = inspectSignalDecodersInputSchema.parse({
    decoder: "uart",
    offset: 65534,
    limit: 1,
  });
  expect(parseDecoderDiscovery("ID: uart" + "\n".repeat(65535), input)).toEqual(
    {
      decoders: [],
      help_lines: [{ line_number: 65535, text: "" }],
      output_window: {
        unit: "help-lines",
        examined: 65535,
        matching: 65535,
        returned: 1,
        has_more: false,
      },
    },
  );
  let thrown: unknown;
  try {
    parseDecoderDiscovery(
      "ID: uart\n" + "\n".repeat(65536),
      inspectSignalDecodersInputSchema.parse({ decoder: "uart" }),
    );
  } catch (cause) {
    thrown = cause;
  }
  expect(isParseLimit(thrown, DECODER_CATALOG_FORMAT)).toBe(true);
  if (!isParseLimit(thrown, DECODER_CATALOG_FORMAT))
    throw new Error("Expected decoder catalog parse limit");
  expect(
    parseLimitConstraint(
      "inspect_signal_decoders",
      "memory",
      thrown,
      fixedAllowanceOptions(
        "The sigrok decoder-discovery line allowance",
        "capture",
      ),
    ),
  ).toMatchObject({
    reason: expect.stringContaining("representation budget"),
    reportedLimits: { boundary: "line_budget", maximum: 65536 },
  });
});
