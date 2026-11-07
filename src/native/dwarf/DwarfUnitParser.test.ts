import { expect, it } from "vitest";
import {
  MAX_DWARF_ABBREV_ENTRIES,
  MAX_DWARF_STRING_BYTES,
} from "../../domain/native/dwarfUnits.js";
import { parseDwarfCompileUnits } from "./DwarfUnitParser.js";
import {
  abbrevTable,
  compileUnit,
  frameUnit,
  namedUnit,
  strxBeforeBase,
  uleb,
} from "./DwarfUnits.fixture.js";

const walk = (
  info: Buffer,
  abbrev: Buffer | null,
  extra: {
    readonly str?: Buffer;
    readonly strOffsets?: Buffer;
    readonly little?: boolean;
    readonly pageOffset?: number;
    readonly pageLimit?: number;
    readonly infoFileOffset?: number | null;
    readonly debugRelocationsUnapplied?: boolean;
  } = {},
) =>
  parseDwarfCompileUnits({
    info,
    abbrev,
    str: extra.str ?? null,
    lineStr: null,
    strOffsets: extra.strOffsets ?? null,
    little: extra.little ?? true,
    infoFileOffset:
      extra.infoFileOffset === undefined ? 0x100 : extra.infoFileOffset,
    pageOffset: extra.pageOffset ?? 0,
    pageLimit: extra.pageLimit ?? 32,
    debugRelocationsUnapplied: extra.debugRelocationsUnapplied ?? false,
  });

it.each([2, 3, 4])(
  "retains only decoded fields in truncated DWARF %i headers",
  (version) => {
    for (const dwarf64 of [false, true]) {
      const header = Buffer.from([version, 0]);
      const truncatedOffset = walk(
        frameUnit(Buffer.concat([header, Buffer.from([8])]), true, dwarf64),
        null,
      ).units[0];
      expect(truncatedOffset).toMatchObject({
        version,
        abbrev_offset: null,
        address_size: null,
        issues: [
          {
            code: "truncated_header",
            detail: "Abbreviation offset is truncated",
          },
        ],
      });

      const offset = Buffer.alloc(dwarf64 ? 8 : 4);
      offset[0] = 8;
      const missingAddressSize = walk(
        frameUnit(Buffer.concat([header, offset]), true, dwarf64),
        null,
      ).units[0];
      expect(missingAddressSize).toMatchObject({
        version,
        abbrev_offset: 8,
        address_size: null,
        issues: [
          { code: "truncated_header", detail: "Address size is truncated" },
        ],
      });
    }
  },
);

it("reads a unit DIE and stops when a later length does not frame the next unit", () => {
  const named = namedUnit({ name: "kept.c" });
  const parsed = walk(
    Buffer.concat([named.info, Buffer.from([1, 2, 3])]),
    named.abbrev,
  );
  expect(parsed.total_units).toBe(1);
  expect(parsed.coverage.status).toBe("partial");
  expect(parsed.coverage.reason).toContain("truncated");
  expect(parsed.coverage.reason).toContain("does not frame the next unit");
  expect(parsed.units[0]).toMatchObject({
    name: { state: "present", value: "kept.c" },
    comp_dir: { state: "present", value: "/src" },
    producer: { state: "present", value: "clang" },
    language: { state: "present", value: 0x0c },
    language_name: "C99",
    die_complete: true,
  });
});

it("records an abbreviation offset past the section and still returns the next framed unit", () => {
  const first = compileUnit({ abbrevOffset: 0x00ffffff, attributes: [] });
  const second = namedUnit({ name: "next.c" });
  const parsed = walk(Buffer.concat([first, second.info]), second.abbrev);
  expect(parsed.coverage).toEqual({ status: "complete", reason: null });
  expect(parsed.total_units).toBe(2);
  expect(parsed.units[0]?.issues.map((issue) => issue.code)).toContain(
    "abbrev_offset_out_of_range",
  );
  expect(parsed.units[1]?.name).toEqual({
    state: "present",
    value: "next.c",
  });
});

it("names an unknown form and continues to the next unit", () => {
  const abbrev = abbrevTable([
    {
      code: 1,
      tag: 0x11,
      children: false,
      attributes: [{ name: 0x03, form: 0x99 }],
    },
    {
      code: 2,
      tag: 0x11,
      children: false,
      attributes: [{ name: 0x03, form: 0x08 }],
    },
  ]);
  const info = Buffer.concat([
    compileUnit({ code: 1, attributes: [Buffer.from([0])] }),
    compileUnit({
      code: 2,
      attributes: [Buffer.from("second.c\0", "latin1")],
    }),
  ]);
  const parsed = walk(info, abbrev);
  expect(parsed.total_units).toBe(2);
  expect(parsed.coverage.status).toBe("complete");
  expect(parsed.units[0]?.issues[0]).toMatchObject({
    code: "unknown_form",
    detail: "Unknown DW_FORM 153 (0x99)",
  });
  expect(parsed.units[0]?.die_complete).toBe(false);
  expect(parsed.units[1]?.name.value).toBe("second.c");
});

it("resolves DW_FORM_strx when DW_AT_str_offsets_base appears later in the DIE", () => {
  const sample = strxBeforeBase();
  const parsed = walk(sample.info, sample.abbrev, {
    str: sample.str,
    strOffsets: sample.strOffsets,
  });
  expect(parsed.units[0]?.name).toEqual({
    state: "present",
    value: "hello.c",
  });
  expect(parsed.units[0]?.issues).toEqual([]);
  expect(parsed.units[0]?.version).toBe(5);
  expect(parsed.units[0]?.unit_type).toBe(1);
});

it.each([
  { little: true, dwarf64: false },
  { little: false, dwarf64: false },
  { little: true, dwarf64: true },
  { little: false, dwarf64: true },
])(
  "bounds string indexes to their DWARF 5 contribution: %j",
  ({ little, dwarf64 }) => {
    const offsetSize = dwarf64 ? 8 : 4;
    const base = dwarf64 ? 16 : 8;
    const offset = (value: number): Buffer => {
      const bytes = Buffer.alloc(offsetSize);
      if (dwarf64) {
        if (little) bytes.writeBigUInt64LE(BigInt(value));
        else bytes.writeBigUInt64BE(BigInt(value));
      } else if (little) bytes.writeUInt32LE(value);
      else bytes.writeUInt32BE(value);
      return bytes;
    };
    const header = Buffer.from(little ? [5, 0, 0, 0] : [0, 5, 0, 0]);
    const contribution = (value: number): Buffer =>
      frameUnit(Buffer.concat([header, offset(value)]), little, dwarf64);
    const strOffsets = Buffer.concat([contribution(0), contribution(8)]);
    const abbrev = abbrevTable([
      {
        code: 1,
        tag: 0x11,
        children: false,
        attributes: [
          { name: 0x03, form: 0x1a },
          { name: 0x72, form: 0x17 },
        ],
      },
    ]);
    const parse = (index: number, origin = base, table: Buffer = strOffsets) =>
      walk(
        compileUnit({
          version: 5,
          unitType: 1,
          dwarf64,
          little,
          attributes: [uleb(index), offset(origin)],
        }),
        abbrev,
        { little, str: Buffer.from("first.c\0second.c\0"), strOffsets: table },
      ).units[0];
    expect(parse(0)?.name.value).toBe("first.c");
    expect(parse(0, contribution(0).length + base)?.name.value).toBe(
      "second.c",
    );
    const escaped = parse(3);
    expect(escaped?.name).toEqual({ state: "unresolved", value: null });
    expect(escaped?.issues.map((issue) => issue.code)).toContain(
      "string_unresolved",
    );
    for (const table of [
      strOffsets.subarray(0, base + offsetSize - 1),
      Buffer.concat([Buffer.alloc(base), offset(0)]),
      frameUnit(Buffer.concat([Buffer.alloc(4), offset(0)]), little, dwarf64),
    ]) {
      expect(parse(0, base, table)?.name.state).toBe("unresolved");
    }
  },
);

it("decodes chained indirect forms and the following DIE attributes", () => {
  const abbrev = abbrevTable([
    {
      code: 1,
      tag: 0x11,
      children: false,
      attributes: [
        { name: 0x03, form: 0x16 },
        { name: 0x25, form: 0x08 },
      ],
    },
  ]);
  const parsed = walk(
    compileUnit({
      version: 4,
      attributes: [uleb(0x16), uleb(0x08), Buffer.from("valid.c\0clang\0")],
    }),
    abbrev,
  );
  expect(parsed.units[0]).toMatchObject({
    name: { state: "present", value: "valid.c" },
    producer: { state: "present", value: "clang" },
    die_complete: true,
    issues: [],
  });
});

it("stops a truncated indirect chain without consuming the next unit", () => {
  const abbrev = abbrevTable([
    {
      code: 1,
      tag: 0x11,
      children: false,
      attributes: [{ name: 0x03, form: 0x16 }],
    },
  ]);
  const parsed = walk(
    Buffer.concat([
      compileUnit({ attributes: [Buffer.alloc(4096, 0x16)] }),
      compileUnit({ attributes: [uleb(0x08), Buffer.from("next.c\0")] }),
    ]),
    abbrev,
  );
  expect(parsed.units[0]?.name.state).toBe("unknown");
  expect(parsed.units[0]?.issues[0]?.code).toBe("truncated_die");
  expect(parsed.units[1]?.name.value).toBe("next.c");
});

it("does not read strx, GNU str indexes, or str_offsets_base while ET_REL relocations are unapplied", () => {
  const str = Buffer.from("wrong\0right\0", "latin1");
  const strOffsets = Buffer.alloc(8);
  strOffsets.writeUInt32LE(0, 0);
  strOffsets.writeUInt32LE(6, 4);
  const abbrev = abbrevTable([
    {
      code: 1,
      tag: 0x11,
      children: false,
      attributes: [
        { name: 0x03, form: 0x1a },
        { name: 0x1b, form: 0x25 },
        { name: 0x25, form: 0x1f02 },
        { name: 0x76, form: 0x1a },
        { name: 0x72, form: 0x17 },
      ],
    },
  ]);
  const info = compileUnit({
    version: 5,
    unitType: 1,
    attributes: [
      uleb(1),
      Buffer.from([1]),
      uleb(1),
      uleb(0),
      Buffer.from([8, 0, 0, 0]),
    ],
  });
  const dwarf5Offsets = frameUnit(
    Buffer.concat([Buffer.from([5, 0, 0, 0]), strOffsets]),
  );
  const applied = walk(info, abbrev, { str, strOffsets: dwarf5Offsets });
  expect(applied.units[0]).toMatchObject({
    name: { state: "present", value: "right" },
    comp_dir: { state: "present", value: "right" },
    producer: { state: "present", value: "right" },
    dwo_name: { state: "present", value: "wrong" },
    issues: [],
  });
  const unresolved = { state: "unresolved" as const, value: null };
  const unapplied = walk(info, abbrev, {
    str,
    strOffsets: dwarf5Offsets,
    debugRelocationsUnapplied: true,
  });
  expect(unapplied.units[0]).toMatchObject({
    name: unresolved,
    comp_dir: unresolved,
    producer: unresolved,
    dwo_name: unresolved,
  });
  expect(unapplied.units[0]?.issues.map((issue) => issue.detail)).toEqual([
    "Relocatable ELF debug relocations were not applied",
    "Relocatable ELF debug relocations were not applied",
    "Relocatable ELF debug relocations were not applied",
    "Relocatable ELF debug relocations were not applied",
  ]);
  const gnuAbbrev = abbrevTable([
    {
      code: 1,
      tag: 0x11,
      children: false,
      attributes: [{ name: 0x03, form: 0x1f02 }],
    },
  ]);
  const gnuInfo = compileUnit({ version: 4, attributes: [uleb(0)] });
  expect(walk(gnuInfo, gnuAbbrev, { str, strOffsets }).units[0]?.name).toEqual({
    state: "present",
    value: "wrong",
  });
  const gnu = walk(gnuInfo, gnuAbbrev, {
    str,
    strOffsets,
    debugRelocationsUnapplied: true,
  });
  expect(gnu.units[0]?.name).toEqual(unresolved);
  expect(gnu.units[0]?.issues.map((issue) => issue.code)).toEqual([
    "unapplied_relocation",
  ]);
  const wide = walk(
    compileUnit({
      version: 5,
      unitType: 1,
      dwarf64: true,
      attributes: [uleb(0), Buffer.alloc(8, 0xff)],
    }),
    abbrevTable([
      {
        code: 1,
        tag: 0x11,
        children: false,
        attributes: [
          { name: 0x03, form: 0x1a },
          { name: 0x72, form: 0x17 },
        ],
      },
    ]),
    { str, strOffsets, debugRelocationsUnapplied: true },
  );
  expect(wide.units[0]?.name).toEqual(unresolved);
  expect(wide.units[0]?.issues.map((issue) => issue.code)).toEqual([
    "unapplied_relocation",
  ]);
});

it("frames a 64-bit DWARF unit, including the 12-byte initial length", () => {
  const named = namedUnit({ dwarf64: true, addressSize: 1, name: "wide.c" });
  const parsed = walk(named.info, named.abbrev);
  expect(named.info.readUInt32LE(0)).toBe(0xffffffff);
  expect(parsed.units[0]).toMatchObject({
    offset_size: 8,
    address_size: 1,
    length: named.info.length,
    name: { state: "present", value: "wide.c" },
    file_offset: 0x100,
  });
  expect(parsed.units[0]?.length).toBe(12 + (named.info.length - 12));
});

it("reads a big-endian unit header and inline strings", () => {
  const named = namedUnit({ little: false, name: "be.c", compDir: "/be" });
  const parsed = walk(named.info, named.abbrev, { little: false });
  expect(parsed.units[0]).toMatchObject({
    version: 4,
    name: { state: "present", value: "be.c" },
    comp_dir: { state: "present", value: "/be" },
  });
});

it("pages units by offset and limit without dropping the census", () => {
  const units = [0, 1, 2].map((index) =>
    namedUnit({ name: `u${String(index)}.c` }),
  );
  const parsed = walk(
    Buffer.concat(units.map((unit) => unit.info)),
    units[0]!.abbrev,
    { pageOffset: 1, pageLimit: 1 },
  );
  expect(parsed.total_units).toBe(3);
  expect(parsed.units).toHaveLength(1);
  expect(parsed.units[0]?.name.value).toBe("u1.c");
});

it("keeps an unsupported version unknown and names Rust from implicit_const", () => {
  const unsupported = walk(frameUnit(Buffer.from([1, 0])), Buffer.from([0]));
  expect(unsupported.units[0]).toMatchObject({
    version: 1,
    tag: null,
    die_complete: false,
    low_pc_present: null,
    name: { state: "unknown", value: null },
  });
  expect(unsupported.units[0]?.issues[0]?.code).toBe("unsupported_version");
  const abbrev = abbrevTable([
    {
      code: 1,
      tag: 0x11,
      children: false,
      attributes: [{ name: 0x13, form: 0x21, implicit: 0x1c }],
    },
  ]);
  const rust = walk(compileUnit({ attributes: [] }), abbrev);
  expect(rust.units[0]).toMatchObject({
    language: { state: "present", value: 0x1c },
    language_name: "Rust",
    die_complete: true,
    low_pc_present: false,
  });
});

it("keeps a skeleton dwo_name", () => {
  const named = namedUnit({ version: 5, dwoName: "main.dwo" });
  const parsed = walk(named.info, named.abbrev);
  expect(parsed.units[0]).toMatchObject({
    version: 5,
    dwo_name: { state: "present", value: "main.dwo" },
  });
});

it("reads DW_AT_GNU_dwo_name and does not take DW_AT_GNU_dwo_id for a name", () => {
  const skeleton = walk(
    compileUnit({
      version: 4,
      attributes: [Buffer.from("main.dwo\0", "latin1"), Buffer.alloc(8, 0xab)],
    }),
    abbrevTable([
      {
        code: 1,
        tag: 0x11,
        children: false,
        attributes: [
          { name: 0x2130, form: 0x08 },
          { name: 0x2131, form: 0x07 },
        ],
      },
    ]),
  );
  expect(skeleton.units[0]).toMatchObject({
    dwo_name: { state: "present", value: "main.dwo" },
    issues: [],
  });
  const idOnly = walk(
    compileUnit({ version: 4, attributes: [Buffer.alloc(8, 0xab)] }),
    abbrevTable([
      {
        code: 1,
        tag: 0x11,
        children: false,
        attributes: [{ name: 0x2131, form: 0x07 }],
      },
    ]),
  );
  expect(idOnly.units[0]).toMatchObject({
    dwo_name: { state: "absent", value: null },
    issues: [],
  });
});

it("keeps stmt_list unresolved while ET_REL relocations are unapplied", () => {
  const abbrev = abbrevTable([
    {
      code: 1,
      tag: 0x11,
      children: false,
      attributes: [{ name: 0x10, form: 0x17 }],
    },
  ]);
  const info = compileUnit({ attributes: [Buffer.alloc(4)] });
  expect(walk(info, abbrev).units[0]?.stmt_list).toEqual({
    state: "present",
    value: 0,
  });
  const unapplied = walk(info, abbrev, { debugRelocationsUnapplied: true });
  expect(unapplied.units[0]?.stmt_list).toEqual({
    state: "unresolved",
    value: null,
  });
  expect(unapplied.units[0]?.issues).toEqual([
    {
      code: "unapplied_relocation",
      detail: "Relocatable ELF debug relocations were not applied",
    },
  ]);
  const absent = walk(
    compileUnit({ attributes: [] }),
    abbrevTable([{ code: 1, tag: 0x11, children: false, attributes: [] }]),
    { debugRelocationsUnapplied: true },
  );
  expect(absent.units[0]?.stmt_list).toEqual({ state: "absent", value: null });
});

it("selects an abbreviation table through an unapplied ET_REL offset only when one table exists", () => {
  const inline = abbrevTable([
    {
      code: 1,
      tag: 0x11,
      children: false,
      attributes: [{ name: 0x03, form: 0x08 }],
    },
  ]);
  const other = abbrevTable([
    {
      code: 1,
      tag: 0x34,
      children: false,
      attributes: [{ name: 0x25, form: 0x08 }],
    },
  ]);
  const placeholder = compileUnit({
    attributes: [Buffer.from("first.c\0", "latin1")],
  });
  const single = walk(placeholder, inline, {
    debugRelocationsUnapplied: true,
  });
  expect(single.units[0]).toMatchObject({
    abbrev_offset: 0,
    name: { state: "present", value: "first.c" },
    issues: [],
  });
  const merged = walk(
    Buffer.concat([placeholder, placeholder]),
    Buffer.concat([inline, other]),
    { debugRelocationsUnapplied: true },
  );
  expect(merged.total_units).toBe(2);
  for (const unit of merged.units) {
    expect(unit).toMatchObject({
      abbrev_offset: null,
      tag: null,
      die_complete: false,
      name: { state: "unknown", value: null },
    });
    expect(unit.issues.map((issue) => issue.code)).toEqual([
      "unapplied_relocation",
    ]);
  }
  const nonzero = walk(
    compileUnit({ abbrevOffset: 1, attributes: [] }),
    inline,
    { debugRelocationsUnapplied: true },
  );
  expect(nonzero.units[0]?.issues[0]?.code).toBe("unapplied_relocation");
});

it("reports incomplete DIEs after aggregate abbreviation work is exhausted", () => {
  const table = abbrevTable(
    Array.from({ length: MAX_DWARF_ABBREV_ENTRIES }, (_, index) => ({
      code: index + 1,
      tag: 0x11,
      children: false,
      attributes: [],
    })),
  );
  const info = Buffer.concat(
    Array.from({ length: 256 }, (_, index) =>
      compileUnit({
        abbrevOffset: index % 2 === 0 ? 0 : 5,
        code: index % 2 === 0 ? 1 : 2,
      }),
    ),
  );
  const parsed = walk(info, table, { pageLimit: 256 });
  expect(parsed.total_units).toBe(256);
  expect(parsed.coverage).toEqual({ status: "complete", reason: null });
  expect(parsed.units[0]?.die_complete).toBe(true);
  expect(parsed.units.at(-1)).toMatchObject({
    die_complete: false,
    name: { state: "unknown", value: null },
    issues: [
      {
        code: "abbrev_budget",
        detail: expect.stringContaining("aggregate parsing work allowance"),
      },
    ],
  });
});

it("decodes every unit of a page whose abbreviation tables exceed one table's budget together", () => {
  const entries = Math.ceil(MAX_DWARF_ABBREV_ENTRIES / 2) + 1;
  const table = abbrevTable(
    Array.from({ length: entries }, (_, index) => ({
      code: index + 1,
      tag: 0x11,
      children: false,
      attributes: [{ name: 0x03, form: 0x08 }],
    })),
  );
  const abbrev = Buffer.concat([table, table, table]);
  const info = Buffer.concat(
    [0, 1, 2].map((index) =>
      compileUnit({
        abbrevOffset: index * table.length,
        attributes: [Buffer.from(`u${String(index)}.c\0`, "latin1")],
      }),
    ),
  );
  const whole = walk(info, abbrev, { pageLimit: 3 });
  expect(whole.units.map((unit) => unit.name.value)).toEqual([
    "u0.c",
    "u1.c",
    "u2.c",
  ]);
  expect(whole.units.flatMap((unit) => unit.issues)).toEqual([]);
  const last = walk(info, abbrev, { pageOffset: 2, pageLimit: 1 });
  expect(last.units[0]).toEqual(whole.units[2]);
});

it("names an unavailable .debug_abbrev instead of a malformed table", () => {
  const parsed = walk(compileUnit({ attributes: [] }), null);
  expect(parsed.units[0]).toMatchObject({
    abbrev_offset: 0,
    die_complete: false,
    name: { state: "unknown", value: null },
    issues: [
      {
        code: "abbrev_unavailable",
        detail: ".debug_abbrev was not available",
      },
    ],
  });
});

it("does not file a numeric form mismatch under a string issue", () => {
  const parsed = walk(
    compileUnit({ attributes: [Buffer.from("x\0", "latin1")] }),
    abbrevTable([
      {
        code: 1,
        tag: 0x11,
        children: false,
        attributes: [{ name: 0x13, form: 0x08 }],
      },
    ]),
  );
  expect(parsed.units[0]?.language.state).toBe("unresolved");
  expect(parsed.units[0]?.issues[0]?.code).toBe("value_unresolved");
});

it("keeps an indexed string unknown when str_offsets_base was not decoded", () => {
  const stopBeforeBase = (
    version: number,
    form: number,
  ): {
    readonly info: Buffer;
    readonly abbrev: Buffer;
  } => ({
    abbrev: abbrevTable([
      {
        code: 1,
        tag: 0x11,
        children: false,
        attributes: [
          { name: 0x03, form },
          { name: 0x25, form: 0x99 },
          { name: 0x72, form: 0x17 },
        ],
      },
    ]),
    info: compileUnit({
      version,
      ...(version >= 5 ? { unitType: 1 } : {}),
      attributes: [uleb(0)],
    }),
  });
  const str = Buffer.from("wrong\0right\0", "latin1");
  const strOffsets = Buffer.alloc(8);
  strOffsets.writeUInt32LE(0, 0);
  strOffsets.writeUInt32LE(6, 4);
  const dwarf5 = stopBeforeBase(5, 0x1a);
  const indexed = walk(dwarf5.info, dwarf5.abbrev, { str, strOffsets });
  expect(indexed.units[0]?.name).toEqual({ state: "unknown", value: null });
  expect(indexed.units[0]?.issues.map((issue) => issue.code)).toContain(
    "unknown_form",
  );
  expect(indexed.units[0]?.issues.map((issue) => issue.code)).not.toContain(
    "str_offsets_base_absent",
  );
  expect(
    indexed.units[0]?.issues.map((issue) => issue.detail).join("\n"),
  ).toContain("was not decoded");
  const gnu = stopBeforeBase(4, 0x1f02);
  const legacy = walk(gnu.info, gnu.abbrev, { str, strOffsets });
  expect(legacy.units[0]?.name).toEqual({ state: "unknown", value: null });
  expect(
    legacy.units[0]?.issues.map((issue) => issue.detail).join("\n"),
  ).not.toContain("wrong");
  const absentBase = abbrevTable([
    {
      code: 1,
      tag: 0x11,
      children: false,
      attributes: [{ name: 0x03, form: 0x1f02 }],
    },
  ]);
  const origin = walk(
    compileUnit({ version: 4, attributes: [uleb(0)] }),
    absentBase,
    { str, strOffsets },
  );
  expect(origin.units[0]?.name).toEqual({ state: "present", value: "wrong" });
});

it("does not scan a string section past the retained cap", () => {
  const abbrev = abbrevTable([
    {
      code: 1,
      tag: 0x11,
      children: false,
      attributes: [{ name: 0x03, form: 0x0e }],
    },
  ]);
  const info = compileUnit({ attributes: [Buffer.alloc(4)] });
  const capped = walk(info, abbrev, {
    str: Buffer.alloc(MAX_DWARF_STRING_BYTES + 32, 0x41),
  });
  expect(capped.units[0]?.name).toEqual({ state: "unresolved", value: null });
  expect(capped.units[0]?.issues[0]?.detail).toBe(
    "String exceeds the retained byte cap",
  );
  const open = walk(info, abbrev, { str: Buffer.from([0x41, 0x41]) });
  expect(open.units[0]?.issues[0]?.detail).toBe("String is not NUL-terminated");
  const body = Buffer.alloc(MAX_DWARF_STRING_BYTES, 0x42);
  const kept = walk(info, abbrev, {
    str: Buffer.concat([body, Buffer.from([0]), Buffer.alloc(8, 0x43)]),
  });
  expect(kept.units[0]?.name).toEqual({
    state: "present",
    value: body.toString("latin1"),
  });
});

it("does not count a zero abbrev code as an unknown form", () => {
  const abbrev = abbrevTable([
    { code: 1, tag: 0x11, children: false, attributes: [] },
  ]);
  const parsed = walk(compileUnit({ code: 0, attributes: [] }), abbrev);
  expect(parsed.units[0]).toMatchObject({
    tag: null,
    die_complete: true,
    low_pc_present: false,
    name: { state: "absent", value: null },
    issues: [],
  });
  expect(uleb(0).equals(Buffer.from([0]))).toBe(true);
});
