import { describe, expect, it } from "vitest";

import {
  inspectPacketFieldsInputSchema,
  type InspectPacketFieldsInput,
} from "../domain/captures/packetFields.js";
import {
  parseFieldDiscovery,
  parseFieldGlossary,
  selectFieldRecords,
  FIELD_GLOSSARY_CACHE_RECORDS_LIMIT,
  FIELD_GLOSSARY_CACHE_SOURCE_BYTES_LIMIT,
} from "./parseFieldDiscovery.js";
import { ParseFailureError } from "../domain/parseFailure.js";

const GLOSSARY = [
  "P\tframe\tframe",
  "P\tip\tip",
  "P\ttcp\ttcp",
  "F\tip.addr\tip.addr\tFT_IPv4\tip\t0x0\t0\tSource or Destination Address",
  "F\tip.src\tip.src\tFT_IPv4\tip\t0x0\t0\tSource Address",
  "F\tip.dst\tip.dst\tFT_IPv4\tip\t0x0\t0\tDestination Address",
  "F\ttcp.port\ttcp.port\tFT_UINT16\ttcp\t0x0\t0\tSource or Destination Port",
  "F\ttcp.srcport\ttcp.srcport\tFT_UINT16\ttcp\t0x0\t0\tSource Port",
].join("\n");

const input = (
  overrides: Partial<InspectPacketFieldsInput> = {},
): InspectPacketFieldsInput => inspectPacketFieldsInputSchema.parse(overrides);

describe("parseFieldDiscovery", () => {
  it("returns the first page of protocols by default", () => {
    const result = parseFieldDiscovery(GLOSSARY, input());
    expect(result.records.map((record) => record.abbreviation)).toEqual([
      "frame",
      "ip",
      "tcp",
    ]);
    expect(result.output_window).toEqual({
      examined: 3,
      matching: 3,
      returned: 3,
      has_more: false,
      record_budget_reached: false,
    });
  });

  it("pages fields across requests", () => {
    const first = parseFieldDiscovery(
      GLOSSARY,
      input({ kind: "fields", limit: 2, offset: 0 }),
    );
    expect(first.records.map((record) => record.abbreviation)).toEqual([
      "ip.addr",
      "ip.src",
    ]);
    expect(first.output_window).toEqual({
      examined: 5,
      matching: 5,
      returned: 2,
      has_more: true,
      record_budget_reached: false,
    });
    const rest = parseFieldDiscovery(
      GLOSSARY,
      input({ kind: "fields", limit: 2, offset: 4 }),
    );
    expect(rest.records.map((record) => record.abbreviation)).toEqual([
      "tcp.srcport",
    ]);
    expect(rest.output_window.has_more).toBe(false);
  });

  it("filters by protocol and case-insensitive literal query", () => {
    const byProtocol = parseFieldDiscovery(
      GLOSSARY,
      input({ kind: "fields", protocol: "ip" }),
    );
    expect(byProtocol.records.map((record) => record.abbreviation)).toEqual([
      "ip.addr",
      "ip.src",
      "ip.dst",
    ]);
    expect(byProtocol.output_window.examined).toBe(5);
    const byQuery = parseFieldDiscovery(
      GLOSSARY,
      input({ kind: "fields", query: "SOURCE" }),
    );
    expect(byQuery.records.map((record) => record.abbreviation)).toEqual([
      "ip.addr",
      "ip.src",
      "tcp.port",
      "tcp.srcport",
    ]);
  });

  it("selects from parsed records identically to the single-pass scan", () => {
    const records = parseFieldGlossary(GLOSSARY);
    for (const overrides of [
      {},
      { kind: "fields" as const, limit: 2, offset: 1 },
      { kind: "fields" as const, protocol: "tcp", query: "port" },
      { kind: "protocols" as const, query: "t" },
      { kind: "fields" as const, limit: null },
    ]) {
      const parsed = input(overrides);
      expect(selectFieldRecords(records, parsed)).toEqual(
        parseFieldDiscovery(GLOSSARY, parsed),
      );
    }
  });

  it("does not leak the retained source-line size into returned records", () => {
    const result = parseFieldDiscovery(
      GLOSSARY,
      input({ kind: "fields", limit: 1 }),
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).not.toHaveProperty("sourceByteLength");
    expect(parseFieldGlossary(GLOSSARY)[0]).toHaveProperty("sourceByteLength");
  });

  it("ends the page at the record budget and reports it", () => {
    const wide = (index: number) =>
      `F\tx.y${index}\tx.y${index}\tFT_STRING\tx\t0x0\t0\t${"a".repeat(1_500_000)}`;
    const result = parseFieldDiscovery(
      [wide(1), wide(2)].join("\n"),
      input({ kind: "fields" }),
    );
    // The first record is always returned; the second would exceed the
    // 8 MiB page budget, so the page ends early and says so.
    expect(result.records.map((record) => record.abbreviation)).toEqual([
      "x.y1",
    ]);
    expect(result.output_window).toEqual({
      examined: 2,
      matching: 2,
      returned: 1,
      has_more: true,
      record_budget_reached: true,
    });
  });

  it("rejects malformed and empty glossaries", () => {
    expect(() => parseFieldDiscovery("P\tbroken", input())).toThrow(
      /Malformed TShark field glossary record at line 1/,
    );
    expect(() => parseFieldDiscovery("", input())).toThrow(
      "TShark returned an empty field glossary",
    );
  });
});

/** Captures what a parse attempt throws, or undefined when it succeeds. */
const parseFailureOf = (run: () => unknown): unknown => {
  try {
    run();
  } catch (cause: unknown) {
    return cause;
  }
  return undefined;
};

describe("parseFieldGlossary retention caps", () => {
  it("raises a limit parse failure over the record cap", () => {
    const many = Array.from(
      { length: 5 },
      (_, index) => `P\tp${index}\tp${index}`,
    ).join("\n");
    const failure = parseFailureOf(() =>
      parseFieldGlossary(many, {
        maxSourceBytes: 1_000_000,
        maxRecords: 3,
      }),
    );
    expect(failure).toBeInstanceOf(ParseFailureError);
    expect(failure).toMatchObject({
      kind: "limit",
      failure: { limit: { name: FIELD_GLOSSARY_CACHE_RECORDS_LIMIT } },
    });
  });

  it("raises a limit parse failure over the source-bytes cap", () => {
    const big = `F\tx.y\tx.y\tFT_STRING\tx\t0x0\t0\t${"a".repeat(100)}`;
    const failure = parseFailureOf(() =>
      parseFieldGlossary(big, {
        maxSourceBytes: 10,
        maxRecords: 1_000_000,
      }),
    );
    expect(failure).toBeInstanceOf(ParseFailureError);
    expect(failure).toMatchObject({
      kind: "limit",
      failure: { limit: { name: FIELD_GLOSSARY_CACHE_SOURCE_BYTES_LIMIT } },
    });
  });

  it("parses a glossary within the caps", () => {
    expect(
      parseFieldGlossary(GLOSSARY, {
        maxSourceBytes: 1_000_000,
        maxRecords: 100,
      }),
    ).toHaveLength(8);
  });

  it("still answers one page from an oversized glossary without retaining it", () => {
    const wide = Array.from(
      { length: 10 },
      (_, index) =>
        `F\tp.f${index}\tp.f${index}\tFT_STRING\tp\t0x0\t0\tdesc ${index}`,
    ).join("\n");
    expect(() =>
      parseFieldGlossary(wide, {
        maxSourceBytes: 1_000_000,
        maxRecords: 3,
      }),
    ).toThrow(ParseFailureError);
    const page = parseFieldDiscovery(
      wide,
      input({ kind: "fields", limit: 2, offset: 1 }),
    );
    expect(page.records.map((record) => record.abbreviation)).toEqual([
      "p.f1",
      "p.f2",
    ]);
    expect(page.output_window.matching).toBe(10);
  });
});
