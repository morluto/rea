import { expect, it } from "vitest";
import {
  elfEhPointerEncodingName,
  elfUnwindRangesSchema,
  inspectElfUnwindRangesInputSchema,
} from "./elfUnwindRanges.js";

it("names DW_EH_PE encodings without dropping application or indirect bits", () => {
  expect(elfEhPointerEncodingName(0x1b)).toBe("pcrel|sdata4");
  expect(elfEhPointerEncodingName(0x9b)).toBe("pcrel|sdata4|indirect");
  expect(elfEhPointerEncodingName(0x3b)).toBe("datarel|sdata4");
  expect(elfEhPointerEncodingName(0x03)).toBe("udata4");
  expect(elfEhPointerEncodingName(0)).toBe("absptr");
  expect(elfEhPointerEncodingName(0xff)).toBe("omit");
});

it("rejects extra caller arguments and admits an empty unwind inventory", () => {
  expect(
    inspectElfUnwindRangesInputSchema.safeParse({
      path: "/artifacts/app",
      extra: true,
    }).success,
  ).toBe(false);
  const parsed = inspectElfUnwindRangesInputSchema.parse({
    path: "/artifacts/app",
  });
  expect(parsed.max_ranges).toBe(8192);
  expect(parsed.limit).toBe(256);
  const report = elfUnwindRangesSchema.parse({
    artifact: {
      path: "/artifacts/app",
      sha256: "a".repeat(64),
      bytes: 512,
    },
    format: "elf64",
    byte_order: "little",
    machine: 62,
    type: 3,
    type_name: "shared",
    eh_frame: { status: "absent", source: null, location: null },
    eh_frame_hdr: {
      status: "absent",
      location: null,
      version: null,
      eh_frame_pointer_encoding: null,
      fde_count_encoding: null,
      table_encoding: null,
      eh_frame_pointer: null,
      fde_count: null,
      table_entries: 0,
    },
    debug_frame: { status: "absent", location: null },
    cies: [],
    ranges: [],
    page: {
      offset: 0,
      limit: 256,
      returned: 0,
      total: 0,
      next_offset: null,
    },
    coverage: {
      status: "complete",
      total_ranges: 0,
      total_cies: 0,
      ranges_with_symbols: 0,
      ranges_without_symbols: 0,
      eh_frame_hdr_agreement: "unavailable",
      examined_records: 0,
    },
    limitations: ["CFA instructions are counted but not evaluated."],
  });
  expect(report.ranges).toEqual([]);
  expect(report.coverage.total_ranges).toBe(0);
});
