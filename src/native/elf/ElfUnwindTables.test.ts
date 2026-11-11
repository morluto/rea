import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  elfUnwindRangesSchema,
  inspectElfUnwindRangesInputSchema,
} from "../../domain/native/elfUnwindRanges.js";
import {
  ElfUnwindSymbolTextFailure,
  parseElfUnwindRanges,
} from "./ElfUnwindTables.js";
import {
  UNWIND_FN_A,
  UNWIND_FN_A_SIZE,
  UNWIND_FN_B,
  UNWIND_GOT_VA,
  UNWIND_HDR_VA,
  UNWIND_LSDA,
  UNWIND_PERSONALITY,
  UNWIND_SUFFIX_VA,
  elfUnwindAbsentFixture,
  elfUnwindFixture,
  elfUnwindSectionlessFixture,
} from "./ElfUnwindTables.fixture.js";

// Pass-through spies that count how often symbol names are scanned and decoded.
const stringTable = vi.hoisted(() => ({
  observed: [] as number[],
  decoded: [] as number[],
}));
vi.mock("../../domain/elfStringTable.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../domain/elfStringTable.js")>();
  return {
    ...original,
    observeElfStringTableEntry: (
      ...args: Parameters<typeof original.observeElfStringTableEntry>
    ) => {
      const observed = original.observeElfStringTableEntry(...args);
      stringTable.observed.push(observed.contentBytes);
      return observed;
    },
    elfStringTableText: (
      ...args: Parameters<typeof original.elfStringTableText>
    ) => {
      const text = original.elfStringTableText(...args);
      stringTable.decoded.push(text?.length ?? 0);
      return text;
    },
  };
});

const address = (value: number): string => `0x${value.toString(16)}`;

it.each([true, false])(
  "retains valid ten-byte sign padding in CIE alignment (little %s)",
  (little) => {
    const report = parse(
      elfUnwindFixture({
        little,
        header: "match",
        leb128: { dataAlignment: [0xfc, ...Array<number>(8).fill(0xff), 0x7f] },
      }),
    );
    expect(report.cies[0]?.data_alignment).toBe(-4);
    expect(report.coverage).toMatchObject({
      status: "complete",
      total_ranges: 2,
    });
  },
);

it("rejects an overflowing ULEB pointer instead of wrapping it to a fabricated function address", () => {
  const report = parse(
    elfUnwindFixture({
      header: "absent",
      leb128: {
        pointers: {
          signed: false,
          start: [0x81, ...Array<number>(8).fill(0x80), 0x02],
          size: [0x20],
        },
      },
    }),
  );
  expect(report.ranges.map((r) => r.start)).toEqual([address(UNWIND_FN_B)]);
  expect(report.coverage.status).toBe("incomplete");
});

it("rejects a padded negative SLEB range instead of publishing a huge positive size", () => {
  const report = parse(
    elfUnwindFixture({
      header: "absent",
      leb128: {
        pointers: {
          signed: true,
          start: [0x80, 0x82, 0x80, 0x02],
          size: [...Array<number>(9).fill(0xff), 0x7f],
        },
      },
    }),
  );
  expect(report.ranges.map((r) => r.start)).toEqual([address(UNWIND_FN_B)]);
  expect(report.limitations).toContain("An FDE address range is negative.");
});

it.each([
  {
    signed: false,
    start: [...Array<number>(9).fill(0xff), 0x01],
    expected: "0xffffffffffffffff",
  },
  {
    signed: true,
    start: [...Array<number>(9).fill(0x80), 0x7f],
    expected: "0x8000000000000000",
  },
  {
    signed: true,
    start: [...Array<number>(9).fill(0xff), 0x00],
    expected: "0x7fffffffffffffff",
  },
])(
  "retains the representable LEB128 boundary $expected",
  ({ signed, start, expected }) => {
    const report = parse(
      elfUnwindFixture({
        header: "absent",
        leb128: { pointers: { signed, start, size: [0x20] } },
      }),
    );
    expect(report.ranges.map((r) => r.start)).toContain(expected);
    expect(report.coverage.status).toBe("complete");
  },
);

it.each(
  [
    [...Array<number>(9).fill(0x80), 0x01],
    [...Array<number>(9).fill(0xff), 0x7e],
    Array<number>(10).fill(0x80),
  ].map((start) => ({ start })),
)(
  "omits an overflowing or unterminated signed operand and retains its sibling FDE (%j)",
  ({ start }) => {
    const report = parse(
      elfUnwindFixture({
        header: "absent",
        leb128: { pointers: { signed: true, start, size: [0x20] } },
      }),
    );
    expect(report.ranges.map((r) => r.start)).toEqual([address(UNWIND_FN_B)]);
    expect(report.coverage.status).toBe("incomplete");
  },
);

const parse = (bytes: Buffer, raw: Readonly<Record<string, unknown>> = {}) => {
  const input = inspectElfUnwindRangesInputSchema.parse({
    path: "/artifacts/unwind.elf",
    ...raw,
  });
  return elfUnwindRangesSchema.parse(
    parseElfUnwindRanges(
      bytes,
      {
        path: input.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
      input,
    ),
  );
};

it("recovers two ELF64 ranges, an indirect personality, and a header mismatch", () => {
  const report = parse(elfUnwindFixture());
  expect(report.format).toBe("elf64");
  expect(report.byte_order).toBe("little");
  expect(report.machine).toBe(62);
  expect(report.type_name).toBe("shared");
  expect(report.eh_frame).toMatchObject({
    status: "present",
    source: "section",
  });
  expect(report.debug_frame.status).toBe("present");
  expect(report.cies.map((cie) => cie.augmentation.text)).toEqual([
    "zRS",
    "zPLRB",
  ]);
  expect(report.cies[0]).toMatchObject({
    version: 1,
    code_alignment: 1,
    data_alignment: -4,
    return_address_register: 16,
    pointer_encoding: { raw: 0x1b, name: "pcrel|sdata4" },
    signal_frame: true,
    b_key: false,
    instruction_bytes: 1,
    personality: null,
  });
  expect(report.cies[1]).toMatchObject({
    version: 1,
    return_address_register: 17,
    signal_frame: false,
    b_key: true,
    lsda_encoding: { raw: 0x1b, name: "pcrel|sdata4" },
    personality: {
      address: address(UNWIND_PERSONALITY),
      indirect: true,
      encoding: { raw: 0x9b, name: "pcrel|sdata4|indirect" },
    },
  });
  expect(report.ranges).toHaveLength(2);
  expect(report.ranges[0]).toMatchObject({
    index: 0,
    start: address(UNWIND_FN_A),
    end: address(UNWIND_FN_A + 0x20),
    size: "32",
    section: { text: ".text", trust: "untrusted" },
    symbol: { text: "alpha", trust: "untrusted" },
    cie_index: 0,
    lsda: null,
    personality: null,
  });
  expect(report.ranges[1]).toMatchObject({
    index: 1,
    start: address(UNWIND_FN_B),
    end: address(UNWIND_FN_B + 0x30),
    size: "48",
    section: { text: ".text", trust: "untrusted" },
    symbol: null,
    cie_index: 1,
    lsda: { address: address(UNWIND_LSDA), indirect: false },
    personality: { address: address(UNWIND_PERSONALITY), indirect: true },
  });
  expect(report.ranges.some((range) => range.symbol?.text === "mid")).toBe(
    false,
  );
  expect(report.ranges.some((range) => range.symbol?.text === "obj")).toBe(
    false,
  );
  expect(report.coverage).toMatchObject({
    status: "complete",
    total_ranges: 2,
    ranges_with_symbols: 1,
    ranges_without_symbols: 1,
    eh_frame_hdr_agreement: "disagree",
    examined_records: 4,
  });
  expect(report.limitations).toContain(
    "The .eh_frame_hdr binary search table does not match the decoded FDEs.",
  );
  expect(report.limitations).toContain(
    "CFA instructions are counted but not evaluated.",
  );
  expect(report.limitations).toContain(
    "Indirect EH pointers were not dereferenced.",
  );
  expect(report.limitations).toContain(
    ".debug_frame is present and was not decoded.",
  );
});

it("agrees with a header whose search table names the same FDE starts", () => {
  const report = parse(elfUnwindFixture({ header: "match" }));
  expect(report.coverage.eh_frame_hdr_agreement).toBe("agree");
  expect(report.coverage.status).toBe("complete");
  expect(report.eh_frame_hdr).toMatchObject({
    status: "present",
    version: 1,
    fde_count: 2,
    table_entries: 2,
    eh_frame_pointer: "0x401000",
  });
  expect(report.limitations).not.toContain(
    "The .eh_frame_hdr binary search table does not match the decoded FDEs.",
  );
});

it.each([
  ["elf32", 32, false, 20],
  ["elf64", 64, true, 62],
] as const)(
  "decodes %s %s-endian unwind tables",
  (_label, bits, little, machine) => {
    const report = parse(
      elfUnwindFixture({ bits, little, machine, header: "match" }),
    );
    expect(report.format).toBe(bits === 64 ? "elf64" : "elf32");
    expect(report.byte_order).toBe(little ? "little" : "big");
    expect(report.machine).toBe(machine);
    expect(report.ranges.map((range) => range.start)).toEqual([
      address(UNWIND_FN_A),
      address(UNWIND_FN_B),
    ]);
    expect(report.cies[1]?.personality?.address).toBe(
      address(UNWIND_PERSONALITY),
    );
    expect(report.coverage.eh_frame_hdr_agreement).toBe("agree");
  },
);

it("reads a version 3 return-address register and a dynsym name", () => {
  const version = parse(elfUnwindFixture({ version3: true, header: "match" }));
  expect(version.cies[0]).toMatchObject({
    version: 3,
    return_address_register: 128,
  });
  const dynsym = parse(
    elfUnwindFixture({ symbolSource: "dynsym", header: "match" }),
  );
  expect(dynsym.ranges[0]?.symbol?.text).toBe("alpha");
  const unnamed = parse(
    elfUnwindFixture({ symbolSource: "none", header: "match" }),
  );
  expect(unnamed.coverage).toMatchObject({
    ranges_with_symbols: 0,
    ranges_without_symbols: 2,
    status: "complete",
  });
});

it("keeps earlier FDEs when a later record is truncated", () => {
  const report = parse(elfUnwindFixture({ truncate: true }));
  expect(report.eh_frame.status).toBe("incomplete");
  expect(report.coverage.status).toBe("incomplete");
  expect(report.ranges.map((range) => range.start)).toEqual([
    address(UNWIND_FN_A),
  ]);
  // The second CIE is decoded, but no returned range names it.
  expect(report.cies.map((cie) => cie.index)).toEqual([0]);
  expect(report.coverage.total_cies).toBe(2);
  expect(report.limitations).toContain(".eh_frame ended inside a record.");
  expect(report.eh_frame.status).not.toBe("absent");
});

it("reports trailing bytes after the terminator as incomplete coverage", () => {
  const report = parse(
    elfUnwindFixture({ trailingByte: true, header: "match" }),
  );
  expect(report.ranges).toHaveLength(2);
  expect(report.coverage.status).toBe("incomplete");
  expect(report.limitations).toContain(
    "Non-zero bytes follow the .eh_frame terminator.",
  );
});

it("reports a missing header without dropping decoded ranges", () => {
  const report = parse(elfUnwindFixture({ header: "absent" }));
  expect(report.ranges).toHaveLength(2);
  expect(report.eh_frame_hdr.status).toBe("absent");
  expect(report.coverage.eh_frame_hdr_agreement).toBe("unavailable");
  expect(report.coverage.status).toBe("complete");
});

it("reads one agreeing range from PT_GNU_EH_FRAME when section headers are absent", () => {
  const report = parse(elfUnwindSectionlessFixture());
  expect(report.eh_frame).toMatchObject({
    status: "present",
    source: "program",
  });
  expect(report.eh_frame_hdr.status).toBe("present");
  expect(report.debug_frame.status).toBe("unknown");
  expect(report.ranges).toHaveLength(1);
  expect(report.ranges[0]).toMatchObject({
    start: address(UNWIND_FN_A),
    section: null,
    symbol: null,
    cie_index: 0,
  });
  expect(report.cies[0]?.augmentation.text).toBe("zR");
  expect(report.coverage).toMatchObject({
    status: "complete",
    total_ranges: 1,
    eh_frame_hdr_agreement: "agree",
  });
  expect(report.limitations).toContain(".debug_frame presence is unknown.");
});

it("bounds a header-located .eh_frame without a terminator by its search table", () => {
  const bytes = elfUnwindSectionlessFixture({ unterminated: "decodable" });
  const report = parse(bytes);
  expect(report.eh_frame).toMatchObject({
    status: "present",
    source: "program",
  });
  expect(report.ranges.map((range) => range.start)).toEqual([
    address(UNWIND_FN_A),
  ]);
  expect(report.ranges).not.toContainEqual(
    expect.objectContaining({ start: address(UNWIND_FN_B) }),
  );
  expect(report.coverage).toMatchObject({
    status: "complete",
    total_ranges: 1,
    eh_frame_hdr_agreement: "agree",
    examined_records: 2,
  });
  expect(report.limitations).toContain(
    "The .eh_frame located only through the .eh_frame_hdr eh_frame_ptr has no section bounds and no terminator after the last FDE its search table names; bytes after that FDE were not decoded.",
  );
});

it("stops a header-located .eh_frame without a search table at its first undecodable record", () => {
  const report = parse(
    elfUnwindSectionlessFixture({
      unterminated: "undecodable",
      emptyTable: true,
    }),
  );
  expect(report.eh_frame).toMatchObject({
    status: "present",
    source: "program",
  });
  expect(report.ranges.map((range) => range.start)).toEqual([
    address(UNWIND_FN_A),
  ]);
  expect(report.coverage).toMatchObject({
    status: "incomplete",
    total_ranges: 1,
    examined_records: 3,
  });
  expect(report.limitations).toContain(
    "The .eh_frame located only through the .eh_frame_hdr eh_frame_ptr has no section bounds or usable search table, so decoding stopped at the first record that failed to decode.",
  );
});

it("rejects a program-header table outside the file before decoding unwind tables", () => {
  const bytes = elfUnwindSectionlessFixture();
  bytes.writeBigUInt64LE(BigInt(bytes.length), 32);
  expect(() => parse(bytes)).toThrow(
    expect.objectContaining({ kind: "malformed" }),
  );
});

it("reports .eh_frame as unknown when the header cannot locate it", () => {
  const bytes = elfUnwindSectionlessFixture();
  const headerOffset = Number(bytes.readBigUInt64LE(64 + 56 + 8));
  bytes[headerOffset + 1] = 0x0f;
  const report = parse(bytes);
  expect(report.eh_frame).toEqual({
    status: "unknown",
    source: null,
    location: null,
  });
  expect(report.eh_frame_hdr.status).toBe("incomplete");
  expect(report.ranges).toEqual([]);
  expect(report.coverage).toMatchObject({
    status: "incomplete",
    total_ranges: 0,
    total_cies: 0,
    eh_frame_hdr_agreement: "unavailable",
  });
  expect(report.limitations).toContain(
    ".eh_frame_hdr eh_frame_ptr could not be decoded.",
  );
});

it("reports known absence when no unwind section or segment is declared", () => {
  const report = parse(elfUnwindAbsentFixture());
  expect(report.eh_frame.status).toBe("absent");
  expect(report.debug_frame.status).toBe("absent");
  expect(report.coverage).toMatchObject({
    status: "complete",
    total_ranges: 0,
    total_cies: 0,
    eh_frame_hdr_agreement: "unavailable",
  });
  expect(report.ranges).toEqual([]);
});

it("pages ranges without changing coverage totals", () => {
  const report = parse(elfUnwindFixture(), { offset: 1, limit: 1 });
  expect(report.ranges.map((range) => range.index)).toEqual([1]);
  expect(report.page).toEqual({
    offset: 1,
    limit: 1,
    returned: 1,
    total: 2,
    next_offset: null,
  });
  const past = parse(elfUnwindFixture(), { offset: 9, limit: 1 });
  expect(past.ranges).toEqual([]);
  expect(past.page).toMatchObject({
    offset: 9,
    returned: 0,
    total: 2,
    next_offset: null,
  });
});

it("returns only the CIEs a page's ranges name, however many the image has", () => {
  const report = parse(elfUnwindFixture({ extraCies: 500 }), {
    offset: 1,
    limit: 1,
  });
  expect(report.ranges.map((range) => range.cie_index)).toEqual([1]);
  expect(report.cies.map((cie) => cie.index)).toEqual([1]);
  expect(report.cies[0]?.augmentation.text).toBe("zPLRB");
  expect(report.coverage).toMatchObject({
    total_ranges: 2,
    total_cies: 502,
    examined_records: 504,
  });
  const first = parse(elfUnwindFixture({ extraCies: 500 }), { limit: 1 });
  expect(first.cies.map((cie) => cie.index)).toEqual([0]);
  expect(first.coverage.total_cies).toBe(502);
});

it("fails closed when the CIE or FDE budget is exhausted", () => {
  const bytes = elfUnwindFixture();
  const input = inspectElfUnwindRangesInputSchema.parse({
    path: "/artifacts/unwind.elf",
    max_ranges: 1,
  });
  expect(() =>
    parseElfUnwindRanges(
      bytes,
      {
        path: input.path,
        sha256: "a".repeat(64),
        bytes: bytes.length,
      },
      input,
    ),
  ).toThrow(ArtifactReaderFailure);
});

it("stops when the caller has already cancelled", () => {
  const bytes = elfUnwindFixture();
  const input = inspectElfUnwindRangesInputSchema.parse({
    path: "/artifacts/unwind.elf",
  });
  expect(() =>
    parseElfUnwindRanges(
      bytes,
      {
        path: input.path,
        sha256: "a".repeat(64),
        bytes: bytes.length,
      },
      input,
      AbortSignal.abort(),
    ),
  ).toThrow(ArtifactReaderFailure);
});

const findSection = (bytes: Buffer, name: string) => {
  const shoff = Number(bytes.readBigUInt64LE(40));
  const count = bytes.readUInt16LE(60);
  const names = shoff + bytes.readUInt16LE(62) * 64;
  const namesOffset = Number(bytes.readBigUInt64LE(names + 24));
  for (let index = 1; index < count; index += 1) {
    const at = shoff + index * 64;
    const nameAt = namesOffset + bytes.readUInt32LE(at);
    const end = bytes.indexOf(0, nameAt);
    if (bytes.toString("latin1", nameAt, end) === name)
      return {
        offset: Number(bytes.readBigUInt64LE(at + 24)),
        headerOffset: at,
      };
  }
  throw new Error(`fixture has no ${name}`);
};

it.each(["compressed-symbols", "compressed-names", "non-string-names"])(
  "retains unwind ranges without interpreting %s as ordinary symbol storage",
  (storage) => {
    const bytes = elfUnwindFixture({ header: "match" });
    expect(parse(bytes).ranges[0]?.symbol?.text).toBe("alpha");
    const section = findSection(
      bytes,
      storage === "compressed-symbols" ? ".symtab" : ".strtab",
    );
    if (storage === "non-string-names")
      bytes.writeUInt32LE(1, section.headerOffset + 4);
    else bytes.writeBigUInt64LE(0x800n, section.headerOffset + 8);

    const report = parse(bytes);
    expect(report.ranges.map(({ start }) => start)).toEqual([
      address(UNWIND_FN_A),
      address(UNWIND_FN_B),
    ]);
    expect(report.ranges.map(({ symbol }) => symbol)).toEqual([null, null]);
    expect(report.coverage).toMatchObject({
      status: "incomplete",
      ranges_with_symbols: 0,
      eh_frame_hdr_agreement: "agree",
    });
  },
);

it("keeps .eh_frame ranges when .debug_frame is SHT_NOBITS", () => {
  const report = parse(
    elfUnwindFixture({
      header: "match",
      backing: { section: ".debug_frame", kind: "nobits" },
    }),
  );
  expect(report.debug_frame).toEqual({ status: "incomplete", location: null });
  expect(report.eh_frame.status).toBe("present");
  expect(report.ranges.map((range) => range.start)).toEqual([
    address(UNWIND_FN_A),
    address(UNWIND_FN_B),
  ]);
  expect(report.coverage).toMatchObject({
    status: "incomplete",
    eh_frame_hdr_agreement: "agree",
  });
  expect(report.limitations).toContain(
    ".debug_frame is declared but its bytes are not in the file; it was not examined.",
  );
});

it("reports a .debug_frame past the end of file without a file range", () => {
  const report = parse(
    elfUnwindFixture({
      header: "match",
      backing: { section: ".debug_frame", kind: "past-eof" },
    }),
  );
  expect(report.debug_frame).toEqual({ status: "incomplete", location: null });
  expect(report.ranges).toHaveLength(2);
  expect(report.coverage.status).toBe("incomplete");
});

it("decodes the in-file prefix of an .eh_frame that runs past the end of file", () => {
  const bytes = elfUnwindFixture({
    header: "match",
    backing: { section: ".eh_frame", kind: "past-eof" },
  });
  const report = parse(bytes);
  const { offset } = findSection(bytes, ".eh_frame");
  expect(report.eh_frame).toEqual({
    status: "incomplete",
    source: "section",
    location: { offset, bytes: bytes.length - offset },
  });
  expect(report.ranges).toHaveLength(2);
  expect(report.coverage).toMatchObject({
    status: "incomplete",
    total_ranges: 2,
    eh_frame_hdr_agreement: "agree",
  });
  expect(report.limitations).toContain(
    ".eh_frame extends past the end of the file; only its in-file bytes were decoded.",
  );
});

it.each([
  [".eh_frame", ".eh_frame is declared but not file-backed."],
  [".eh_frame_hdr", ".eh_frame_hdr is declared but not file-backed."],
] as const)("reports a SHT_NOBITS %s without a file range", (section, text) => {
  const report = parse(
    elfUnwindFixture({ header: "match", backing: { section, kind: "nobits" } }),
  );
  const table = section === ".eh_frame" ? report.eh_frame : report.eh_frame_hdr;
  expect(table.status).toBe("incomplete");
  expect(table.location).toBeNull();
  expect(report.coverage.status).toBe("incomplete");
  expect(report.limitations).toContain(text);
  if (section === ".eh_frame_hdr") expect(report.ranges).toHaveLength(2);
});

it("resolves .eh_frame datarel pointers against the GOT, not .eh_frame_hdr", () => {
  const report = parse(elfUnwindFixture({ header: "match", datarel: "got" }));
  expect(report.cies[0]?.pointer_encoding).toEqual({
    raw: 0x3b,
    name: "datarel|sdata4",
  });
  expect(report.ranges.map((range) => range.start)).toEqual([
    address(UNWIND_FN_A),
    address(UNWIND_FN_B),
  ]);
  expect(report.coverage).toMatchObject({
    status: "complete",
    eh_frame_hdr_agreement: "agree",
  });
  expect(report.limitations).toContain(
    "DW_EH_PE_datarel .eh_frame values were resolved against the GOT base from the .got.plt section.",
  );
  expect(UNWIND_GOT_VA).not.toBe(UNWIND_HDR_VA);
});

it("does not use a non-allocated GOT section as the data-relative base", () => {
  const bytes = elfUnwindFixture({ header: "match", datarel: "got" });
  const { headerOffset } = findSection(bytes, ".got.plt");
  bytes.writeBigUInt64LE(1n, headerOffset + 8);
  bytes.writeBigUInt64LE(0x500000n, headerOffset + 16);
  const report = parse(bytes);
  expect(report.coverage.status).toBe("incomplete");
  expect(report.ranges.map((range) => range.start)).not.toContain("0x4fc100");
});

it("leaves .eh_frame datarel pointers unresolved when no GOT is declared", () => {
  const report = parse(elfUnwindFixture({ header: "match", datarel: "none" }));
  expect(report.ranges.map((range) => range.start)).toEqual([
    address(UNWIND_FN_B),
  ]);
  expect(report.coverage).toMatchObject({
    status: "incomplete",
    total_ranges: 1,
    eh_frame_hdr_agreement: "disagree",
  });
  expect(report.limitations).toContain(
    "A DW_EH_PE_datarel .eh_frame value needs a GOT base that could not be determined; that value is unresolved.",
  );
});

it("caps symbol lookup across .symtab and .dynsym together", () => {
  const report = parse(elfUnwindFixture({ header: "match", symbolCap: true }));
  expect(report.ranges).toHaveLength(2);
  expect(report.coverage).toMatchObject({
    status: "incomplete",
    ranges_with_symbols: 0,
  });
  expect(report.limitations).toContain(
    "Symbol tables were capped at 65536 combined entries.",
  );
});

it("keeps the symbol scan allowance for later tables when an earlier table has no string table", () => {
  const bytes = elfUnwindFixture({ header: "match", symbolCap: true });
  const section = findSection(bytes, ".symtab");
  bytes.writeUInt32LE(0, section.headerOffset + 40);
  const report = parse(bytes);
  expect(report.ranges[0]?.symbol?.text).toBe("alpha");
  expect(report.coverage.status).toBe("incomplete");
  expect(report.limitations).not.toContain(
    "Symbol tables were capped at 65536 combined entries.",
  );
});

it.each([".eh_frame", ".eh_frame_hdr"] as const)(
  "reports coverage incomplete when a duplicate %s is ignored",
  (duplicate) => {
    const report = parse(elfUnwindFixture({ header: "match", duplicate }));
    expect(report.ranges).toHaveLength(2);
    expect(report.coverage.status).toBe("incomplete");
    expect(report.limitations).toContain(
      `Multiple ${duplicate} sections were declared; only the first was decoded.`,
    );
  },
);

it.each(["duplicate-row", "shared-fde"] as const)(
  "reports header disagreement for a %s search table",
  (header) => {
    const report = parse(elfUnwindFixture({ header }));
    expect(report.ranges).toHaveLength(2);
    expect(report.coverage.eh_frame_hdr_agreement).toBe("disagree");
    expect(report.limitations).toContain(
      "The .eh_frame_hdr binary search table does not match the decoded FDEs.",
    );
  },
);

it.each([
  ["elf64 little-endian", 64, true],
  ["elf32 big-endian", 32, false],
] as const)(
  "keeps a 4-byte CIE ID after a 64-bit .eh_frame length (%s)",
  (_label, bits, little) => {
    const report = parse(
      elfUnwindFixture({
        bits,
        little,
        header: "match",
        extendedLength: true,
      }),
    );
    expect(report.cies.map((cie) => cie.augmentation.text)).toEqual([
      "zRS",
      "zPLRB",
    ]);
    expect(report.ranges.map((range) => range.start)).toEqual([
      address(UNWIND_FN_A),
      address(UNWIND_FN_B),
    ]);
    expect(report.coverage).toMatchObject({
      status: "complete",
      examined_records: 4,
      eh_frame_hdr_agreement: "agree",
    });
  },
);

it.each([
  ["elf64 little-endian", 64, true],
  ["elf32 big-endian", 32, false],
] as const)(
  "resolves .eh_frame datarel pointers against DT_PLTGOT (%s)",
  (_label, bits, little) => {
    const report = parse(
      elfUnwindFixture({ bits, little, header: "match", datarel: "dynamic" }),
    );
    expect(report.ranges.map((range) => range.start)).toEqual([
      address(UNWIND_FN_A),
      address(UNWIND_FN_B),
    ]);
    expect(report.coverage.status).toBe("complete");
    expect(report.limitations).toContain(
      "DW_EH_PE_datarel .eh_frame values were resolved against the GOT base from DT_PLTGOT.",
    );
  },
);

it("keeps the GOT unknown when compressed dynamic storage resembles decoded entries", () => {
  const bytes = elfUnwindFixture({ header: "match", datarel: "dynamic" });
  const section = findSection(bytes, ".dynamic");
  // The payload still resembles ordinary DT_PLTGOT/DT_NULL entries, but the
  // declaration makes it opaque compressed storage, not a decoded table.
  bytes.writeBigUInt64LE(0x800n, section.headerOffset + 8);
  const report = parse(bytes);
  expect(report.ranges.map((range) => range.start)).not.toContain(
    address(UNWIND_FN_A),
  );
  expect(report.coverage.status).toBe("incomplete");
  expect(report.limitations).toContain(
    "A DW_EH_PE_datarel .eh_frame value needs a GOT base that could not be determined; that value is unresolved.",
  );
});

it("caps .eh_frame_hdr rows at the max_ranges budget and marks the comparison incomplete", () => {
  const report = parse(elfUnwindFixture({ header: "duplicate-row" }), {
    max_ranges: 2,
  });
  expect(report.ranges).toHaveLength(2);
  expect(report.eh_frame_hdr).toMatchObject({
    status: "incomplete",
    fde_count: 3,
    table_entries: 2,
  });
  expect(report.coverage).toMatchObject({
    status: "incomplete",
    eh_frame_hdr_agreement: "unavailable",
  });
  expect(report.limitations).toContain(
    ".eh_frame_hdr declares 3 FDEs, more than the max_ranges budget of 2; only 2 search-table rows were read and the table was not compared with the decoded FDEs.",
  );
});

it("bounds an overstated .eh_frame_hdr fde_count by the section bytes", () => {
  const report = parse(
    elfUnwindFixture({ header: "match", headerCount: 0x7fffffff }),
    { max_ranges: 65536 },
  );
  expect(report.ranges).toHaveLength(2);
  expect(report.eh_frame_hdr).toMatchObject({
    status: "incomplete",
    fde_count: 0x7fffffff,
    table_entries: 2,
  });
  expect(report.coverage.eh_frame_hdr_agreement).toBe("unavailable");
  expect(report.limitations).toContain(
    `.eh_frame_hdr declares ${String(0x7fffffff)} FDEs but its bytes hold at most 2 search-table rows; the table is truncated.`,
  );
});

it("reports an .eh_frame_hdr fde_count above 32 bits as undecoded, keeping the FDEs", () => {
  const report = parse(
    elfUnwindFixture({ header: "match", headerCount: 0x1_0000_0002n }),
  );
  expect(report.ranges).toHaveLength(2);
  expect(report.eh_frame_hdr).toMatchObject({
    status: "incomplete",
    fde_count: null,
    table_entries: 0,
  });
  expect(report.coverage.eh_frame_hdr_agreement).toBe("unavailable");
  expect(report.limitations).toContain(
    ".eh_frame_hdr FDE count does not fit in 32 bits.",
  );
});

it("reports a header with an omitted search table as present without failing coverage", () => {
  const report = parse(
    elfUnwindFixture({ header: "match", headerCount: "omit" }),
  );
  expect(report.ranges).toHaveLength(2);
  expect(report.eh_frame_hdr).toMatchObject({
    status: "present",
    fde_count: null,
    table_entries: 0,
    fde_count_encoding: { raw: 0xff },
    table_encoding: { raw: 0xff },
  });
  expect(report.coverage.eh_frame_hdr_agreement).toBe("unavailable");
  expect(report.coverage.status).toBe("complete");
});

it("reports a raw zero LSDA pointer as no LSDA, not the field address", () => {
  const report = parse(elfUnwindFixture({ header: "match", zeroLsda: true }));
  expect(report.cies[1]?.lsda_encoding).toEqual({
    raw: 0x1b,
    name: "pcrel|sdata4",
  });
  expect(report.ranges[1]).toMatchObject({
    start: address(UNWIND_FN_B),
    lsda: null,
  });
  expect(report.coverage.status).toBe("complete");
});

it("skips an FDE with a raw zero initial location as a discarded entry", () => {
  const report = parse(
    elfUnwindFixture({ header: "match", discardedFde: true }),
  );
  expect(report.ranges.map((range) => range.start)).toEqual([
    address(UNWIND_FN_A),
    address(UNWIND_FN_B),
  ]);
  expect(report.coverage).toMatchObject({
    status: "complete",
    total_ranges: 2,
    examined_records: 5,
    eh_frame_hdr_agreement: "agree",
  });
  expect(report.limitations).toContain(
    "1 FDE has a zero initial location and was skipped as a discarded entry.",
  );
});

it("does not claim PT_GNU_EH_FRAME was ignored when it supplied the header", () => {
  const report = parse(elfUnwindSectionlessFixture({ sections: ".eh_frame" }));
  expect(report.eh_frame).toMatchObject({
    status: "present",
    source: "section",
  });
  expect(report.eh_frame_hdr.status).toBe("present");
  expect(report.coverage.eh_frame_hdr_agreement).toBe("agree");
  expect(
    report.limitations.some((text) => text.includes("PT_GNU_EH_FRAME was")),
  ).toBe(false);
  expect(report.limitations.some((text) => text.includes("ignored"))).toBe(
    false,
  );
});

it("notes an ignored PT_GNU_EH_FRAME only when a .eh_frame_hdr section overrides different bytes", () => {
  const report = parse(
    elfUnwindSectionlessFixture({ sections: ".eh_frame_hdr" }),
  );
  expect(report.eh_frame_hdr.status).toBe("present");
  expect(report.coverage.eh_frame_hdr_agreement).toBe("agree");
  expect(report.limitations).toContain(
    "PT_GNU_EH_FRAME names different bytes than the .eh_frame_hdr section; it was ignored because the section is present.",
  );
});

it("uses the load mapping for a non-allocated unwind header", () => {
  const bytes = elfUnwindSectionlessFixture({ sections: ".eh_frame_hdr" });
  const { headerOffset } = findSection(bytes, ".eh_frame_hdr");
  bytes.writeBigUInt64LE(0n, headerOffset + 8);
  bytes.writeBigUInt64LE(0n, headerOffset + 16);
  const report = parse(bytes);
  expect(report.coverage).toMatchObject({
    status: "complete",
    eh_frame_hdr_agreement: "agree",
  });
});

it("translates and places addresses only through SHF_ALLOC sections", () => {
  const report = parse(
    elfUnwindSectionlessFixture({
      sections: ".eh_frame",
      nonAllocOverlay: true,
    }),
  );
  expect(report.eh_frame).toMatchObject({
    status: "present",
    source: "section",
  });
  expect(report.eh_frame_hdr.status).toBe("present");
  expect(report.ranges).toHaveLength(1);
  expect(report.ranges[0]).toMatchObject({
    start: address(UNWIND_FN_A),
    section: null,
  });
  expect(report.coverage).toMatchObject({
    status: "complete",
    eh_frame_hdr_agreement: "agree",
  });
});

it("does not decode FDEs against a CIE with an unrecognized augmentation letter", () => {
  const report = parse(
    elfUnwindFixture({ header: "match", unknownAugmentation: true }),
  );
  expect(report.cies.map((cie) => cie.augmentation.text)).toEqual(["zPLRB"]);
  expect(report.ranges.map((range) => range.start)).toEqual([
    address(UNWIND_FN_B),
  ]);
  expect(report.coverage.status).toBe("incomplete");
  expect(report.limitations).toEqual(
    expect.arrayContaining([
      "A CIE augmentation has an unrecognized letter, so its pointer encodings cannot be trusted; that CIE was not decoded.",
      "1 FDE uses a CIE with an unrecognized augmentation letter and was not decoded.",
    ]),
  );
});

it.each([32, 64] as const)(
  "wraps an unsigned pcrel ELF%i initial location at the address width",
  (bits) => {
    const report = parse(
      elfUnwindFixture({ bits, header: "match", unsignedPcrel: {} }),
    );
    expect(report.ranges[0]).toMatchObject({
      start: address(UNWIND_FN_A),
      end: address(UNWIND_FN_A + UNWIND_FN_A_SIZE),
    });
    expect(report.coverage.eh_frame_hdr_agreement).toBe("agree");
  },
);

it("wraps an ELF32 FDE end that overflows the address space", () => {
  const report = parse(
    elfUnwindFixture({
      bits: 32,
      header: "match",
      unsignedPcrel: { size: 0xffffff00 },
    }),
  );
  expect(report.ranges[0]).toMatchObject({
    start: address(UNWIND_FN_A),
    end: address((UNWIND_FN_A + 0xffffff00) % 2 ** 32),
    size: String(0xffffff00),
  });
});

it("scans and decodes a symbol name shared by many symbols once, only for FDE starts", () => {
  const bytes = elfUnwindFixture({
    header: "match",
    sharedName: { symbols: 4096, bytes: 60000 },
  });
  stringTable.observed.length = 0;
  stringTable.decoded.length = 0;
  const report = parse(bytes, { limit: 1 });
  expect(report.ranges).toHaveLength(1);
  expect(report.ranges[0]?.symbol?.text).toBe("n".repeat(60000));
  expect(report.coverage).toMatchObject({
    total_ranges: 2,
    ranges_with_symbols: 2,
  });
  // Section names are observed too; only the shared symbol name is counted.
  const shared = (lengths: readonly number[]) =>
    lengths.filter((length) => length === 60000).length;
  expect(shared(stringTable.observed)).toBe(1);
  expect(shared(stringTable.decoded)).toBe(1);
});

it("skips an FDE whose initial location is indirect instead of reporting the pointer slot", () => {
  const report = parse(
    elfUnwindFixture({ header: "match", indirectStart: true }),
  );
  expect(report.ranges.map((range) => range.start)).toEqual([
    address(UNWIND_FN_B),
  ]);
  expect(report.coverage.status).toBe("incomplete");
  expect(report.limitations).toEqual(
    expect.arrayContaining([
      "1 FDE has an indirect initial location that was not dereferenced; its function start is unknown and it was skipped.",
      "Indirect EH pointers were not dereferenced.",
    ]),
  );
});

it("does not locate .eh_frame through an indirect .eh_frame_hdr eh_frame_ptr", () => {
  const bytes = elfUnwindSectionlessFixture();
  bytes[Number(bytes.readBigUInt64LE(64 + 56 + 8)) + 1] = 0x9b;
  const report = parse(bytes);
  expect(report.eh_frame.status).toBe("unknown");
  expect(report.ranges).toEqual([]);
  expect(report.eh_frame_hdr).toMatchObject({
    status: "incomplete",
    eh_frame_pointer: null,
  });
  expect(report.coverage.status).toBe("incomplete");
  expect(report.limitations).toContain(
    "The .eh_frame_hdr eh_frame_ptr is indirect and was not dereferenced, so it does not locate .eh_frame.",
  );
});

it("stops a header-located .eh_frame without a search table at a CIE with an unrecognized augmentation", () => {
  const report = parse(
    elfUnwindSectionlessFixture({
      unterminated: "rejected-cie",
      emptyTable: true,
    }),
  );
  expect(report.ranges.map((range) => range.start)).toEqual([
    address(UNWIND_FN_A),
  ]);
  expect(report.coverage).toMatchObject({
    status: "incomplete",
    total_ranges: 1,
    examined_records: 3,
  });
  expect(report.limitations).toEqual(
    expect.arrayContaining([
      "A CIE augmentation has an unrecognized letter, so its pointer encodings cannot be trusted; that CIE was not decoded.",
      "The .eh_frame located only through the .eh_frame_hdr eh_frame_ptr has no section bounds or usable search table, so decoding stopped at the first record that failed to decode.",
    ]),
  );
});

it("reports coverage incomplete when a duplicate PT_GNU_EH_FRAME is ignored", () => {
  const report = parse(
    elfUnwindSectionlessFixture({ duplicateProgramHeader: true }),
  );
  expect(report.ranges.map((range) => range.start)).toEqual([
    address(UNWIND_FN_A),
  ]);
  expect(report.coverage.status).toBe("incomplete");
  expect(report.limitations).toContain(
    "Multiple PT_GNU_EH_FRAME program headers were declared; only the first was decoded.",
  );
});

it("bounds the symbol-name text decoded for one page by its own allowance", () => {
  const bytes = elfUnwindFixture({ header: "absent", suffixNames: 300 });
  const page = parse(bytes, { limit: 200 });
  expect(page.ranges).toHaveLength(200);
  expect(page.ranges[2]).toMatchObject({
    start: address(UNWIND_SUFFIX_VA),
    symbol: { text: "s".repeat(65535) },
  });
  expect(() => parse(bytes, { limit: 300 })).toThrow(
    ElfUnwindSymbolTextFailure,
  );
});

it("reads a long CIE augmentation as one byte slice instead of building it per character", () => {
  const letters = 1 << 20;
  const bytes = elfUnwindFixture({
    header: "match",
    longAugmentation: letters,
  });
  const fromCharCode = vi.spyOn(String, "fromCharCode");
  try {
    const report = parse(bytes, { limit: 1 });
    expect(report.cies[0]).toMatchObject({
      augmentation: { text: `zRS${"S".repeat(letters)}` },
      signal_frame: true,
    });
    expect(report.coverage.status).toBe("complete");
    expect(fromCharCode.mock.calls.length).toBeLessThan(1000);
  } finally {
    fromCharCode.mockRestore();
  }
});

it("does not compare or bound by an .eh_frame_hdr search table with an indirect encoding", () => {
  const bytes = elfUnwindFixture({ header: "match" });
  bytes[findSection(bytes, ".eh_frame_hdr").offset + 3] = 0xbb;
  const report = parse(bytes);
  expect(report.ranges.map((range) => range.start)).toEqual([
    address(UNWIND_FN_A),
    address(UNWIND_FN_B),
  ]);
  expect(report.eh_frame_hdr).toMatchObject({
    status: "incomplete",
    table_entries: 0,
    fde_count: 2,
  });
  expect(report.coverage).toMatchObject({
    status: "incomplete",
    eh_frame_hdr_agreement: "unavailable",
  });
  expect(report.limitations).toContain(
    "The .eh_frame_hdr search table uses an indirect encoding that was not dereferenced; it was not compared with the decoded FDEs.",
  );

  const sectionless = elfUnwindSectionlessFixture({
    unterminated: "decodable",
  });
  sectionless[Number(sectionless.readBigUInt64LE(64 + 56 + 8)) + 3] = 0xbb;
  const unbounded = parse(sectionless);
  expect(unbounded.coverage.status).toBe("incomplete");
  expect(unbounded.limitations).not.toContain(
    "The .eh_frame located only through the .eh_frame_hdr eh_frame_ptr has no section bounds and no terminator after the last FDE its search table names; bytes after that FDE were not decoded.",
  );
});

it("leaves a non-zero indirect .eh_frame_hdr FDE count unresolved", () => {
  const bytes = elfUnwindFixture({ header: "match" });
  bytes[findSection(bytes, ".eh_frame_hdr").offset + 2] = 0x83;
  const report = parse(bytes);
  expect(report.ranges).toHaveLength(2);
  expect(report.eh_frame_hdr).toMatchObject({
    status: "incomplete",
    fde_count: null,
    table_entries: 0,
  });
  expect(report.coverage).toMatchObject({
    status: "incomplete",
    eh_frame_hdr_agreement: "unavailable",
  });
  expect(report.limitations).toContain(
    "The .eh_frame_hdr FDE count uses an indirect encoding that was not dereferenced, so the count and search table are unknown.",
  );
});

it("reports a header that declares a count but omits its search table as present", () => {
  const bytes = elfUnwindFixture({ header: "match" });
  bytes[findSection(bytes, ".eh_frame_hdr").offset + 3] = 0xff;
  const report = parse(bytes);
  expect(report.eh_frame_hdr).toMatchObject({
    status: "present",
    fde_count: 2,
    table_entries: 0,
    table_encoding: { raw: 0xff },
  });
  expect(report.coverage).toMatchObject({
    status: "complete",
    eh_frame_hdr_agreement: "unavailable",
  });
  expect(report.limitations).not.toContain(
    "The .eh_frame_hdr search table uses an indirect encoding that was not dereferenced; it was not compared with the decoded FDEs.",
  );
});

it("names a range from an STT_GNU_IFUNC resolver symbol at its exact start", () => {
  const report = parse(elfUnwindFixture({ header: "match", ifunc: true }));
  expect(report.ranges[0]).toMatchObject({
    start: address(UNWIND_FN_A),
    symbol: { text: "alpha" },
  });
  expect(report.coverage.ranges_with_symbols).toBe(1);
  expect(report.limitations).toContain(
    "A symbol name from an STT_GNU_IFUNC symbol names the resolver that starts at that address, not the implementation it selects at run time.",
  );
});

it("excludes load mappings whose file size exceeds memory size", () => {
  const bytes = elfUnwindSectionlessFixture();
  const phoff = Number(bytes.readBigUInt64LE(32));
  bytes.writeBigUInt64LE(0n, phoff + 40);
  const report = parse(bytes);
  expect(report.coverage.status).toBe("incomplete");
  expect(report.limitations).toContain(
    "An invalid PT_LOAD mapping was excluded from unwind address resolution.",
  );
});

it("compares the header pointer with a nonallocated frame's mapped address", () => {
  const bytes = elfUnwindSectionlessFixture({ sections: ".eh_frame_hdr" });
  const section = findSection(bytes, ".eh_frame");
  bytes.writeBigUInt64LE(0n, section.headerOffset + 8);
  bytes.writeBigUInt64LE(0n, section.headerOffset + 16);
  expect(parse(bytes).coverage.eh_frame_hdr_agreement).toBe("agree");
});
