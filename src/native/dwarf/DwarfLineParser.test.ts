import { expect, it } from "vitest";
import {
  dwarfLinesSchema,
  DWARF_LINE_LIMITATIONS,
  MAX_DWARF_LINE_ADDRESS_MATCHES,
  MAX_DWARF_LINE_SEQUENCES,
  MAX_INSPECT_DWARF_LINE_ADDRESSES,
} from "../../domain/native/dwarfLines.js";
import { ParseFailureError } from "../../domain/parseFailure.js";
import { parseDwarfLinePrograms } from "./DwarfLineParser.js";
import {
  buildStringTable,
  buildStrOffsetsTable,
  frameUnit,
  lineProgram,
  lneDefineFile,
  lneEndSequence,
  lneSetAddress,
  lneSetDiscriminator,
  lnsAdvanceLine,
  lnsAdvancePc,
  lnsConstAddPc,
  lnsCopy,
  lnsFixedAdvancePc,
  lnsNegateStmt,
  lnsSetBasicBlock,
  lnsSetColumn,
  lnsSetEpilogueBegin,
  lnsSetFile,
  lnsSetIsa,
  lnsSetPrologueEnd,
  specialOpcode,
  uleb,
} from "./DwarfLines.fixture.js";

const assertValidReportSchema = (
  line: Buffer,
  parsed: ReturnType<typeof parseDwarfLinePrograms>,
) =>
  dwarfLinesSchema.parse({
    artifact: {
      path: "/tmp/sample.elf",
      sha256: "a".repeat(64),
      bytes: Math.max(64, line.length),
    },
    format: "elf",
    bits: 64,
    byte_order: "little",
    machine: 62,
    architecture: "x86_64",
    sections:
      line.length > 0
        ? [
            {
              name: ".debug_line",
              role: ".debug_line",
              offset: 0,
              size: line.length,
              compression: "none",
              uncompressed_size: line.length,
            },
          ]
        : [],
    debug_line: line.length > 0 ? "present" : "absent",
    omissions: [],
    ...parsed,
  });

it("decodes DWARF 2, 3, and 4 legacy tables, DW_LNE_define_file, and VLIW op_index", () => {
  const progV2 = lineProgram({
    version: 2,
    legacyDirectories: ["include"],
    legacyFiles: [
      { name: "main.c", dirIndex: 0, mtime: 100, size: 512 },
      { name: "hdr.h", dirIndex: 1, mtime: 200, size: 64 },
    ],
    opcodes: Buffer.concat([
      lneSetAddress(0x1000n, 4, true),
      lnsAdvanceLine(9), // line 10
      lnsCopy(),
      lneDefineFile("gen.inc", 1, 300, 128),
      lnsSetFile(3),
      lnsAdvancePc(4),
      lnsAdvanceLine(5),
      lnsCopy(),
      lneEndSequence(),
    ]),
  });

  const resV2 = parseDwarfLinePrograms({
    line: progV2,
    lineStr: null,
    str: null,
    strOffsets: null,
    lineFileOffset: 0,
    little: true,
    defaultAddressSize: 4,
    maxPrograms: 16,
    maxRows: 100,
    unappliedLineRelocations: [],
    unappliedDebugRelocations: [],
  });

  assertValidReportSchema(progV2, resV2);
  expect(resV2.coverage.status).toBe("complete");
  expect(resV2.programs).toHaveLength(1);
  const p2 = resV2.programs[0]!;
  expect(p2.version).toBe(2);
  expect(p2.maximum_operations_per_instruction).toBe(1);
  expect(p2.directories).toEqual([
    { index: 1, path: { state: "present", value: "include" } },
  ]);
  expect(p2.files.map((f) => f.path.value)).toEqual([
    "main.c",
    "include/hdr.h",
    "include/gen.inc",
  ]);
  expect(p2.files[2]?.defined_by_opcode).toBe(true);
  expect(
    resV2.rows.map((r) => [r.address, r.file, r.line, r.end_sequence]),
  ).toEqual([
    ["0x1000", "main.c", 10, false],
    ["0x1004", "include/gen.inc", 15, false],
    ["0x1004", "include/gen.inc", 15, true],
  ]);

  const progV4Vliw = lineProgram({
    version: 4,
    minInstLen: 4,
    maxOpsPerInst: 3,
    legacyFiles: [{ name: "vliw.s", dirIndex: 0 }],
    opcodes: Buffer.concat([
      lneSetAddress(0x2000n, 8, true),
      lnsAdvancePc(2), // op_index -> 2, address stays 0x2000
      specialOpcode(1, 2), // line 2, totalOps = 4 -> address +4 (0x2004), op_index = 1
      lnsAdvancePc(3),
      lneEndSequence(),
    ]),
  });

  const resV4 = parseDwarfLinePrograms({
    line: progV4Vliw,
    lineStr: null,
    str: null,
    strOffsets: null,
    lineFileOffset: 0,
    little: true,
    defaultAddressSize: 8,
    maxPrograms: 16,
    maxRows: 100,
    unappliedLineRelocations: [],
    unappliedDebugRelocations: [],
  });
  expect(resV4.programs[0]?.version).toBe(4);
  expect(resV4.rows.map((r) => [r.address, r.op_index, r.line])).toEqual([
    ["0x2004", 1, 2],
    ["0x2008", 1, 2],
  ]);
});

it("decodes DWARF 5 MD5 digests, .debug_line_str, .debug_str_offsets strx, and DW_FORM_indirect", () => {
  const lineStrings = buildStringTable(["/workspace/repo", "app.c", "util.c"]);
  const debugStrings = buildStringTable(["/opt/inc", "ext.h"]);
  const strOffsets = buildStrOffsetsTable([...debugStrings.offsets]);
  const md5A = "0123456789abcdef0123456789abcdef";
  const md5B = "fedcba9876543210fedcba9876543210";

  const p5 = lineProgram({
    version: 5,
    addressSize: 8,
    includeTimestamp: true,
    includeSize: true,
    includeMd5: true,
    includeLlvmSource: true,
    v5Directories: [
      { form: 0x1f, lineStrp: lineStrings.offsets[0]! },
      { form: 0x16, indirectForm: 0x0e, strp: debugStrings.offsets[0]! },
    ],
    v5Files: [
      {
        path: { form: 0x1f, lineStrp: lineStrings.offsets[1]! },
        dirIndex: 0,
        timestamp: 10,
        size: 400,
        md5Hex: md5A,
        llvmSource: "int main() {}",
      },
      {
        path: { form: 0x1a, strx: 1 },
        dirIndex: 1,
        timestamp: 20,
        size: 80,
        md5Hex: md5B,
        llvmSource: "",
      },
    ],
    opcodes: Buffer.concat([
      lneSetAddress(0x401000n, 8, true),
      lnsSetFile(0),
      lnsSetColumn(4),
      lnsSetPrologueEnd(),
      lnsSetBasicBlock(),
      lnsNegateStmt(),
      lnsSetIsa(2),
      lneSetDiscriminator(7),
      specialOpcode(4, 2), // line 1+4=5, pc +2
      lnsSetFile(1),
      lnsSetEpilogueBegin(),
      lnsConstAddPc(), // advance (255-13)/14 = 17
      lnsCopy(),
      lnsFixedAdvancePc(0x10, true),
      lneEndSequence(),
    ]),
  });

  const parsed = parseDwarfLinePrograms({
    line: p5,
    lineStr: lineStrings.table,
    str: debugStrings.table,
    strOffsets,
    lineFileOffset: null, // simulated compressed section
    little: true,
    defaultAddressSize: 8,
    addresses: ["0x401002", "0x401010", "0x401013", "0x401023"],
    maxPrograms: 16,
    maxRows: 100,
    unappliedLineRelocations: [],
    unappliedDebugRelocations: [],
  });

  expect(parsed.coverage.status).toBe("complete");
  expect(parsed.limitations).toContain(
    DWARF_LINE_LIMITATIONS.compressedOffsets,
  );
  const prog = parsed.programs[0]!;
  expect(prog.file_offset).toBeNull();
  expect(prog.files[0]).toMatchObject({
    index: 0,
    name: { state: "present", value: "app.c" },
    directory: { state: "present", value: "/workspace/repo" },
    path: { state: "present", value: "/workspace/repo/app.c" },
    md5_hex: md5A,
    source_present: true,
  });
  expect(prog.files[1]).toMatchObject({
    index: 1,
    name: { state: "present", value: "ext.h" },
    directory: { state: "present", value: "/opt/inc" },
    path: { state: "present", value: "/opt/inc/ext.h" },
    md5_hex: md5B,
    source_present: false,
  });
  expect(parsed.rows[0]).toMatchObject({
    address: "0x401002",
    file: "/workspace/repo/app.c",
    line: 5,
    column: 4,
    is_stmt: false,
    basic_block: true,
    prologue_end: true,
    isa: 2,
    discriminator: 7,
  });
  expect(
    parsed.address_matches.map((m) => [m.query_address, m.status]),
  ).toEqual([
    ["0x401002", "resolved"],
    ["0x401010", "resolved"],
    ["0x401013", "resolved"],
    ["0x401023", "not_found"], // exclusive end_address
  ]);
  expect(parsed.address_matches[0]?.matches[0]).toMatchObject({
    exact: true,
    span_start: "0x401002",
    span_end: "0x401013",
    md5_hex: md5A,
    line: 5,
  });
  expect(parsed.address_matches[1]?.matches[0]).toMatchObject({
    exact: false,
    span_start: "0x401002",
    span_end: "0x401013",
  });
  expect(parsed.address_matches[2]?.matches[0]).toMatchObject({
    exact: true,
    file: "ext.h",
    directory: "/opt/inc",
    path: "/opt/inc/ext.h",
    md5_hex: md5B,
    epilogue_begin: true,
  });
});

it("handles DWARF64 big-endian, multi-program sections, program_offset, and co-located view rows", () => {
  const p0 = lineProgram({
    version: 5,
    dwarf64: true,
    little: false,
    addressSize: 8,
    v5Directories: [{ form: 0x08, inline: "/cu0" }],
    v5Files: [{ path: { form: 0x08, inline: "zero.c" }, dirIndex: 0 }],
    opcodes: Buffer.concat([
      lneSetAddress(0x1000n, 8, false),
      lnsSetFile(0),
      lnsCopy(),
      lnsAdvancePc(8),
      lneEndSequence(),
    ]),
  });

  const p1 = lineProgram({
    version: 5,
    dwarf64: true,
    little: false,
    addressSize: 8,
    v5Directories: [{ form: 0x08, inline: "/cu1" }],
    v5Files: [
      { path: { form: 0x08, inline: "one.c" }, dirIndex: 0 },
      { path: { form: 0x08, inline: "inline.h" }, dirIndex: 0 },
    ],
    opcodes: Buffer.concat([
      lneSetAddress(0x2000n, 8, false),
      lnsSetFile(0),
      lnsAdvanceLine(19), // line 20
      lnsCopy(), // view 0 at 0x2000
      lnsSetFile(1),
      lnsAdvanceLine(-10), // line 10
      lnsCopy(), // view 1 at 0x2000 (co-located!)
      lnsAdvancePc(16),
      lneEndSequence(),
    ]),
  });

  const combined = Buffer.concat([p0, p1]);
  const targeted = parseDwarfLinePrograms({
    line: combined,
    lineStr: null,
    str: null,
    strOffsets: null,
    lineFileOffset: 0x300,
    little: false,
    defaultAddressSize: 8,
    programOffset: p0.length,
    addresses: ["0x2008"],
    maxPrograms: 16,
    maxRows: 100,
    unappliedLineRelocations: [],
    unappliedDebugRelocations: [],
  });

  expect(targeted.selected_program_offset).toBe(p0.length);
  expect(targeted.programs).toHaveLength(1);
  expect(targeted.programs[0]).toMatchObject({
    index: 0,
    offset: p0.length,
    file_offset: 0x300 + p0.length,
    offset_size: 8,
  });
  expect(targeted.address_matches[0]).toMatchObject({
    query_address: "0x2008",
    status: "resolved",
  });
  expect(targeted.address_matches[0]?.matches).toHaveLength(2);
  expect(
    targeted.address_matches[0]?.matches.map((m) => [m.file, m.line]),
  ).toEqual([
    ["one.c", 20],
    ["inline.h", 10],
  ]);
});

it("skips unknown standard/extended opcodes and keeps ET_REL relocations unresolved", () => {
  const pRel = lineProgram({
    version: 5,
    addressSize: 8,
    standardOpcodeLengths: [0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1, 2],
    opcodeBase: 14,
    v5Directories: [{ form: 0x1f, lineStrp: 0 }],
    v5Files: [
      { path: { form: 0x1f, lineStrp: 0 }, dirIndex: 0 },
      { path: { form: 0x08, inline: "inline_rel.c" }, dirIndex: 0 },
    ],
    opcodes: Buffer.concat([
      lneSetAddress(0x0n, 8, true),
      // Unknown standard opcode 13 with 2 uleb operands
      Buffer.from([13]),
      uleb(5),
      uleb(9),
      // Unknown extended opcode 0x80 with 2 payload bytes
      Buffer.from([0x00, 0x03, 0x80, 0xaa, 0xbb]),
      lnsSetFile(1),
      lnsAdvanceLine(3),
      lnsCopy(),
      lnsAdvancePc(4),
      lneEndSequence(),
    ]),
  });

  const parsed = parseDwarfLinePrograms({
    line: pRel,
    lineStr: Buffer.from("/wrong_reloc_dir\0", "utf8"),
    str: null,
    strOffsets: null,
    lineFileOffset: 64,
    little: true,
    defaultAddressSize: 8,
    addresses: ["0x0"],
    maxPrograms: 16,
    maxRows: 100,
    unappliedLineRelocations: [".rela.debug_line"],
    unappliedDebugRelocations: [".rela.debug_line"],
  });

  const prog = parsed.programs[0]!;
  expect(prog.addresses_unresolved).toBe(true);
  expect(prog.directories[0]?.path).toEqual({
    state: "unresolved",
    value: null,
  });
  expect(prog.files[0]?.name).toEqual({ state: "unresolved", value: null });
  expect(prog.files[1]?.name).toEqual({
    state: "present",
    value: "inline_rel.c",
  });
  expect(prog.files[1]?.path).toEqual({ state: "unresolved", value: null });
  expect(parsed.rows.map((r) => r.line)).toEqual([4, 4]);
  expect(parsed.address_matches[0]).toEqual({
    query_address: "0x0",
    status: "unapplied_relocation",
    matches: [],
  });
});

it("handles max_rows: 0 completeness, exact max_rows, max_programs partiality, and multiple str_offsets", () => {
  const p0 = lineProgram({
    version: 5,
    v5Directories: [{ form: 0x08, inline: "/a" }],
    v5Files: [{ path: { form: 0x08, inline: "a.c" }, dirIndex: 0 }],
    opcodes: Buffer.concat([
      lneSetAddress(0x1000n, 8, true),
      lnsSetFile(0),
      lnsCopy(),
      lnsAdvancePc(4),
      lnsAdvanceLine(1),
      lnsCopy(),
      lnsAdvancePc(4),
      lneEndSequence(),
    ]),
  });
  const p1 = lineProgram({
    version: 5,
    v5Directories: [{ form: 0x08, inline: "/b" }],
    v5Files: [{ path: { form: 0x1a, strx: 0 }, dirIndex: 0 }],
    opcodes: Buffer.concat([
      lneSetAddress(0x3000n, 8, true),
      lnsSetFile(0),
      lnsCopy(),
      lnsAdvancePc(8),
      lneEndSequence(),
    ]),
  });
  const str = Buffer.from("b.c\0", "utf8");
  const multiStrOffsets = Buffer.concat([
    buildStrOffsetsTable([0]),
    buildStrOffsetsTable([0]),
  ]);
  const twoProgs = Buffer.concat([p0, p1]);

  // max_rows: 0 stays complete and resolves addresses across all CUs
  const rowsZero = parseDwarfLinePrograms({
    line: twoProgs,
    lineStr: null,
    str,
    strOffsets: multiStrOffsets,
    lineFileOffset: 0,
    little: true,
    defaultAddressSize: 8,
    addresses: ["0x3004"],
    maxPrograms: 16,
    maxRows: 0,
    unappliedLineRelocations: [],
    unappliedDebugRelocations: [],
  });
  expect(rowsZero.coverage.status).toBe("complete");
  expect(rowsZero.rows).toEqual([]);
  expect(rowsZero.total_rows).toBe(5);
  expect(rowsZero.limitations).toContain(
    DWARF_LINE_LIMITATIONS.rowsOmittedByCaller,
  );
  expect(rowsZero.programs[1]?.issues.map((i) => i.code)).toContain(
    "str_offsets_base_absent",
  );
  expect(rowsZero.address_matches[0]?.status).toBe("resolved");

  // Exact max_rows = 5 -> complete!
  const exactRows = parseDwarfLinePrograms({
    line: twoProgs,
    lineStr: null,
    str,
    strOffsets: multiStrOffsets,
    lineFileOffset: 0,
    little: true,
    defaultAddressSize: 8,
    maxPrograms: 16,
    maxRows: 5,
    unappliedLineRelocations: [],
    unappliedDebugRelocations: [],
  });
  expect(exactRows.coverage.status).toBe("complete");
  expect(exactRows.rows).toHaveLength(5);

  // max_programs: 1 stops retaining headers & rows after p0, yet still walks p1 for addresses
  const cappedProgs = parseDwarfLinePrograms({
    line: twoProgs,
    lineStr: null,
    str,
    strOffsets: multiStrOffsets,
    lineFileOffset: 0,
    little: true,
    defaultAddressSize: 8,
    addresses: ["0x3004", "0x9999"],
    maxPrograms: 1,
    maxRows: 100,
    unappliedLineRelocations: [],
    unappliedDebugRelocations: [],
  });
  const validatedCapped = assertValidReportSchema(twoProgs, cappedProgs);
  expect(validatedCapped.coverage.status).toBe("partial");
  expect(validatedCapped.programs).toHaveLength(1);
  expect(validatedCapped.rows.every((r) => r.program_index === 0)).toBe(true);
  expect(validatedCapped.address_matches[0]?.status).toBe("resolved");
  expect(validatedCapped.address_matches[1]?.status).toBe("not_found");
});

it("reports missing end_sequence (exact-only match), unsupported versions, and throws typed failures", () => {
  const noEndSeq = lineProgram({
    version: 5,
    v5Directories: [{ form: 0x08, inline: "/src" }],
    v5Files: [{ path: { form: 0x08, inline: "open.c" }, dirIndex: 0 }],
    opcodes: Buffer.concat([
      lneSetAddress(0x5000n, 8, true),
      lnsSetFile(0),
      lnsCopy(),
      lnsAdvancePc(4),
      lnsAdvanceLine(1),
      lnsCopy(),
    ]),
  });

  const badVer = frameUnit(Buffer.from([0x06, 0x00, 0x00, 0x00, 0x00, 0x00]));
  const res = parseDwarfLinePrograms({
    line: Buffer.concat([noEndSeq, badVer]),
    lineStr: null,
    str: null,
    strOffsets: null,
    lineFileOffset: 0,
    little: true,
    defaultAddressSize: 8,
    addresses: ["0x5004", "0x5006"],
    maxPrograms: 16,
    maxRows: 100,
    unappliedLineRelocations: [],
    unappliedDebugRelocations: [],
  });
  expect(res.programs[0]?.issues.map((i) => i.code)).toContain(
    "end_sequence_missing",
  );
  expect(res.programs[1]?.issues.map((i) => i.code)).toContain(
    "unsupported_version",
  );
  expect(res.coverage.status).toBe("partial");
  expect(res.address_matches[0]?.status).toBe("resolved");
  expect(res.address_matches[0]?.matches[0]?.span_end).toBeNull();
  expect(res.address_matches[1]?.status).toBe("incomplete");

  expect(() =>
    parseDwarfLinePrograms({
      line: noEndSeq,
      lineStr: null,
      str: null,
      strOffsets: null,
      lineFileOffset: 0,
      little: true,
      defaultAddressSize: 8,
      programOffset: noEndSeq.length,
      maxPrograms: 16,
      maxRows: 100,
      unappliedLineRelocations: [],
      unappliedDebugRelocations: [],
    }),
  ).toThrowError(ParseFailureError);

  expect(() =>
    parseDwarfLinePrograms({
      line: Buffer.from([0x04, 0x00]),
      lineStr: null,
      str: null,
      strOffsets: null,
      lineFileOffset: 0,
      little: true,
      defaultAddressSize: 8,
      maxPrograms: 16,
      maxRows: 100,
      unappliedLineRelocations: [],
      unappliedDebugRelocations: [],
    }),
  ).toThrowError(ParseFailureError);
});

it("bounds aggregate co-located DW_LNS_copy address matches to 65,536 entries", () => {
  const copyOps = Buffer.alloc(2_200, 0x01); // 2,200 x DW_LNS_copy
  const colocatedProg = lineProgram({
    version: 5,
    opcodes: Buffer.concat([
      lneSetAddress(0x1000n, 8, true),
      lnsSetFile(0),
      copyOps,
      lnsAdvancePc(64),
      lneEndSequence(),
    ]),
  });
  const sixtyFourAddrs = Array.from(
    { length: MAX_INSPECT_DWARF_LINE_ADDRESSES },
    (_, idx) => `0x${(0x1000 + idx).toString(16)}`,
  );
  const cappedMatches = parseDwarfLinePrograms({
    line: colocatedProg,
    lineStr: null,
    str: null,
    strOffsets: null,
    lineFileOffset: 0,
    little: true,
    defaultAddressSize: 8,
    addresses: sixtyFourAddrs,
    maxPrograms: 16,
    maxRows: 0,
    unappliedLineRelocations: [],
    unappliedDebugRelocations: [],
  });
  const totalMatchObjects = cappedMatches.address_matches.reduce(
    (sum, entry) => sum + entry.matches.length,
    0,
  );
  expect(totalMatchObjects).toBe(MAX_DWARF_LINE_ADDRESS_MATCHES);
  expect(cappedMatches.coverage.status).toBe("partial");
  expect(cappedMatches.limitations).toContain(
    DWARF_LINE_LIMITATIONS.addressMatchesTruncated,
  );
  expect(cappedMatches.address_matches.at(-1)?.status).toBe("incomplete");
});

it("charges zero-column DWARF 5 header entries against the aggregate work and allocation budget", () => {
  const headerPayload = Buffer.concat([
    Buffer.from([
      1, // min_instruction_length
      1, // max_ops_per_instruction
      1, // default_is_stmt
      0xfb, // line_base (-5)
      14, // line_range
      13, // opcode_base
      0,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      1,
      0, // directory_entry_format_count = 0
    ]),
    uleb(65_536), // directories_count = 65536
    Buffer.from([0]), // file_name_entry_format_count = 0
    uleb(65_536), // file_names_count = 65536
  ]);
  const hdrLen = Buffer.alloc(4);
  hdrLen.writeUInt32LE(headerPayload.length, 0);
  const body = Buffer.concat([
    Buffer.from([5, 0, 8, 0]), // v5, address_size=8, seg=0
    hdrLen,
    headerPayload,
  ]);
  const unitLen = Buffer.alloc(4);
  unitLen.writeUInt32LE(body.length, 0);
  const v5ZeroColProg = Buffer.concat([unitLen, body]);

  const zeroColRes = parseDwarfLinePrograms({
    line: Buffer.concat(Array.from({ length: 6 }, () => v5ZeroColProg)),
    lineStr: null,
    str: null,
    strOffsets: null,
    lineFileOffset: 0,
    little: true,
    defaultAddressSize: 8,
    addresses: ["0x9999"],
    maxPrograms: 16,
    maxRows: 100,
    unappliedLineRelocations: [],
    unappliedDebugRelocations: [],
  });
  expect(zeroColRes.total_programs).toBeLessThanOrEqual(5);
  expect(zeroColRes.coverage.status).toBe("partial");
  expect(zeroColRes.address_matches[0]?.status).toBe("incomplete");
  expect(
    zeroColRes.programs.some((p) =>
      p.issues.some((i) => i.code === "header_entry_budget"),
    ),
  ).toBe(true);
});

it("keeps aborted opcode decode incomplete even when max_rows was reached during address queries", () => {
  const truncatedAfterRows = lineProgram({
    version: 5,
    opcodes: Buffer.concat([
      lneSetAddress(0x1000n, 8, true),
      lnsSetFile(0),
      lnsCopy(),
      lnsAdvancePc(4),
      lnsCopy(),
      Buffer.from([0x00, 0x09, 0x02, 0x11]), // truncated DW_LNE_set_address (declares len 9, only 2 bytes)
    ]),
  });
  const abortAfterRows = parseDwarfLinePrograms({
    line: truncatedAfterRows,
    lineStr: null,
    str: null,
    strOffsets: null,
    lineFileOffset: 0,
    little: true,
    defaultAddressSize: 8,
    addresses: ["0x9999"],
    maxPrograms: 16,
    maxRows: 1,
    unappliedLineRelocations: [],
    unappliedDebugRelocations: [],
  });
  expect(abortAfterRows.coverage.status).toBe("partial");
  expect(abortAfterRows.address_matches[0]?.status).toBe("incomplete");
});

it("detects external non-empty DW_LNCT_LLVM_source via line_strp, strp, and strx1 without retaining text", () => {
  const lineStrTbl = buildStringTable([
    "main.c",
    "empty.c",
    "int f(void) { return 1; }",
    "",
  ]);
  const strTbl = buildStringTable([
    "int g(void) { return 2; }",
    "int h(void) { return 3; }",
  ]);
  const strOffsTbl = buildStrOffsetsTable([strTbl.offsets[1]!]);
  const u32 = (value: number): Buffer => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value, 0);
    return buf;
  };
  const llvmCols = Buffer.concat([
    Buffer.from([1]), // 1 dir format col
    uleb(1),
    uleb(0x08), // DW_LNCT_path, inline
    uleb(1), // 1 dir
    Buffer.from("/src\0", "utf8"),
    Buffer.from([3]), // 3 file cols: path(indirect), dir_index(udata), LLVM_source(indirect)
    uleb(1),
    uleb(0x16),
    uleb(2),
    uleb(0x0f),
    uleb(0x2001),
    uleb(0x16),
    uleb(4), // 4 files
    // File 0: path line_strp(main.c), LLVM_source line_strp(non-empty)
    uleb(0x1f),
    u32(lineStrTbl.offsets[0]!),
    Buffer.from([0]),
    uleb(0x1f),
    u32(lineStrTbl.offsets[2]!),
    // File 1: path line_strp(empty.c), LLVM_source line_strp("") -> source_present: false
    uleb(0x1f),
    u32(lineStrTbl.offsets[1]!),
    Buffer.from([0]),
    uleb(0x1f),
    u32(lineStrTbl.offsets[3]!),
    // File 2: path inline(s.c), LLVM_source strp(non-empty)
    uleb(0x08),
    Buffer.from("s.c\0", "utf8"),
    Buffer.from([0]),
    uleb(0x0e),
    u32(strTbl.offsets[0]!),
    // File 3: path inline(x.c), LLVM_source strx1(0 non-empty)
    uleb(0x08),
    Buffer.from("x.c\0", "utf8"),
    Buffer.from([0]),
    uleb(0x25),
    Buffer.from([0]),
  ]);
  const llvmHeaderPrefix = Buffer.from([
    1, 1, 1, 0xfb, 14, 13, 0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1,
  ]);
  const llvmProgBody = (() => {
    const fullHdr = Buffer.concat([llvmHeaderPrefix, llvmCols]);
    const hdrLen = Buffer.alloc(4);
    hdrLen.writeUInt32LE(fullHdr.length, 0);
    const body = Buffer.concat([Buffer.from([5, 0, 8, 0]), hdrLen, fullHdr]);
    const unitLen = Buffer.alloc(4);
    unitLen.writeUInt32LE(body.length, 0);
    return Buffer.concat([unitLen, body]);
  })();
  const llvmParsed = parseDwarfLinePrograms({
    line: llvmProgBody,
    lineStr: lineStrTbl.table,
    str: strTbl.table,
    strOffsets: strOffsTbl,
    lineFileOffset: 0,
    little: true,
    defaultAddressSize: 8,
    maxPrograms: 16,
    maxRows: 100,
    unappliedLineRelocations: [],
    unappliedDebugRelocations: [],
  });
  expect(llvmParsed.programs[0]?.files.map((f) => f.source_present)).toEqual([
    true,
    false,
    true,
    true,
  ]);
});

it("bounds repeated directory prefix and path join expansion across files, rows, and address matches", () => {
  const longDir = `/${"a".repeat(63_999)}`; // 64,000 chars (< MAX_DWARF_STRING_BYTES)
  // 1. 64 KiB directory referenced by 2,000 short files (unbounded: ~256 MB of dir + joined path text)
  const manyFilesProg = lineProgram({
    version: 5,
    v5Directories: [{ form: 0x08, inline: longDir }],
    v5Files: Array.from({ length: 2_000 }, (_, i) => ({
      path: { form: 0x08, inline: `f${i}.c` },
      dirIndex: 0,
    })),
    opcodes: Buffer.concat([
      lneSetAddress(0x1000n, 8, true),
      lnsSetFile(0),
      lnsCopy(),
      lnsAdvancePc(4),
      lneEndSequence(),
    ]),
  });
  const expandedRes = assertValidReportSchema(
    manyFilesProg,
    parseDwarfLinePrograms({
      line: manyFilesProg,
      lineStr: null,
      str: null,
      strOffsets: null,
      lineFileOffset: 0,
      little: true,
      defaultAddressSize: 8,
      maxPrograms: 16,
      maxRows: 100,
      unappliedLineRelocations: [],
      unappliedDebugRelocations: [],
    }),
  );
  const firstFile = expandedRes.programs[0]?.files[0];
  const lastFile = expandedRes.programs[0]?.files[1_999];
  expect(firstFile?.directory.state).toBe("present");
  expect(firstFile?.path.value).toBe(`${longDir}/f0.c`);
  expect(lastFile?.name).toEqual({ state: "present", value: "f1999.c" });
  expect(lastFile?.directory).toEqual({ state: "unknown", value: null });
  expect(lastFile?.path).toEqual({ state: "unknown", value: null });
  expect(expandedRes.programs[0]?.issues.map((i) => i.code)).toContain(
    "string_budget",
  );
  expect(expandedRes.coverage.status).toBe("partial");
  expect(expandedRes.limitations).toContain(
    DWARF_LINE_LIMITATIONS.stringExpansionTruncated,
  );
  expect(JSON.stringify(expandedRes).length).toBeLessThan(24 * 1024 * 1024);

  // 2. Single 64 KiB file path referenced by 600 co-located rows + address matches
  const rowBombProg = lineProgram({
    version: 5,
    v5Directories: [{ form: 0x08, inline: longDir }],
    v5Files: [{ path: { form: 0x08, inline: "main.c" }, dirIndex: 0 }],
    opcodes: Buffer.concat([
      lneSetAddress(0x2000n, 8, true),
      lnsSetFile(0),
      Buffer.alloc(600, 0x01), // 600 x DW_LNS_copy
      lnsAdvancePc(8),
      lneEndSequence(),
    ]),
  });
  const rowMatchRes = assertValidReportSchema(
    rowBombProg,
    parseDwarfLinePrograms({
      line: rowBombProg,
      lineStr: null,
      str: null,
      strOffsets: null,
      lineFileOffset: 0,
      little: true,
      defaultAddressSize: 8,
      addresses: ["0x2000", "0x2002", "0x9999"],
      maxPrograms: 16,
      maxRows: 600,
      unappliedLineRelocations: [],
      unappliedDebugRelocations: [],
    }),
  );
  expect(rowMatchRes.coverage.status).toBe("partial");
  expect(rowMatchRes.limitations).toContain(
    DWARF_LINE_LIMITATIONS.stringExpansionTruncated,
  );
  expect(rowMatchRes.limitations).not.toContain(
    DWARF_LINE_LIMITATIONS.addressMatchesTruncated,
  );
  expect(rowMatchRes.rows.length).toBeLessThan(600);
  expect(JSON.stringify(rowMatchRes).length).toBeLessThan(24 * 1024 * 1024);

  // 3. Same match exhaustion under maxRows: 0 reports string budget, not 65536 match cap
  const matchOnlyRes = assertValidReportSchema(
    rowBombProg,
    parseDwarfLinePrograms({
      line: rowBombProg,
      lineStr: null,
      str: null,
      strOffsets: null,
      lineFileOffset: 0,
      little: true,
      defaultAddressSize: 8,
      addresses: ["0x2000", "0x9999"],
      maxPrograms: 16,
      maxRows: 0,
      unappliedLineRelocations: [],
      unappliedDebugRelocations: [],
    }),
  );
  expect(matchOnlyRes.coverage.status).toBe("partial");
  expect(matchOnlyRes.coverage.reason).toContain("string expansion exceeded");
  expect(matchOnlyRes.limitations).toContain(
    DWARF_LINE_LIMITATIONS.stringExpansionTruncated,
  );
  expect(matchOnlyRes.limitations).not.toContain(
    DWARF_LINE_LIMITATIONS.addressMatchesTruncated,
  );
  expect(matchOnlyRes.address_matches[0]?.matches.length).toBeLessThan(600);
  expect(matchOnlyRes.address_matches[1]?.status).toBe("incomplete");
});

it("assigns distinct sequence_index values after reaching MAX_DWARF_LINE_SEQUENCES under max_rows: 0", () => {
  const totalSeqs = MAX_DWARF_LINE_SEQUENCES + 2;
  const perSeqBytes = 17; // 11 (lneSetAddress) + 1 (lnsCopy) + 2 (lnsAdvancePc) + 3 (lneEndSequence)
  const opcodes = Buffer.allocUnsafe(totalSeqs * perSeqBytes);
  for (let i = 0; i < totalSeqs; i += 1) {
    const off = i * perSeqBytes;
    const addr = 0x1000n + BigInt(i * 2);
    opcodes[off] = 0x00;
    opcodes[off + 1] = 0x09;
    opcodes[off + 2] = 0x02;
    opcodes.writeBigUInt64LE(addr, off + 3);
    opcodes[off + 11] = 0x01; // DW_LNS_copy
    opcodes[off + 12] = 0x02; // DW_LNS_advance_pc
    opcodes[off + 13] = 0x02; // +2
    opcodes[off + 14] = 0x00;
    opcodes[off + 15] = 0x01;
    opcodes[off + 16] = 0x01; // DW_LNE_end_sequence
  }
  const prog = lineProgram({
    version: 4,
    legacyDirectories: ["/src"],
    legacyFiles: [{ name: "seq.c", dirIndex: 1 }],
    opcodes,
  });
  const addrPost1 = `0x${(0x1000 + MAX_DWARF_LINE_SEQUENCES * 2).toString(16)}`;
  const addrPost2 = `0x${(0x1000 + (MAX_DWARF_LINE_SEQUENCES + 1) * 2).toString(16)}`;
  const res = assertValidReportSchema(
    prog,
    parseDwarfLinePrograms({
      line: prog,
      lineStr: null,
      str: null,
      strOffsets: null,
      lineFileOffset: 0,
      little: true,
      defaultAddressSize: 8,
      addresses: [addrPost1, addrPost2],
      maxPrograms: 16,
      maxRows: 0,
      unappliedLineRelocations: [],
      unappliedDebugRelocations: [],
    }),
  );
  expect(res.programs[0]?.sequences.length).toBe(MAX_DWARF_LINE_SEQUENCES);
  expect(res.coverage.status).toBe("partial");
  expect(res.coverage.reason).toContain(String(MAX_DWARF_LINE_SEQUENCES));
  expect(res.address_matches[0]?.status).toBe("resolved");
  expect(res.address_matches[1]?.status).toBe("resolved");
  expect(res.address_matches[0]?.matches[0]?.sequence_index).toBe(
    MAX_DWARF_LINE_SEQUENCES,
  );
  expect(res.address_matches[1]?.matches[0]?.sequence_index).toBe(
    MAX_DWARF_LINE_SEQUENCES + 1,
  );
});

it("emits exact-only null span_end for descending rows and descending end_sequence", () => {
  const descendingRowProg = lineProgram({
    version: 5,
    v5Directories: [{ form: 0x08, inline: "/src" }],
    v5Files: [{ path: { form: 0x08, inline: "desc.c" }, dirIndex: 0 }],
    opcodes: Buffer.concat([
      lneSetAddress(0x2000n, 8, true),
      lnsSetFile(0),
      lnsCopy(),
      lneSetAddress(0x1000n, 8, true),
      lnsAdvanceLine(1),
      lnsCopy(),
      lnsAdvancePc(0x10),
      lneEndSequence(),
    ]),
  });
  const res1 = assertValidReportSchema(
    descendingRowProg,
    parseDwarfLinePrograms({
      line: descendingRowProg,
      lineStr: null,
      str: null,
      strOffsets: null,
      lineFileOffset: 0,
      little: true,
      defaultAddressSize: 8,
      addresses: ["0x2000", "0x2001", "0x1004"],
      maxPrograms: 16,
      maxRows: 100,
      unappliedLineRelocations: [],
      unappliedDebugRelocations: [],
    }),
  );
  expect(res1.address_matches[0]?.status).toBe("resolved");
  expect(res1.address_matches[0]?.matches[0]).toMatchObject({
    exact: true,
    span_start: "0x2000",
    span_end: null,
    line: 1,
  });
  expect(res1.address_matches[1]?.status).toBe("not_found");
  expect(res1.address_matches[2]?.status).toBe("resolved");
  expect(res1.address_matches[2]?.matches[0]).toMatchObject({
    exact: false,
    span_start: "0x1000",
    span_end: "0x1010",
    line: 2,
  });

  const descendingEndProg = lineProgram({
    version: 5,
    v5Directories: [{ form: 0x08, inline: "/src" }],
    v5Files: [{ path: { form: 0x08, inline: "desc_end.c" }, dirIndex: 0 }],
    opcodes: Buffer.concat([
      lneSetAddress(0x1000n, 8, true),
      lnsSetFile(0),
      lnsCopy(),
      lneSetAddress(0x2000n, 8, true),
      lnsAdvanceLine(2),
      lnsCopy(),
      lneSetAddress(0x1800n, 8, true),
      lneEndSequence(),
    ]),
  });
  const res2 = assertValidReportSchema(
    descendingEndProg,
    parseDwarfLinePrograms({
      line: descendingEndProg,
      lineStr: null,
      str: null,
      strOffsets: null,
      lineFileOffset: 0,
      little: true,
      defaultAddressSize: 8,
      addresses: ["0x2000", "0x2001"],
      maxPrograms: 16,
      maxRows: 100,
      unappliedLineRelocations: [],
      unappliedDebugRelocations: [],
    }),
  );
  expect(res2.address_matches[0]?.status).toBe("resolved");
  expect(res2.address_matches[0]?.matches[0]).toMatchObject({
    exact: true,
    span_start: "0x2000",
    span_end: null,
    line: 3,
  });
  expect(res2.address_matches[1]?.status).toBe("not_found");
});
