import { expect, it } from "vitest";

import {
  MACHO_FUNCTION_STARTS_ENTRY_BUDGET,
  inspectMachoFunctionStartsInputSchema,
  machoFunctionStartsEntryLimit,
  machoFunctionStartsHasIssues,
  machoFunctionStartsSchema,
  type MachoFunctionStarts,
} from "./machoFunctionStarts.js";

const absent = {
  status: "absent" as const,
  dataoff: null,
  datasize: null,
  file_offset: null,
  in_linkedit: null,
};

const counters = {
  duplicate_commands: 0,
  mis_sized_commands: 0,
  outside_linkedit: 0,
  truncated_commands: 0,
  uleb_truncated: 0,
  uleb_overflow: 0,
  non_monotonic: 0,
  out_of_text: 0,
  missing_text_anchor: 0,
  text_not_at_header: 0,
  unterminated_starts: 0,
  trailing_nonzero: 0,
  data_trailing_bytes: 0,
  section_crossings: 0,
  unsorted_data: 0,
  unmapped_data: 0,
  zero_length_data: 0,
};

const report = (): MachoFunctionStarts => ({
  artifact: {
    path: "/artifacts/program",
    sha256: "a".repeat(64),
    bytes: 32,
  },
  format: "macho",
  architecture: "arm64",
  bits: 64,
  byte_order: "little",
  function_starts: absent,
  data_in_code: absent,
  coverage: {
    status: "complete",
    total_starts: 0,
    total_data_in_code: 0,
    ...counters,
  },
  page: {
    kind: "all",
    offset: 0,
    limit: 64,
    returned_starts: 0,
    total_starts: 0,
    next_starts_offset: null,
    returned_data: 0,
    total_data: 0,
    next_data_offset: null,
  },
  starts: [],
  data_in_code_entries: [],
  limitations: ["observed"],
});

it("defaults the per-call entry budget, page and read allowance", () => {
  expect(
    inspectMachoFunctionStartsInputSchema.parse({
      path: "/artifacts/program",
    }),
  ).toMatchObject({
    max_entries: MACHO_FUNCTION_STARTS_ENTRY_BUDGET.default_value,
    max_file_bytes: 67_108_864,
    kind: "all",
    offset: 0,
    limit: 64,
  });
  expect(machoFunctionStartsEntryLimit(5)).toEqual({
    control_kind: "parameter",
    parameter: "max_entries",
    effective_value: 5,
    unit: "count",
    minimum: 1,
    maximum: 16_777_216,
    default_value: 2_097_152,
    applies_at: "next_call",
  });
});

it("accepts a quiet report and rejects a start address that is not hex", () => {
  const value = report();
  expect(machoFunctionStartsHasIssues(value.coverage)).toBe(false);
  expect(
    machoFunctionStartsHasIssues({ ...value.coverage, out_of_text: 1 }),
  ).toBe(true);
  expect(machoFunctionStartsSchema.parse(value)).toEqual(value);
  expect(
    machoFunctionStartsSchema.safeParse({
      ...value,
      starts: [{ index: 0, vmaddr: "1000", section: "__text", issues: [] }],
    }).success,
  ).toBe(false);
});
