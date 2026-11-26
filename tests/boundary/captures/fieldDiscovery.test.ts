import { expect, it } from "vitest";
import { inspectPacketFieldsInputSchema } from "../../../src/domain/captures/packetFields.js";
import {
  FIELD_RECORD_BUDGET,
  parseFieldDiscovery,
} from "../../../src/captures/parseFieldDiscovery.js";

it("keeps duplicate registrations and source ordinals instead of overwriting abbreviations", () => {
  const text =
    "P\tUSB\tusb\r\nF\tVendor\tusb.idVendor\tFT_UINT16\tusb\tBASE_HEX\t0x0\t\r\nF\tOther Vendor\tusb.idVendor\tFT_UINT32\tusb\tBASE_DEC\t0xff00\tSecond registration";
  const result = parseFieldDiscovery(
    text,
    inspectPacketFieldsInputSchema.parse({
      kind: "fields",
      query: "idVendor",
      offset: 1,
    }),
  );
  expect(result.records).toEqual([
    {
      source_line: 3,
      kind: "field",
      name: "Other Vendor",
      abbreviation: "usb.idVendor",
      field_type: "FT_UINT32",
      parent_protocol: "usb",
      display_base: "BASE_DEC",
      bitmask: "0xff00",
      description: "Second registration",
    },
  ]);
  expect(result.output_window).toEqual({
    examined: 2,
    matching: 2,
    returned: 1,
    has_more: false,
    record_budget_reached: false,
  });
});

it("rejects damaged records even outside the selected page", () => {
  for (const text of [
    "",
    "P\tmissing",
    "F\tname\tabbr",
    "P\tname\t",
    "P\tUSB\tusb\nBAD",
  ])
    expect(() =>
      parseFieldDiscovery(
        text,
        inspectPacketFieldsInputSchema.parse({ limit: 1 }),
      ),
    ).toThrow();
});

it("ends an explicit full page at the record budget and continues it from offset + returned", () => {
  const text = "P\t" + "Long name ".repeat(30) + "\tabbr\n";
  const glossary = text.repeat(6000);
  // Each record is charged six bytes per source byte plus 512 bytes.
  const perPage = Math.floor(
    FIELD_RECORD_BUDGET / ((Buffer.byteLength(text) - 1) * 6 + 512),
  );
  const first = parseFieldDiscovery(
    glossary,
    inspectPacketFieldsInputSchema.parse({ limit: null }),
  );
  expect(first.output_window).toEqual({
    examined: 6000,
    matching: 6000,
    returned: perPage,
    has_more: true,
    record_budget_reached: true,
  });
  const rest = parseFieldDiscovery(
    glossary,
    inspectPacketFieldsInputSchema.parse({ offset: perPage, limit: null }),
  );
  expect(rest.output_window).toEqual({
    examined: 6000,
    matching: 6000,
    returned: 6000 - perPage,
    has_more: false,
    record_budget_reached: false,
  });
  expect(rest.records[0]?.source_line).toBe(perPage + 1);
});

it("returns one record above the record budget alone", () => {
  const name = "n".repeat(Math.ceil(FIELD_RECORD_BUDGET / 6));
  const result = parseFieldDiscovery(
    `P\t${name}\tbig\nP\tsmall\tsmall\n`,
    inspectPacketFieldsInputSchema.parse({ limit: null }),
  );
  expect(result.records.map((record) => record.abbreviation)).toEqual(["big"]);
  expect(result.output_window).toMatchObject({
    returned: 1,
    has_more: true,
    record_budget_reached: true,
  });
});
