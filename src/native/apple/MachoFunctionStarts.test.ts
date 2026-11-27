import { expect, it } from "vitest";

import { bufferByteSource } from "../../domain/byteSource.js";
import { BinaryResourceFailure } from "../../domain/binaryContainer.js";
import {
  MACHO_FUNCTION_STARTS_LIMITATIONS as TEXT,
  inspectMachoFunctionStartsInputSchema,
  machoFunctionStartsSchema,
  type MachoFunctionStarts,
} from "../../domain/native/machoFunctionStarts.js";
import type { StableArtifactHandle } from "../../resources/index.js";
import {
  ARM64_DELTAS,
  MACHO_TEXT_BASE,
  X64_DELTAS,
  MACHO_ARM32_TEXT_BASE,
  arm64FunctionStartsImage,
  functionStartAddresses,
  machoArm32FunctionStartsImage,
  machoFunctionStartsImage,
  machoFunctionStartsUniversal,
  x64FunctionStartsImage,
} from "./MachoFunctionStarts.fixture.js";
import { parseMachoFunctionStartsFromHandle } from "./MachoFunctionStarts.js";

const SHA = "a".repeat(64);
const STANDING = [TEXT.missingStarts, TEXT.missingData, TEXT.static];
const hex = (value: bigint): string => `0x${value.toString(16)}`;
const ARM = functionStartAddresses(ARM64_DELTAS).map(hex);
const X64 = functionStartAddresses(X64_DELTAS).map(hex);

it("pins the fixture's expected starts to literal addresses", () => {
  // The decoder and `functionStartAddresses` both accumulate deltas, so the
  // shared expectation is checked once against hand-computed values.
  expect(ARM).toEqual(["0x100001000", "0x100001100", "0x100001200"]);
  expect(X64).toEqual(["0x100001000", "0x100001200"]);
});

const parse = (
  bytes: Buffer,
  raw: Readonly<Record<string, unknown>> = {},
  signal?: AbortSignal,
): Promise<MachoFunctionStarts> => {
  const input = inspectMachoFunctionStartsInputSchema.parse({
    path: "/artifacts/program",
    ...raw,
  });
  const source = bufferByteSource(bytes);
  const handle: StableArtifactHandle = {
    sha256: SHA,
    size: source.size,
    prefix: source.prefix,
    readRange: source.readRange,
  };
  return parseMachoFunctionStartsFromHandle(
    handle,
    { path: input.path, sha256: SHA, bytes: bytes.length },
    input,
    signal,
  );
};

const quiet = {
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

it("decodes arm64 and x86_64 starts, kinds and owning starts", async () => {
  const arm = machoFunctionStartsSchema.parse(
    await parse(arm64FunctionStartsImage()),
  );
  expect(arm).toMatchObject({
    format: "macho",
    architecture: "arm64",
    bits: 64,
    byte_order: "little",
    function_starts: {
      status: "present",
      dataoff: 0x4000,
      datasize: 11,
      file_offset: 0x4000,
      in_linkedit: true,
    },
    data_in_code: {
      status: "present",
      dataoff: 0x4200,
      datasize: 24,
      file_offset: 0x4200,
      in_linkedit: true,
    },
    coverage: {
      status: "complete",
      total_starts: 3,
      total_data_in_code: 3,
      ...quiet,
    },
    limitations: STANDING,
  });
  expect(arm.selected_slice).toBeUndefined();
  expect(arm.starts).toEqual([
    { index: 0, vmaddr: ARM[0], section: "__text", issues: [] },
    { index: 1, vmaddr: ARM[1], section: "__text", issues: [] },
    { index: 2, vmaddr: ARM[2], section: "__text", issues: [] },
  ]);
  expect(arm.data_in_code_entries).toEqual([
    {
      index: 0,
      offset: 0x1080,
      vmaddr: hex(MACHO_TEXT_BASE + 0x1080n),
      length: 8,
      kind: "DICE_KIND_DATA",
      section: "__text",
      owner: { index: 0, vmaddr: ARM[0] },
      issues: [],
    },
    {
      index: 1,
      offset: 0x1120,
      vmaddr: hex(MACHO_TEXT_BASE + 0x1120n),
      length: 4,
      kind: "JUMP_TABLE8",
      section: "__text",
      owner: { index: 1, vmaddr: ARM[1] },
      issues: [],
    },
    {
      index: 2,
      offset: 0x1210,
      vmaddr: hex(MACHO_TEXT_BASE + 0x1210n),
      length: 4,
      kind: 0x42,
      section: "__text",
      owner: { index: 2, vmaddr: ARM[2] },
      issues: [],
    },
  ]);

  const x64 = await parse(x64FunctionStartsImage());
  expect(x64.architecture).toBe("x86_64");
  expect(x64.starts.map((start) => start.vmaddr)).toEqual(X64);
  expect(x64.data_in_code_entries).toMatchObject([
    {
      offset: 0x1080,
      kind: "JUMP_TABLE16",
      owner: { index: 0, vmaddr: X64[0] },
    },
    {
      offset: 0x1220,
      kind: "ABS_JUMP_TABLE32",
      owner: { index: 1, vmaddr: X64[1] },
    },
  ]);
});

it("selects one slice of a universal file and keeps the other unread", async () => {
  const bytes = machoFunctionStartsUniversal(
    arm64FunctionStartsImage(),
    x64FunctionStartsImage(),
  );
  const arm = await parse(bytes, { architecture: "arm64" });
  expect(arm.selected_slice).toMatchObject({
    kind: "macho-selected-image-v1",
    container: "fat",
    offset: 0x1000,
    byte_length: 0x5000,
    cpu_type: 0x0100000c,
  });
  expect(arm.function_starts.file_offset).toBe(0x5000);
  expect(arm.data_in_code.file_offset).toBe(0x5200);
  expect(arm.starts.map((start) => start.vmaddr)).toEqual(ARM);
  expect(arm.coverage.status).toBe("complete");
  // The other slice is a different CPU family, so the shared selector records
  // no unread-slice limitation. Same-family leftovers would.
  expect(arm.limitations).toEqual(STANDING);

  const x64 = await parse(bytes, { architecture: "x86_64" });
  expect(x64.architecture).toBe("x86_64");
  expect(x64.selected_slice).toMatchObject({
    offset: 0x6000,
    cpu_type: 0x01000007,
  });
  expect(x64.function_starts.file_offset).toBe(0xa000);
  expect(x64.starts.map((start) => start.vmaddr)).toEqual(X64);
});

it("pages each table independently and still counts every entry", async () => {
  const bytes = arm64FunctionStartsImage();
  const page = await parse(bytes, { offset: 1, limit: 1 });
  expect(page.starts.map((start) => start.index)).toEqual([1]);
  expect(page.data_in_code_entries.map((entry) => entry.index)).toEqual([1]);
  expect(page.page).toMatchObject({
    kind: "all",
    offset: 1,
    limit: 1,
    returned_starts: 1,
    total_starts: 3,
    next_starts_offset: 2,
    returned_data: 1,
    total_data: 3,
    next_data_offset: 2,
  });
  const startsOnly = await parse(bytes, { kind: "starts", limit: 2 });
  expect(startsOnly.starts).toHaveLength(2);
  expect(startsOnly.data_in_code_entries).toEqual([]);
  expect(startsOnly.page).toMatchObject({
    next_starts_offset: 2,
    next_data_offset: null,
    total_data: 3,
  });
  const counts = await parse(bytes, { limit: 0 });
  expect(counts.starts).toEqual([]);
  expect(counts.data_in_code_entries).toEqual([]);
  expect(counts.page).toMatchObject({
    returned_starts: 0,
    returned_data: 0,
    next_starts_offset: 0,
    next_data_offset: 0,
  });
});

it("records an image with neither table as complete absence", async () => {
  const value = await parse(machoFunctionStartsImage());
  expect(value.function_starts.status).toBe("absent");
  expect(value.data_in_code.status).toBe("absent");
  expect(value.coverage).toMatchObject({
    status: "complete",
    total_starts: 0,
    total_data_in_code: 0,
    ...quiet,
  });
  expect(value.limitations).toEqual(STANDING);
});

it("keeps duplicate, truncated, wrapped and out-of-text tables as limitations", async () => {
  const duplicate = await parse(
    machoFunctionStartsImage({
      starts: { deltas: ARM64_DELTAS, duplicate: true },
    }),
  );
  expect(duplicate.coverage).toMatchObject({
    status: "partial",
    total_starts: 3,
    duplicate_commands: 1,
  });
  expect(duplicate.starts.map((start) => start.vmaddr)).toEqual(ARM);
  expect(duplicate.limitations).toContain(TEXT.duplicateStarts);

  const truncated = await parse(
    machoFunctionStartsImage({ starts: { blob: Buffer.from([0x80]) } }),
  );
  expect(truncated.coverage).toMatchObject({
    status: "partial",
    total_starts: 0,
    uleb_truncated: 1,
  });
  expect(truncated.limitations).toContain(TEXT.ulebTruncated);

  const overflow = await parse(
    machoFunctionStartsImage({ starts: { blob: Buffer.alloc(10, 0xff) } }),
  );
  expect(overflow.coverage).toMatchObject({
    total_starts: 0,
    uleb_overflow: 1,
    uleb_truncated: 0,
  });
  expect(overflow.limitations).toContain(TEXT.ulebOverflow);

  const wrapped = await parse(
    machoFunctionStartsImage({
      starts: {
        deltas: [0x1000n, (1n << 64n) - (MACHO_TEXT_BASE + 0x1000n), 0x10n],
      },
    }),
  );
  expect(wrapped.starts).toEqual([
    { index: 0, vmaddr: ARM[0], section: "__text", issues: [] },
    {
      index: 1,
      vmaddr: "0x0",
      section: null,
      issues: ["wrapped", "out_of_text"],
    },
  ]);
  expect(wrapped.coverage).toMatchObject({
    status: "partial",
    total_starts: 2,
    non_monotonic: 1,
    out_of_text: 1,
  });
  expect(wrapped.limitations).toEqual(
    expect.arrayContaining([TEXT.wrapped, TEXT.outOfText]),
  );

  const outside = await parse(
    machoFunctionStartsImage({ starts: { deltas: [0x5000n, 0x10n] } }),
  );
  expect(outside.starts).toEqual([
    {
      index: 0,
      vmaddr: hex(MACHO_TEXT_BASE + 0x5000n),
      section: null,
      issues: ["out_of_text"],
    },
  ]);
  expect(outside.coverage).toMatchObject({
    total_starts: 1,
    out_of_text: 1,
    non_monotonic: 0,
  });
});

it("counts shape and range issues across duplicate linkedit commands while decoding the first", async () => {
  const firstRecord = {
    status: "present" as const,
    dataoff: 0x4000,
    datasize: 7,
    file_offset: 0x4000,
    in_linkedit: true,
  };

  const misSizedDup = await parse(
    machoFunctionStartsImage({
      starts: { deltas: ARM64_DELTAS, duplicate: { commandSize: 24 } },
    }),
  );
  expect(misSizedDup.function_starts).toEqual(firstRecord);
  expect(misSizedDup.starts.map((start) => start.vmaddr)).toEqual(ARM);
  expect(misSizedDup.coverage).toMatchObject({
    status: "partial",
    total_starts: 3,
    duplicate_commands: 1,
    mis_sized_commands: 1,
    outside_linkedit: 0,
    truncated_commands: 0,
  });
  expect(misSizedDup.limitations).toEqual(
    expect.arrayContaining([TEXT.duplicateStarts, TEXT.misSizedStarts]),
  );

  const outsideDup = await parse(
    machoFunctionStartsImage({
      starts: { deltas: ARM64_DELTAS, duplicate: { offset: 0x2000 } },
    }),
  );
  expect(outsideDup.function_starts).toEqual(firstRecord);
  expect(outsideDup.starts.map((start) => start.vmaddr)).toEqual(ARM);
  expect(outsideDup.coverage).toMatchObject({
    status: "partial",
    total_starts: 3,
    duplicate_commands: 1,
    mis_sized_commands: 0,
    outside_linkedit: 1,
    truncated_commands: 0,
  });
  expect(outsideDup.limitations).toEqual(
    expect.arrayContaining([TEXT.duplicateStarts, TEXT.outsideStarts]),
  );

  const pastFileDup = await parse(
    machoFunctionStartsImage({
      starts: { deltas: ARM64_DELTAS, duplicate: { declaredSize: 0x2000 } },
    }),
  );
  expect(pastFileDup.function_starts).toEqual(firstRecord);
  expect(pastFileDup.starts.map((start) => start.vmaddr)).toEqual(ARM);
  expect(pastFileDup.coverage).toMatchObject({
    status: "partial",
    total_starts: 3,
    duplicate_commands: 1,
    mis_sized_commands: 0,
    outside_linkedit: 1,
    truncated_commands: 1,
  });
  expect(pastFileDup.limitations).toEqual(
    expect.arrayContaining([
      TEXT.duplicateStarts,
      TEXT.outsideStarts,
      TEXT.startsPastFile,
    ]),
  );

  const overlappingDup = await parse(
    machoFunctionStartsImage({
      starts: {
        deltas: ARM64_DELTAS,
        duplicate: { commandSize: 24, offset: 0x2000, declaredSize: 0x4000 },
      },
    }),
  );
  expect(overlappingDup.function_starts).toEqual(firstRecord);
  expect(overlappingDup.starts.map((start) => start.vmaddr)).toEqual(ARM);
  expect(overlappingDup.coverage).toMatchObject({
    status: "partial",
    total_starts: 3,
    duplicate_commands: 1,
    mis_sized_commands: 1,
    outside_linkedit: 1,
    truncated_commands: 1,
  });
  expect(overlappingDup.limitations).toEqual(
    expect.arrayContaining([
      TEXT.duplicateStarts,
      TEXT.misSizedStarts,
      TEXT.outsideStarts,
      TEXT.startsPastFile,
    ]),
  );
});

it("handles short null-range linkedit commands and duplicate LC_DATA_IN_CODE counters", async () => {
  const shortDup = await parse(
    machoFunctionStartsImage({
      starts: { deltas: ARM64_DELTAS, duplicate: { commandSize: 8 } },
    }),
  );
  expect(shortDup.function_starts).toEqual({
    status: "present",
    dataoff: 0x4000,
    datasize: 7,
    file_offset: 0x4000,
    in_linkedit: true,
  });
  expect(shortDup.starts.map((start) => start.vmaddr)).toEqual(ARM);
  expect(shortDup.coverage).toMatchObject({
    status: "partial",
    total_starts: 3,
    duplicate_commands: 1,
    mis_sized_commands: 1,
    outside_linkedit: 0,
    truncated_commands: 0,
  });

  const shortFirstWithBadDup = await parse(
    machoFunctionStartsImage({
      starts: {
        deltas: ARM64_DELTAS,
        commandSize: 8,
        duplicate: { commandSize: 24, offset: 0x2000, declaredSize: 0x4000 },
      },
    }),
  );
  expect(shortFirstWithBadDup.function_starts).toEqual({
    status: "present",
    dataoff: null,
    datasize: null,
    file_offset: null,
    in_linkedit: null,
  });
  expect(shortFirstWithBadDup.starts).toEqual([]);
  expect(shortFirstWithBadDup.coverage).toMatchObject({
    status: "partial",
    total_starts: 0,
    duplicate_commands: 1,
    mis_sized_commands: 2,
    outside_linkedit: 1,
    truncated_commands: 1,
  });

  const badDataDup = await parse(
    machoFunctionStartsImage({
      starts: { deltas: ARM64_DELTAS },
      data: {
        entries: [{ offset: 0x1080, length: 8, kind: 1 }],
        duplicate: { commandSize: 24, offset: 0x2000, declaredSize: 0x4000 },
      },
    }),
  );
  expect(badDataDup.data_in_code).toEqual({
    status: "present",
    dataoff: 0x4200,
    datasize: 8,
    file_offset: 0x4200,
    in_linkedit: true,
  });
  expect(badDataDup.data_in_code_entries).toHaveLength(1);
  expect(badDataDup.coverage).toMatchObject({
    status: "partial",
    total_data_in_code: 1,
    duplicate_commands: 1,
    mis_sized_commands: 1,
    outside_linkedit: 1,
    truncated_commands: 1,
  });
  expect(badDataDup.limitations).toEqual(
    expect.arrayContaining([
      TEXT.duplicateData,
      TEXT.misSizedData,
      TEXT.outsideData,
      TEXT.dataPastFile,
    ]),
  );
});

it("flags linkedit placement, anchors, padding and data-in-code shape", async () => {
  const misplaced = await parse(
    machoFunctionStartsImage({
      starts: { deltas: ARM64_DELTAS, offset: 0x2000 },
    }),
  );
  expect(misplaced.function_starts).toMatchObject({
    dataoff: 0x2000,
    in_linkedit: false,
  });
  expect(misplaced.starts).toHaveLength(3);
  expect(misplaced.coverage.outside_linkedit).toBe(1);
  expect(misplaced.limitations).toContain(TEXT.outsideStarts);

  const wide = await parse(
    machoFunctionStartsImage({
      starts: { deltas: ARM64_DELTAS, commandSize: 24 },
    }),
  );
  expect(wide.starts).toHaveLength(3);
  expect(wide.coverage.mis_sized_commands).toBe(1);
  expect(wide.limitations).toContain(TEXT.misSizedStarts);

  const unanchored = await parse(
    machoFunctionStartsImage({
      omitText: true,
      starts: { deltas: ARM64_DELTAS },
    }),
  );
  expect(unanchored.coverage).toMatchObject({
    total_starts: 0,
    missing_text_anchor: 1,
  });
  expect(unanchored.limitations).toContain(TEXT.missingText);

  const trailing = await parse(
    machoFunctionStartsImage({
      starts: { deltas: ARM64_DELTAS, trailingByte: 0x7f },
    }),
  );
  expect(trailing.coverage.trailing_nonzero).toBe(1);
  expect(trailing.limitations).toContain(TEXT.trailing);

  const past = await parse(
    machoFunctionStartsImage({
      starts: { deltas: ARM64_DELTAS, declaredSize: 0x2000 },
    }),
  );
  expect(past.starts).toHaveLength(3);
  expect(past.coverage.truncated_commands).toBe(1);
  expect(past.limitations).toContain(TEXT.startsPastFile);

  const data = await parse(
    machoFunctionStartsImage({
      starts: { deltas: ARM64_DELTAS },
      data: {
        entries: [
          { offset: 0x17f8, length: 16, kind: 1 },
          { offset: 0x1100, length: 0, kind: 4 },
          { offset: 0x6000, length: 4, kind: 3 },
          { offset: 0x800, length: 4, kind: 1 },
        ],
        trailing: 3,
      },
    }),
  );
  expect(data.data_in_code_entries).toMatchObject([
    { offset: 0x17f8, section: "__text", issues: ["crosses_section"] },
    {
      offset: 0x1100,
      kind: "JUMP_TABLE32",
      issues: ["out_of_order", "zero_length"],
    },
    { offset: 0x6000, vmaddr: null, owner: null, issues: ["unmapped"] },
    {
      offset: 0x800,
      section: null,
      owner: null,
      issues: ["out_of_order", "crosses_section"],
    },
  ]);
  expect(data.coverage).toMatchObject({
    status: "partial",
    total_data_in_code: 4,
    data_trailing_bytes: 3,
    section_crossings: 2,
    unsorted_data: 2,
    unmapped_data: 1,
    zero_length_data: 1,
  });
  expect(data.limitations).toEqual(
    expect.arrayContaining([
      TEXT.dataTrailing,
      TEXT.crosses,
      TEXT.unsorted,
      TEXT.zeroLength,
      TEXT.unmapped,
    ]),
  );
});

it("refuses a table above max_entries before returning a page", async () => {
  await expect(
    parse(arm64FunctionStartsImage(), { max_entries: 5 }),
  ).rejects.toMatchObject({
    name: "BinaryResourceFailure",
    maximum_bytes: 5,
    failure: { limit: { name: "entries", maximum: 5 } },
  });
  await expect(
    parse(arm64FunctionStartsImage(), { max_entries: 5 }),
  ).rejects.toBeInstanceOf(BinaryResourceFailure);
});

it("bounds decoding work by max_entries, not only the result", async () => {
  // 4000 starts and 4000 data entries; max_entries 10 must refuse without
  // examining either table in full. A data table larger than the allowance is
  // refused from its byte count alone, and the start walk stops at the
  // remaining allowance. Neither case measured the full total.
  const image = machoFunctionStartsImage({
    starts: { deltas: [0x1000n, ...Array.from({ length: 3999 }, () => 1n)] },
  });
  const startsOnly = await parse(image, { max_entries: 10, limit: 0 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(startsOnly).toBeInstanceOf(BinaryResourceFailure);
  expect(
    (startsOnly as BinaryResourceFailure).failure.limit,
  ).not.toHaveProperty("required");
  const many = Array.from({ length: 64 }, (_, index) => ({
    offset: 0x1000 + index * 4,
    length: 4,
    kind: 1,
  }));
  const dataOnly = await parse(
    machoFunctionStartsImage({ data: { entries: many } }),
    { max_entries: 10, limit: 0 },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  // With no LC_FUNCTION_STARTS, the data count is the measured total.
  expect(dataOnly).toMatchObject({
    name: "BinaryResourceFailure",
    failure: { limit: { name: "entries", maximum: 10, required: 64 } },
  });
  // With starts left uncounted, the total is unknown and not claimed.
  const both = await parse(
    machoFunctionStartsImage({
      starts: { deltas: [0x1000n] },
      data: { entries: many },
    }),
    { max_entries: 10, limit: 0 },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(both).toBeInstanceOf(BinaryResourceFailure);
  expect((both as BinaryResourceFailure).failure.limit).not.toHaveProperty(
    "required",
  );
  // At the allowance exactly, both tables still decode.
  const fits = await parse(
    machoFunctionStartsImage({
      starts: { deltas: [0x1000n, 4n] },
      data: { entries: many.slice(0, 8) },
    }),
    { max_entries: 10, limit: 0 },
  );
  expect(fits.coverage).toMatchObject({
    total_starts: 2,
    total_data_in_code: 8,
  });
});

it("does not let a wrapped start own later data-in-code entries", async () => {
  // [0x100001000, 0x0] stays in the start list. An entry at 0x100001080 must
  // keep index 0. The wrapped 0x0 must not own an earlier address either.
  const first = MACHO_TEXT_BASE + 0x1000n;
  const wrapped = await parse(
    machoFunctionStartsImage({
      starts: { deltas: [0x1000n, (1n << 64n) - first] },
      data: {
        entries: [
          { offset: 0x1080, length: 4, kind: 1 },
          { offset: 0x800, length: 4, kind: 1 },
        ],
      },
    }),
  );
  expect(wrapped.starts.map((start) => start.vmaddr)).toEqual([
    hex(first),
    "0x0",
  ]);
  expect(wrapped.data_in_code_entries).toMatchObject([
    {
      offset: 0x1080,
      vmaddr: hex(MACHO_TEXT_BASE + 0x1080n),
      owner: { index: 0, vmaddr: hex(first) },
    },
    {
      offset: 0x800,
      vmaddr: hex(MACHO_TEXT_BASE + 0x800n),
      owner: null,
    },
  ]);

  const second = MACHO_TEXT_BASE + 0x1100n;
  const later = await parse(
    machoFunctionStartsImage({
      starts: { deltas: [0x1000n, 0x100n, (1n << 64n) - second] },
      data: {
        entries: [
          { offset: 0x1080, length: 4, kind: 1 },
          { offset: 0x1120, length: 4, kind: 1 },
        ],
      },
    }),
  );
  expect(later.starts).toMatchObject([
    { index: 0, vmaddr: hex(first), issues: [] },
    { index: 1, vmaddr: hex(second), issues: [] },
    { index: 2, vmaddr: "0x0", issues: ["wrapped", "out_of_text"] },
  ]);
  expect(later.data_in_code_entries.map((entry) => entry.owner)).toEqual([
    { index: 0, vmaddr: hex(first) },
    { index: 1, vmaddr: hex(second) },
  ]);

  const onlyWrapped = await parse(
    machoFunctionStartsImage({
      starts: { deltas: [(1n << 64n) - MACHO_TEXT_BASE] },
      data: { entries: [{ offset: 0x1080, length: 4, kind: 1 }] },
    }),
  );
  expect(onlyWrapped.starts).toEqual([
    {
      index: 0,
      vmaddr: "0x0",
      section: null,
      issues: ["wrapped", "out_of_text"],
    },
  ]);
  expect(onlyWrapped.data_in_code_entries).toMatchObject([
    {
      offset: 0x1080,
      vmaddr: hex(MACHO_TEXT_BASE + 0x1080n),
      owner: null,
    },
  ]);
});

it("assigns each data-in-code entry the greatest start at or before it", async () => {
  // 3000 starts two bytes apart and 120 entries spread across them: a
  // per-entry scan of every start would do 360,000 comparisons.
  const deltas = [0x1000n, ...Array.from({ length: 2999 }, () => 2n)];
  const starts = functionStartAddresses(deltas);
  const entries = Array.from({ length: 120 }, (_, index) => ({
    offset: 0x1000 + index * 50 + 1,
    length: 1,
    kind: 1,
  }));
  const result = await parse(
    machoFunctionStartsImage({
      starts: { deltas },
      data: { entries, offset: 0x4c00 },
    }),
    { limit: 4096 },
  );
  expect(result.coverage.total_starts).toBe(3000);
  expect(result.data_in_code_entries.map((entry) => entry.owner)).toEqual(
    entries.map(({ offset }) => {
      const vmaddr = MACHO_TEXT_BASE + BigInt(offset);
      const index = starts.findLastIndex((start) => start <= vmaddr);
      return { index, vmaddr: hex(starts[index] as bigint) };
    }),
  );
  const before = await parse(
    machoFunctionStartsImage({
      starts: { deltas: [0x1100n] },
      data: { entries: [{ offset: 0x1080, length: 1, kind: 1 }] },
    }),
  );
  expect(before.data_in_code_entries[0]?.owner).toBeNull();
});

it("leaves data-in-code unmapped when the mach_header address is ambiguous", async () => {
  // Offsets are relative to the mach_header's address. A second segment maps
  // file offset 0 at another address, so that base is unknown.
  const result = await parse(
    machoFunctionStartsImage({
      data: { entries: [{ offset: 0x1080, length: 4, kind: 1 }] },
      extraSegments: [
        {
          name: "__ALIAS",
          address: 0x200000000n,
          memorySize: 0x1000,
          fileOffset: 0,
          fileSize: 0x1000,
          protection: 1,
        },
      ],
    }),
  );
  expect(result.data_in_code_entries).toMatchObject([
    { offset: 0x1080, vmaddr: null, owner: null, issues: ["unmapped"] },
  ]);
  expect(result.coverage).toMatchObject({
    status: "partial",
    unmapped_data: 1,
  });
  expect(result.limitations).toContain(TEXT.unmapped);
});

it("reads data-in-code offsets as header-relative addresses, not file offsets", async () => {
  // ld64 writes an entry's address minus the mach_header address. A segment
  // whose file bytes sit elsewhere therefore does not move the entry; the
  // reverse file mapping would have reported 0x100002080.
  const linked = await parse(
    machoFunctionStartsImage({
      data: { entries: [{ offset: 0x2000, length: 4, kind: 1 }] },
      textFileSize: 0x2000,
      extraSegments: [
        {
          name: "__CONST",
          address: MACHO_TEXT_BASE + 0x4000n,
          memorySize: 0x1000,
          fileOffset: 0x2000,
          fileSize: 0x1000,
          protection: 1,
        },
      ],
    }),
  );
  expect(linked.data_in_code_entries[0]).toMatchObject({
    offset: 0x2000,
    vmaddr: hex(MACHO_TEXT_BASE + 0x2000n),
  });

  // MH_OBJECT does not map its header, so the offset is the address itself.
  // A clang object places the code section at VM 0x0 and file offset 0x148.
  const object = await parse(
    machoFunctionStartsImage({
      fileType: 1,
      omitText: true,
      omitLinkedit: true,
      extraSegments: [
        {
          name: "",
          address: 0n,
          memorySize: 0x400,
          fileOffset: 0x148,
          fileSize: 0x400,
          protection: 7,
        },
      ],
      data: { entries: [{ offset: 0x204, length: 4, kind: 1 }] },
    }),
  );
  expect(object.data_in_code_entries[0]).toMatchObject({
    offset: 0x204,
    vmaddr: "0x204",
  });
  expect(object.data_in_code_entries[0]!.issues).not.toContain("unmapped");
  // clang places an object's link-edit data after its sections, outside any
  // segment, so the table is not in __LINKEDIT and that is not an issue.
  expect(object.data_in_code).toMatchObject({ in_linkedit: false });
  expect(object.coverage.outside_linkedit).toBe(0);
  expect(object.limitations).not.toContain(TEXT.outsideData);
  // A linked image still reports a table outside its __LINKEDIT.
  const linkedOutside = await parse(
    machoFunctionStartsImage({
      data: {
        entries: [{ offset: 0x1080, length: 4, kind: 1 }],
        offset: 0x100,
      },
    }),
  );
  expect(linkedOutside.coverage.outside_linkedit).toBe(1);
});

it("keeps an empty section name instead of rejecting the report", async () => {
  const report = machoFunctionStartsSchema.parse(
    await parse(
      machoFunctionStartsImage({
        textSectionName: "",
        starts: { deltas: [0x1000n] },
        data: { entries: [{ offset: 0x1080, length: 4, kind: 1 }] },
      }),
    ),
  );
  expect(report.starts[0]!.section).toBe("");
  expect(report.data_in_code_entries[0]!.section).toBe("");
});

it("reports a list without its zero terminator as cut off", async () => {
  const report = await parse(
    machoFunctionStartsImage({
      starts: { deltas: [0x1000n, 0x100n], terminator: false },
    }),
  );
  expect(report.coverage).toMatchObject({
    status: "partial",
    total_starts: 2,
    unterminated_starts: 1,
    uleb_truncated: 0,
  });
  expect(report.limitations).toContain(TEXT.unterminated);
  const terminated = await parse(arm64FunctionStartsImage());
  expect(terminated.coverage.unterminated_starts).toBe(0);
});

it("disputes the delta base when SG_HIGHVM moves the mach_header", async () => {
  // SG_HIGHVM maps the file bytes at the top of the segment, so the header
  // sits at vmaddr + (vmsize - filesize), not at the __TEXT vmaddr.
  const report = await parse(
    machoFunctionStartsImage({
      textFlags: 0x1,
      textFileSize: 0x3000,
      starts: { deltas: [0x1000n] },
    }),
  );
  expect(report.coverage).toMatchObject({
    status: "partial",
    text_not_at_header: 1,
  });
  expect(report.limitations).toContain(TEXT.textNotAtHeader);
});

it("stops decoding data-in-code entries when the read is cancelled", async () => {
  // No starts, so only the data-in-code decode yields and observes the abort.
  const entries = Array.from({ length: 5000 }, (_, index) => ({
    offset: 0x1000 + (index % 0x800),
    length: 1,
    kind: 1,
  }));
  const bytes = machoFunctionStartsImage({
    data: { entries, offset: 0x5000 },
    fileBytes: 0x5000 + entries.length * 8,
  });
  const controller = new AbortController();
  const pending = parse(bytes, {}, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    name: "ArtifactReaderFailure",
  });
  await expect(parse(bytes)).resolves.toMatchObject({
    coverage: { total_data_in_code: 5000 },
  });
});

it("clears the Thumb tag from armv7 starts and reports it separately", async () => {
  // ld64 encodes Thumb starts with bit 0 set and takes each delta from the
  // tagged value: 0x2001, 0x2021, then the ARM start 0x2040. LLDB reports the
  // code addresses 0x2000, 0x2020 and 0x2040.
  const base = BigInt(MACHO_ARM32_TEXT_BASE);
  const report = machoFunctionStartsSchema.parse(
    await parse(machoArm32FunctionStartsImage([0x2001n - base, 0x20n, 0x1fn])),
  );
  expect(report).toMatchObject({ architecture: "arm", bits: 32 });
  expect(report.coverage).toEqual({
    status: "complete",
    total_starts: 3,
    total_data_in_code: 0,
    ...quiet,
  });
  expect(report.starts).toEqual([
    { index: 0, vmaddr: "0x2000", thumb: true, section: null, issues: [] },
    { index: 1, vmaddr: "0x2020", thumb: true, section: null, issues: [] },
    { index: 2, vmaddr: "0x2040", thumb: false, section: null, issues: [] },
  ]);
  // Other architectures carry no ISA tag, so they omit the field.
  const arm64 = await parse(arm64FunctionStartsImage());
  expect(arm64.starts.every((start) => !("thumb" in start))).toBe(true);
});

it("anchors deltas on a declared __TEXT with no file bytes", async () => {
  // llvm-objdump takes the first __TEXT segment command's vmaddr whether or
  // not it maps file bytes. Code lives in a file-backed __TEXT_EXEC.
  const exec = MACHO_TEXT_BASE + 0x10000n;
  const report = await parse(
    machoFunctionStartsImage({
      textFileSize: 0,
      extraSegments: [
        {
          name: "__TEXT_EXEC",
          address: exec,
          memorySize: 0x1000,
          fileOffset: 0x1000,
          fileSize: 0x1000,
          protection: 5,
        },
      ],
      starts: { deltas: [0x10000n, 0x40n] },
    }),
  );
  // dyld would add the deltas to the mach_header address instead, and this
  // __TEXT does not map it, so the base is reported as disputed.
  expect(report.coverage).toMatchObject({
    status: "partial",
    total_starts: 2,
    missing_text_anchor: 0,
    text_not_at_header: 1,
    out_of_text: 0,
  });
  expect(report.limitations).toContain(TEXT.textNotAtHeader);
  expect(report.starts.map((start) => start.vmaddr)).toEqual([
    hex(exec),
    hex(exec + 0x40n),
  ]);
  // The usual layout, __TEXT mapping file offset 0, is not disputed.
  const usual = await parse(arm64FunctionStartsImage());
  expect(usual.coverage.text_not_at_header).toBe(0);
  expect(usual.limitations).not.toContain(TEXT.textNotAtHeader);
});

it("builds only the requested page and still resolves owners on later pages", async () => {
  const deltas = [0x1000n, ...Array.from({ length: 299 }, () => 4n)];
  const entries = Array.from({ length: 50 }, (_, index) => ({
    offset: 0x1000 + index * 24 + 2,
    length: 2,
    kind: 1,
  }));
  const image = machoFunctionStartsImage({
    starts: { deltas },
    data: { entries },
  });
  const counts = await parse(image, { limit: 0 });
  expect(counts.starts).toEqual([]);
  expect(counts.data_in_code_entries).toEqual([]);
  expect(counts.coverage).toMatchObject({
    total_starts: 300,
    total_data_in_code: 50,
  });
  const page = await parse(image, { offset: 40, limit: 5 });
  expect(page.starts.map((start) => start.index)).toEqual([40, 41, 42, 43, 44]);
  expect(page.starts[0]!.vmaddr).toBe(hex(MACHO_TEXT_BASE + 0x1000n + 160n));
  // Entry k sits at 0x1000 + 24k + 2, so its owner is start 6k.
  expect(
    page.data_in_code_entries.map((entry) => [entry.index, entry.owner]),
  ).toEqual(
    [40, 41, 42, 43, 44].map((index) => [
      index,
      {
        index: index * 6,
        vmaddr: hex(MACHO_TEXT_BASE + 0x1000n + BigInt(index * 24)),
      },
    ]),
  );
  // The same entries are found whatever the page size.
  const whole = await parse(image, { limit: 4096 });
  expect(whole.data_in_code_entries.slice(40, 45)).toEqual(
    page.data_in_code_entries,
  );
  expect(whole.starts.slice(40, 45)).toEqual(page.starts);
});

it("checks starts against many executable segments with one index lookup each", async () => {
  // Segments are disjoint and only the last covers the starts, which a
  // per-start scan of every segment would reach last.
  const segments = Array.from({ length: 150 }, (_, index) => ({
    name: `__X${String(index)}`,
    address: MACHO_TEXT_BASE + 0x100000n + BigInt(index) * 0x1000n,
    memorySize: 0x1000,
    fileOffset: 0x1000,
    fileSize: 0x100,
    protection: 5,
  }));
  const last = segments.at(-1)!.address;
  const report = await parse(
    machoFunctionStartsImage({
      extraSegments: segments,
      starts: {
        deltas: [
          last - MACHO_TEXT_BASE,
          ...Array.from({ length: 63 }, () => 8n),
        ],
      },
    }),
  );
  expect(report.coverage).toMatchObject({
    status: "complete",
    total_starts: 64,
    out_of_text: 0,
  });
  expect(report.starts.at(-1)!.vmaddr).toBe(hex(last + 63n * 8n));
});

it("wraps a 32-bit image's starts at 2^32, not 2^64", async () => {
  const base = BigInt(MACHO_ARM32_TEXT_BASE);
  const report = await parse(
    machoArm32FunctionStartsImage([0x1000n, (1n << 32n) - base - 0x1000n]),
  );
  expect(report.starts).toMatchObject([
    { index: 0, vmaddr: "0x2000", issues: [] },
    { index: 1, vmaddr: "0x0", issues: ["wrapped", "out_of_text"] },
  ]);
  expect(report.coverage).toMatchObject({
    status: "partial",
    non_monotonic: 1,
  });
});

it("tallies duplicate LINKEDIT commands without an object per command", async () => {
  // 900 repeated LC_FUNCTION_STARTS commands: only the first is decoded,
  // the rest feed counters, and each declared range is still checked.
  const image = machoFunctionStartsImage({
    starts: { deltas: ARM64_DELTAS },
    extraSegments: [],
  });
  const count = image.readUInt32LE(16);
  const commandBytes = image.readUInt32LE(20);
  const repeated = 900;
  const extra = Buffer.alloc(repeated * 16);
  for (let index = 0; index < repeated; index += 1) {
    extra.writeUInt32LE(0x26, index * 16);
    extra.writeUInt32LE(16, index * 16 + 4);
    // Every other duplicate points outside __LINKEDIT.
    extra.writeUInt32LE(index % 2 === 0 ? 0x4000 : 0x100, index * 16 + 8);
    extra.writeUInt32LE(4, index * 16 + 12);
  }
  // The commands must end before __LINKEDIT at file offset 0x4000.
  expect(32 + commandBytes + extra.length).toBeLessThan(0x4000);
  const file = Buffer.alloc(image.length);
  image.copy(file, 0, 0, 32 + commandBytes);
  extra.copy(file, 32 + commandBytes);
  image.copy(file, 0x4000, 0x4000);
  file.writeUInt32LE(count + repeated, 16);
  file.writeUInt32LE(commandBytes + extra.length, 20);
  const report = await parse(file, { limit: 0 });
  expect(report.coverage).toMatchObject({
    total_starts: 3,
    duplicate_commands: repeated,
    outside_linkedit: repeated / 2,
  });
  expect(report.limitations).toContain(TEXT.duplicateStarts);
});
