import { ArtifactReaderFailure } from "../../resources/ArtifactReader.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  inspectPeLoadConfigInputSchema,
  peLoadConfigSchema,
  type PeLoadConfigField,
} from "../../domain/native/peLoadConfig.js";
import {
  parsePeLoadConfig,
  parsePeLoadConfigFromImage,
} from "./PeLoadConfigParser.js";
import { readPeHardening } from "../hardening/PeHardening.js";
import { readPeImage } from "../../domain/native/peImage.js";
import {
  PE_LOAD_CONFIG_FIXTURE,
  peLoadConfigImage,
  peManySectionsImage,
  type PeLoadConfigFixtureOptions,
} from "./PeLoadConfig.fixture.js";

/** Element reads of every parsed image's section and mapping tables. */
const tableReads = vi.hoisted(() => ({
  count: 0,
  budget: Infinity,
  imageReads: 0,
}));
vi.mock("../../domain/native/peImage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../domain/native/peImage.js")>();
  const counted = <T extends object>(table: readonly T[]): readonly T[] =>
    new Proxy(table, {
      get(target, key, receiver) {
        // Past the budget a walk fails at once instead of finishing.
        if (
          typeof key === "string" &&
          /^\d+$/u.test(key) &&
          ++tableReads.count > tableReads.budget
        )
          throw new Error("Image table read budget exceeded");
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
  return {
    ...actual,
    readPeImage: (bytes: Buffer) => {
      tableReads.imageReads++;
      const image = actual.readPeImage(bytes);
      return {
        ...image,
        sections: counted(image.sections),
        mappings: counted(image.mappings),
      };
    },
  };
});

const input = inspectPeLoadConfigInputSchema.parse({ path: "/sample.exe" });

const parseBytes = (
  bytes: Buffer,
  max_callbacks = input.max_callbacks,
  signal?: AbortSignal,
) =>
  parsePeLoadConfig(
    bytes,
    { path: input.path, sha256: "a".repeat(64), bytes: bytes.length },
    { ...input, max_callbacks },
    signal,
  );

const parse = (
  options: PeLoadConfigFixtureOptions = {},
  max_callbacks?: number,
) => parseBytes(peLoadConfigImage(options), max_callbacks);

describe.each([32, 64] as const)("PE%s load configuration", (bits) => {
  it("locates callbacks and separates flag claims", async () => {
    const report = await parse({ bits });
    expect(peLoadConfigSchema.safeParse(report).success).toBe(true);
    expect(report.tls?.callbacks).toHaveLength(3);
    // The callback array starts at file offset 0x800 and includes its null slot.
    expect(report.tls?.callback_array_locations).toEqual([
      { offset: 0x800, bytes: bits === 32 ? 16 : 32 },
    ]);
    expect(report.tls?.callbacks[0]).toMatchObject({
      rva: 0x2000,
      file_offset: 0x1600,
      section: ".text",
    });
    expect(report.tls?.callbacks[2]).toMatchObject({
      rva: 0x9000,
      file_offset: null,
      section: null,
    });
    expect(report.load_config?.guard_flags?.raw).toBe(0x500);
    expect(report.load_config?.inferences[0]?.evidence_kind).toBe("inferred");
    expect(report.load_config?.se_handler_count).toBe(bits === 32 ? 2 : null);
  });
  it.each([
    {
      layout: "file-backed",
      start: 0x2100,
      end: 0x2200,
      fileOffset: 0x1700,
      section: ".text",
      dataSection: ".data",
    },
    {
      layout: "file and zero-fill",
      start: 0x2180,
      end: 0x2280,
      fileOffset: null,
      section: ".text",
      dataSection: ".data",
    },
    {
      layout: "zero-fill only",
      start: 0x2200,
      end: 0x2300,
      fileOffset: null,
      section: ".text",
      dataSection: ".data",
    },
    {
      layout: "crossing two sections with the same name",
      start: 0x1f80,
      end: 0x2080,
      fileOffset: 0x1580,
      section: null,
      dataSection: ".text",
    },
  ] as const)(
    "retains only established TLS template locations for $layout",
    async ({ start, end, fileOffset, section, dataSection }) => {
      const bytes = peLoadConfigImage({
        bits,
        zeroFillCallback: true,
        rawDataRange: [start, end],
      });
      if (dataSection !== ".data") {
        const header = bytes.readUInt32LE(60);
        const firstSection = header + 24 + bytes.readUInt16LE(header + 20);
        bytes.fill(0, firstSection, firstSection + 8);
        bytes.write(dataSection, firstSection, "ascii");
      }
      const base = bits === 64 ? 0x180000000n : 0x10000000n;
      const report = await parseBytes(bytes);
      expect(report.tls).toMatchObject({
        start_address_of_raw_data: `0x${(base + BigInt(start)).toString(16)}`,
        end_address_of_raw_data: `0x${(base + BigInt(end)).toString(16)}`,
        raw_data_size: 256,
        raw_data_file_offset: fileOffset,
        raw_data_section: section,
      });
      expect(report.tls?.address_of_index.section).toBe(dataSection);
      expect(report.tls?.callbacks).toMatchObject([
        { rva: 0x2200, file_offset: null, section: ".text" },
      ]);
      expect(report.load_config?.guard_flags?.raw).toBe(0x500);
    },
  );
  it("honors Size even when directory bytes contain newer fields", async () => {
    const report = await parse({
      bits,
      loadConfigSize: 64,
      loadConfigDirectorySize: 320,
    });
    expect(report.load_config?.guard_flags).toBeNull();
    expect(report.load_config?.security_cookie === null).toBe(bits === 64);
  });
  it.each(["empty", "absent"] as const)(
    "accepts %s callbacks",
    async (callbacks) => {
      expect((await parse({ bits, callbacks })).tls?.callbacks).toEqual([]);
    },
  );
  it("accepts exactly the callback budget and rejects overflow", async () => {
    expect(
      (await parse({ bits, callbackCount: 1 }, 1)).examined_callbacks,
    ).toBe(1);
    await expect(parse({ bits }, 1)).rejects.toMatchObject({
      failure: { kind: "limit", limit: { name: "callbacks", maximum: 1 } },
    });
  });
  it("reports absent directories", async () => {
    expect(await parse({ bits, tls: false, loadConfig: false })).toMatchObject({
      tls: null,
      load_config: null,
    });
  });
  it.each([
    "tls-unmapped",
    "tls-truncated",
    "tls-half",
    "load-config-oversize",
    "load-config-truncated",
    "load-config-half",
    "raw-data-inverted",
    "callback-unterminated",
    "ambiguous-section",
  ] as const)("rejects %s", async (malformed) => {
    await expect(parse({ bits, malformed })).rejects.toMatchObject({
      failure: { kind: "malformed" },
    });
  });
});

it("reads Size bytes past a legacy 64-byte PE32 directory", async () => {
  const report = await parse({ bits: 32, loadConfigDirectorySize: 64 });
  expect(report.load_config?.directory.size).toBe(64);
  expect(report.load_config?.size).toBeGreaterThan(64);
  expect(report.load_config?.structure_location).toEqual({
    offset: report.load_config?.directory.file_offset,
    bytes: report.load_config?.size,
  });
  expect(report.load_config?.se_handler_count).toBe(2);
  expect(report.load_config?.guard_flags?.raw).toBe(0x500);
});

it("preserves pointer precision and unknown flag bits", async () => {
  const bytes = peLoadConfigImage();
  // PE64 load config at 0x640; XFG slot at +280, GuardFlags at +144.
  bytes.writeBigUInt64LE(0xfedcba9876543210n, 0x640 + 280);
  bytes.writeUInt32LE(0xf0200100, 0x640 + 144);
  const report = await parseBytes(bytes);
  expect(report.load_config?.guard_xfg_check_function_pointer).toEqual({
    va: "0xfedcba9876543210",
    rva: null,
    file_offset: null,
    section: null,
  });
  expect(report.load_config?.guard_flags).toMatchObject({
    unrecognized: 0x200000,
    cf_function_table_stride: 19,
  });
});

it("honors cancellation before parsing", async () => {
  const bytes = peLoadConfigImage();
  const reason = { caller: "before PE load config parsing" };
  const failure = await parseBytes(
    bytes,
    undefined,
    AbortSignal.abort(reason),
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  expect(failure).toMatchObject({ reason: "cancelled" });
  if (!(failure instanceof ArtifactReaderFailure)) throw failure;
  expect(failure.cause).toBe(reason);
});

it("requires the full physical section extent even when its virtual bytes fit", async () => {
  const bytes = peLoadConfigImage({ textVirtualSize: 0x20 }).subarray(
    0,
    0x1620,
  );
  await expect(
    parsePeLoadConfig(
      bytes,
      { path: "/sample.exe", sha256: "a".repeat(64), bytes: bytes.length },
      inspectPeLoadConfigInputSchema.parse({ path: "/sample.exe" }),
    ),
  ).rejects.toMatchObject({ failure: { kind: "truncated" } });
});

it("resolves callback sections without rescanning the largest section table", async () => {
  const bytes = peManySectionsImage(65535, 4096);
  // Building the section index reads each entry about twice (131071 here); a
  // per-callback scan would read about 4096 x 65535 entries.
  tableReads.count = 0;
  tableReads.budget = 4 * 65535;
  onTestFinished(() => {
    tableReads.budget = Infinity;
  });
  const report = await parseBytes(bytes, 4096);
  expect(tableReads.count).toBeLessThanOrEqual(tableReads.budget);
  expect(report.tls?.callbacks).toHaveLength(4096);
  expect(report.tls?.callbacks.every(({ section }) => section === ".v")).toBe(
    true,
  );
});

/**
 * IMAGE_LOAD_CONFIG_DIRECTORY32/64 member offsets transcribed from the PE/COFF
 * specification and llvm/Object/COFF.h (coff_load_configuration32/64), kept
 * independent of the parser's layout table.
 */
const SPEC_FIELDS: Record<
  32 | 64,
  readonly (readonly [PeLoadConfigField, number, 2 | 4 | 8])[]
> = {
  32: [
    ["security_cookie", 60, 4],
    ["se_handler_table", 64, 4],
    ["se_handler_count", 68, 4],
    ["guard_cf_check_function_pointer", 72, 4],
    ["guard_cf_dispatch_function_pointer", 76, 4],
    ["guard_cf_function_table", 80, 4],
    ["guard_cf_function_count", 84, 4],
    ["guard_flags", 88, 4],
    ["guard_address_taken_iat_entry_table", 104, 4],
    ["guard_address_taken_iat_entry_count", 108, 4],
    ["guard_long_jump_target_table", 112, 4],
    ["guard_long_jump_target_count", 116, 4],
    ["dynamic_value_reloc_table", 120, 4],
    ["chpe_metadata_pointer", 124, 4],
    ["dynamic_value_reloc_table_offset", 136, 4],
    ["dynamic_value_reloc_table_section", 140, 2],
    ["guard_eh_continuation_table", 164, 4],
    ["guard_eh_continuation_count", 168, 4],
    ["guard_xfg_check_function_pointer", 172, 4],
  ],
  64: [
    ["security_cookie", 88, 8],
    ["se_handler_table", 96, 8],
    ["se_handler_count", 104, 8],
    ["guard_cf_check_function_pointer", 112, 8],
    ["guard_cf_dispatch_function_pointer", 120, 8],
    ["guard_cf_function_table", 128, 8],
    ["guard_cf_function_count", 136, 8],
    ["guard_flags", 144, 4],
    ["guard_address_taken_iat_entry_table", 160, 8],
    ["guard_address_taken_iat_entry_count", 168, 8],
    ["guard_long_jump_target_table", 176, 8],
    ["guard_long_jump_target_count", 184, 8],
    ["dynamic_value_reloc_table", 192, 8],
    ["chpe_metadata_pointer", 200, 8],
    ["dynamic_value_reloc_table_offset", 224, 4],
    ["dynamic_value_reloc_table_section", 228, 2],
    ["guard_eh_continuation_table", 264, 8],
    ["guard_eh_continuation_count", 272, 8],
    ["guard_xfg_check_function_pointer", 280, 8],
  ],
};

/** Load-config file offset in the synthetic image: `.data` 0x600 + RVA 0x40. */
const LOAD_CONFIG_AT = 0x640;

/** A distinct sentinel per field that fills its whole width. */
const sentinel = (index: number, width: 2 | 4 | 8): bigint =>
  width === 8
    ? 0x0000_0102_0304_0500n + BigInt(index)
    : BigInt((width === 4 ? 0x01020300 : 0x1200) + index);

/** Rewrite the struct from spec offsets alone, then declare `size`. */
const specImage = (bits: 32 | 64, size: number): Buffer => {
  const known = bits === 32 ? 192 : 320;
  const bytes = peLoadConfigImage({
    bits,
    loadConfigSize: known,
    loadConfigDirectorySize: known,
  });
  bytes.fill(0, LOAD_CONFIG_AT, LOAD_CONFIG_AT + known);
  bytes.writeUInt32LE(size, LOAD_CONFIG_AT);
  SPEC_FIELDS[bits].forEach(([, offset, width], index) => {
    const value = sentinel(index, width);
    if (width === 8) bytes.writeBigUInt64LE(value, LOAD_CONFIG_AT + offset);
    else if (width === 4)
      bytes.writeUInt32LE(Number(value), LOAD_CONFIG_AT + offset);
    else bytes.writeUInt16LE(Number(value), LOAD_CONFIG_AT + offset);
  });
  return bytes;
};

/** The report value a field takes when Size covers it. */
const expectedField = (name: PeLoadConfigField, value: bigint): unknown => {
  if (name === "guard_flags")
    return expect.objectContaining({ raw: Number(value) });
  if (name.endsWith("_count")) return Number(value);
  if (name === "dynamic_value_reloc_table" || name === "chpe_metadata_pointer")
    return `0x${value.toString(16)}`;
  if (
    name === "dynamic_value_reloc_table_offset" ||
    name === "dynamic_value_reloc_table_section"
  )
    return Number(value);
  return expect.objectContaining({ va: `0x${value.toString(16)}`, rva: null });
};

describe.each([32, 64] as const)(
  "PE%s load-config fields at specification offsets",
  (bits) => {
    it.each(
      SPEC_FIELDS[bits].map(([name, offset, width]) => ({
        name,
        end: offset + width,
      })),
    )("exposes $name exactly when Size reaches $end", async ({ end }) => {
      for (const size of [end - 1, end]) {
        const bytes = specImage(bits, size);
        const report = await parseBytes(bytes);
        const config = report.load_config;
        if (config === null) throw new Error("Expected a load configuration");
        expect(config.size).toBe(size);
        SPEC_FIELDS[bits].forEach(([field, offset, width], fieldIndex) => {
          // PE32+ SafeSEH-named slots are never a handler table.
          const covered =
            offset + width <= size &&
            !(bits === 64 && field.startsWith("se_handler"));
          expect(config[field], `${field} at Size ${String(size)}`).toEqual(
            covered ? expectedField(field, sentinel(fieldIndex, width)) : null,
          );
        });
      }
    });
  },
);

it.each([32, 64] as const)(
  "PE%s retains dynamic relocation offset and section with a zero pointer",
  async (bits) => {
    const pointerOffset = bits === 32 ? 120 : 192;
    const offsetOffset = bits === 32 ? 136 : 224;
    const sectionOffset = bits === 32 ? 140 : 228;
    for (const [offset, section] of [
      [0, 0],
      [0x40, 1],
      [0xffffffff, 0xffff],
    ] as const) {
      const bytes = specImage(bits, bits === 32 ? 192 : 320);
      bytes.fill(
        0,
        LOAD_CONFIG_AT + pointerOffset,
        LOAD_CONFIG_AT + pointerOffset + (bits === 32 ? 4 : 8),
      );
      bytes.writeUInt32LE(offset, LOAD_CONFIG_AT + offsetOffset);
      bytes.writeUInt16LE(section, LOAD_CONFIG_AT + sectionOffset);
      const report = await parseBytes(bytes);
      expect(peLoadConfigSchema.safeParse(report).success).toBe(true);
      expect(report.load_config).toMatchObject({
        dynamic_value_reloc_table: "0x0",
        dynamic_value_reloc_table_offset: offset,
        dynamic_value_reloc_table_section: section,
      });
    }
  },
);

it.each([32, 64] as const)(
  "reads DWORDs after the four PE%d TLS pointers",
  async (bits) => {
    const bytes = peLoadConfigImage({ bits });
    const layout = PE_LOAD_CONFIG_FIXTURE;
    const offset =
      layout.dataFile + layout.tlsRva - layout.dataRva + 4 * (bits / 8);
    bytes.writeUInt32LE(0xfedcba98, offset);
    bytes.writeUInt32LE(0x80100000, offset + 4);
    const report = await parsePeLoadConfig(
      bytes,
      { path: "/sample.exe", sha256: "a".repeat(64), bytes: bytes.length },
      inspectPeLoadConfigInputSchema.parse({ path: "/sample.exe" }),
    );
    expect(report.tls).toMatchObject({
      size_of_zero_fill: 0xfedcba98,
      characteristics: 0x80100000,
    });
  },
);

describe("PE load-config reuse and lazy section indexing", () => {
  it("skips section and mapping index builds when TLS and load-config directories are absent", async () => {
    for (const bits of [32, 64] as const) {
      tableReads.count = 0;
      const report = await parse({ bits, tls: false, loadConfig: false });
      expect(report).toMatchObject({ tls: null, load_config: null });
      expect(tableReads.count).toBe(0);
    }
  });

  it("reuses a pre-parsed PeImage via parsePeLoadConfigFromImage and in readPeHardening", async () => {
    const bytes = peLoadConfigImage({ bits: 64 });
    const artifact = {
      path: "/sample.exe",
      sha256: "a".repeat(64),
      bytes: bytes.length,
    };
    const input = inspectPeLoadConfigInputSchema.parse({ path: "/sample.exe" });
    const expected = await parsePeLoadConfig(bytes, artifact, input);

    tableReads.imageReads = 0;
    const image = readPeImage(bytes);
    const fromImage = await parsePeLoadConfigFromImage(
      bytes,
      image,
      artifact,
      input,
    );
    expect(fromImage).toEqual(expected);
    expect(tableReads.imageReads).toBe(1);

    const noDirs = peLoadConfigImage({ tls: false, loadConfig: false });
    tableReads.imageReads = 0;
    tableReads.count = 0;
    const noDirHardening = await readPeHardening(noDirs, {
      path: "/nodirs.exe",
      sha256: "a".repeat(64),
      bytes: noDirs.length,
    });
    expect(tableReads.imageReads).toBe(1);
    expect(tableReads.count).toBe(0);
    expect(
      noDirHardening.rows.find((row) => row.property === "cfg_instrumented")
        ?.state,
    ).toBe("unknown");

    tableReads.imageReads = 0;
    const withDirHardening = await readPeHardening(bytes, artifact);
    expect(tableReads.imageReads).toBe(1);
    expect(
      withDirHardening.rows.find((row) => row.property === "cfg_instrumented")
        ?.state,
    ).toBe("enabled");
  });
});
