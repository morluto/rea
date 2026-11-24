import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { createDeferred } from "../../../tests/fixtures/binarySession.js";
import { awaitAcknowledgement } from "../../../tests/fixtures/lifecycleAcknowledgement.js";
import { ArtifactReaderFailure } from "../../resources/ArtifactReader.js";
import { yieldArtifactRead } from "../../resources/index.js";
import {
  inspectKernelModuleInputSchema,
  kernelModuleSchema,
  MODULE_SIGNATURE_MAGIC,
} from "../../domain/native/kernelModule.js";
import {
  compressedKernelModuleContainer,
  crc32Array,
  extendedVersionSections,
  kernelModuleFixture,
  modversionEntry,
  moduleSignatureTrailer,
} from "./KernelModule.fixture.js";
import { parseKernelModuleFromHandle } from "./KernelModuleParser.js";

const artifactPath = "/artifacts/demo.ko";

const parse = async (
  bytes: Buffer,
  extra: { readonly max_entries?: number } = {},
) =>
  kernelModuleSchema.parse(
    await parseKernelModuleFromHandle(
      {
        size: bytes.length,
        prefix: bytes.subarray(0, 4096),
        readRange: async (offset, length) =>
          bytes.subarray(offset, offset + length),
      },
      {
        path: artifactPath,
        sha256: "ab".repeat(32),
        bytes: bytes.length,
      },
      inspectKernelModuleInputSchema.parse({
        path: artifactPath,
        ...extra,
      }),
    ),
  );

const pkcs7 = Buffer.from("fake-pkcs7-bytes", "latin1");
const pkcs7Sha256 = createHash("sha256").update(pkcs7).digest("hex");

it("preserves parameter duplicates, embedded equals, and original entry bytes", async () => {
  const records = [
    "parm=level:verbosity=a",
    "parmtype=level:int",
    "parm=level:again",
  ];
  const report = await parse(
    kernelModuleFixture({ modinfo: Buffer.from(`${records.join("\0")}\0`) }),
  );
  expect(
    report.modinfo?.entries.map(({ key, value, raw_hex }) => ({
      key,
      value,
      raw_hex,
    })),
  ).toEqual(
    records.map((record) => ({
      key: record.slice(0, record.indexOf("=")),
      value: record.slice(record.indexOf("=") + 1),
      raw_hex: Buffer.from(`${record}\0`).toString("hex"),
    })),
  );
});

it("distinguishes absent metadata from unavailable section names", async () => {
  const absent = await parse(
    kernelModuleFixture({ modinfo: null, versions: null }),
  );
  expect(absent.modinfo?.status).toBe("absent");
  expect(absent.versions?.status).toBe("absent");
  const bytes = kernelModuleFixture();
  bytes.writeUInt16LE(0, 62);
  const unknown = await parse(bytes);
  expect(unknown.modinfo?.status).toBe("unknown");
  expect(unknown.versions?.status).toBe("unknown");
  expect(unknown.coverage.status).toBe("partial");
});

it.each([
  [64, true],
  [64, false],
  [32, true],
  [32, false],
] as const)("reports an ET_REL ELF%s %s module", async (bits, little) => {
  const wideVersions =
    bits === 64
      ? Buffer.concat([
          modversionEntry(0xfedcba9876543210n, "printk", 64, little),
          modversionEntry(0x0100000000000002n, "module_layout", 64, little),
        ])
      : undefined;
  const report = await parse(
    kernelModuleFixture({
      bits,
      little,
      ...(wideVersions === undefined ? {} : { versions: wideVersions }),
    }),
  );
  expect(report).toMatchObject({
    format: bits === 64 ? "elf64" : "elf32",
    byte_order: little ? "little" : "big",
    machine: bits === 64 ? 62 : 20,
    type: 1,
    type_name: "relocatable",
    applicability: "applicable",
    compression: null,
    next_probe: null,
    coverage: { status: "complete", examined_entries: 9 },
  });
  expect(
    report.modinfo?.entries.map((entry) => [entry.key, entry.value]),
  ).toEqual([
    ["license", "GPL"],
    ["vermagic", "5.15.0 SMP mod_unload"],
    ["alias", "pci:v1"],
    ["alias", "pci:v2"],
    ["name", "demo"],
    ["depends", ""],
  ]);
  expect(
    report.modinfo?.entries.every((entry) => entry.status === "observed"),
  ).toBe(true);
  expect(report.versions?.layout).toBe(
    bits === 64 ? "elf64_unsigned_long_name56" : "elf32_unsigned_long_name60",
  );
  expect(
    report.versions?.entries.map((entry) => [entry.crc_hex, entry.name]),
  ).toEqual([
    [bits === 64 ? "fedcba9876543210" : "12345678", "printk"],
    [bits === 64 ? "0100000000000002" : "90abcdef", "module_layout"],
  ]);
  expect(report.this_module).toMatchObject({
    status: "present",
    layout: "unknown",
    location: { bytes: 8 },
  });
  expect(report.ksymtab?.sections.map((section) => section.name)).toEqual([
    "__ksymtab",
  ]);
  expect(report.init_text).toMatchObject({ status: "present", bytes: 4 });
  expect(report.exit_text).toMatchObject({ status: "present", bytes: 1 });
  expect(report.signature).toMatchObject({
    status: "present",
    reason: null,
    pkcs7: {
      location: { bytes: pkcs7.length },
      sha256: pkcs7Sha256,
    },
    info: { algo: 0, hash: 0, id_type: 2, sig_len: pkcs7.length },
  });
});

it.each([
  [".init.text", "init_text", 4],
  [".exit.text", "exit_text", 1],
] as const)(
  "discloses duplicate %s sections while retaining the first size",
  async (name, key, size) => {
    const report = await parse(
      kernelModuleFixture({
        sharedNameSections: { name, count: 1, body: Buffer.from([1, 2, 3]) },
      }),
    );
    expect(report[key]).toMatchObject({ status: "present", bytes: size });
    expect(report.coverage.status).toBe("partial");
    expect(report.limitations).toContain(
      `Multiple ${name} sections are declared; the first is examined.`,
    );
  },
);

it("keeps readable fields and exact defects across a malformed .modinfo stream", async () => {
  const report = await parse(
    kernelModuleFixture({
      modinfo: Buffer.from(
        "license=GPL\0license\0=GPL\0alias=pci:v3",
        "latin1",
      ),
    }),
  );
  expect(report.modinfo?.status).toBe("present");
  expect(
    report.modinfo?.entries.map(({ key, value, status, reason }) => [
      key,
      value,
      status,
      reason,
    ]),
  ).toEqual([
    ["license", "GPL", "observed", null],
    [null, null, "malformed", "modinfo_missing_separator"],
    [null, "GPL", "malformed", "modinfo_empty_key"],
    ["alias", "pci:v3", "malformed", "unterminated_modinfo_entry"],
  ]);
  expect(report.coverage.status).toBe("partial");
});

it("closes __versions when the section size is not a multiple of 64", async () => {
  const report = await parse(
    kernelModuleFixture({ versions: Buffer.alloc(63) }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.versions).toMatchObject({
    status: "malformed",
    entries: [],
    reason: "versions_size_not_multiple",
    layout: "elf64_unsigned_long_name56",
    entry_bytes: 64,
  });
  expect(report.coverage.examined_entries).toBe(
    (report.modinfo?.entries.length ?? 0) +
      (report.ksymtab?.sections.length ?? 0),
  );
});

it("observes a version name with nonzero padding and rejects a missing NUL", async () => {
  const padded = modversionEntry(0x12345678, "printk", 64, true);
  padded[8 + "printk".length + 1] = 0x7f;
  const unterminated = Buffer.alloc(64, 0x41);
  unterminated.writeBigUInt64LE(0x11n, 0);
  const report = await parse(
    kernelModuleFixture({
      versions: Buffer.concat([padded, unterminated]),
    }),
  );
  expect(report.versions?.entries[0]).toMatchObject({
    status: "observed",
    name: "printk",
    reason: null,
    crc_hex: "0000000012345678",
  });
  expect(report.versions?.entries[1]).toMatchObject({
    status: "malformed",
    name: null,
    reason: "version_name_unterminated",
    crc_hex: "0000000000000011",
  });
});

it("hashes the entire appended signature through bounded source reads", async () => {
  const pkcs7 = Buffer.alloc((2 << 20) + 17, 0x6a);
  pkcs7[0] = 0x31;
  pkcs7[pkcs7.length - 1] = 0x7f;
  const trailer = moduleSignatureTrailer(pkcs7);
  const bytes = kernelModuleFixture({ signature: trailer });
  const signatureOffset = bytes.length - trailer.length;
  const end = signatureOffset + pkcs7.length;
  const reads: Array<{ offset: number; length: number }> = [];
  const source = {
    size: bytes.length,
    prefix: bytes.subarray(0, 4096),
    readRange: async (offset: number, length: number) => {
      if (offset < end && offset + length > signatureOffset)
        reads.push({ offset, length });
      return bytes.subarray(offset, offset + length);
    },
  };
  const artifact = {
    path: artifactPath,
    sha256: "ab".repeat(32),
    bytes: bytes.length,
  };
  const input = inspectKernelModuleInputSchema.parse({ path: artifactPath });
  const report = await parseKernelModuleFromHandle(source, artifact, input);
  expect(report.signature?.pkcs7).toEqual({
    location: { offset: signatureOffset, bytes: pkcs7.length },
    sha256: createHash("sha256").update(pkcs7).digest("hex"),
  });
  let nextOffset = signatureOffset;
  for (const { offset, length } of reads) {
    expect(offset).toBe(nextOffset);
    expect(length).toBeLessThanOrEqual(1 << 20);
    nextOffset += length;
  }
  expect(nextOffset).toBe(end);
  await expect(
    parseKernelModuleFromHandle(
      {
        ...source,
        readRange: async (offset, length) =>
          offset + length === end
            ? bytes.subarray(offset, end - 1)
            : source.readRange(offset, length),
      },
      artifact,
      input,
    ),
  ).rejects.toMatchObject({
    reason: "integrity",
    integrityCheck: "read-coverage",
  });
});

it("reports an inconsistent signature length without a PKCS#7 range", async () => {
  const report = await parse(
    kernelModuleFixture({
      signature: moduleSignatureTrailer(Buffer.from("abcd"), 50_000),
    }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.signature).toMatchObject({
    status: "malformed",
    reason: "signature_length_inconsistent",
    pkcs7: null,
    info: { sig_len: 50_000, id_type: 2 },
  });
  expect(report.modinfo?.entries[0]?.key).toBe("license");
});

it("withholds PKCS#7 bytes for nonzero signature parameters and a non-PKCS7 id", async () => {
  const nonzero = Buffer.alloc(12);
  nonzero[0] = 1;
  nonzero[2] = 2;
  nonzero.writeUInt32BE(4, 8);
  const otherId = Buffer.alloc(12);
  otherId[0] = 1;
  otherId[3] = 2;
  otherId[2] = 1;
  otherId.writeUInt32BE(4, 8);
  const magic = Buffer.from(MODULE_SIGNATURE_MAGIC, "latin1");
  const payload = Buffer.from("abcd");
  expect(
    (
      await parse(
        kernelModuleFixture({
          signature: Buffer.concat([payload, nonzero, magic]),
        }),
      )
    ).signature,
  ).toMatchObject({
    status: "malformed",
    reason: "signature_parameters_nonzero",
    pkcs7: null,
  });
  expect(
    (
      await parse(
        kernelModuleFixture({
          signature: Buffer.concat([payload, otherId, magic]),
        }),
      )
    ).signature,
  ).toMatchObject({
    status: "unsupported",
    reason: "signature_id_type_not_pkcs7",
    pkcs7: null,
    info: { id_type: 1 },
  });
});

it("does not examine kernel metadata on a non-relocatable ELF", async () => {
  const report = await parse(kernelModuleFixture({ type: 2 }));
  expect(report).toMatchObject({
    applicability: "not_applicable",
    type: 2,
    type_name: "executable",
    modinfo: null,
    versions: null,
    signature: null,
    coverage: { status: "not_applicable", examined_entries: 0 },
  });
});

it.each(["gzip", "xz", "zstd"] as const)(
  "recommends external decompression for a %s container",
  async (codec) => {
    const report = await parse(compressedKernelModuleContainer(codec));
    expect(report).toMatchObject({
      applicability: "unsupported",
      format: null,
      compression: { codec, status: "unsupported" },
      next_probe: { operation: "external_decompression" },
      modinfo: null,
      coverage: { status: "unsupported", examined_entries: 0 },
    });
    expect(report.next_probe?.rationale).toContain(codec);
    expect(report.next_probe?.rationale).toContain("external");
    expect(report.next_probe?.rationale).toContain(
      "call inspect_kernel_module on the decompressed file",
    );
  },
);

it("fails closed when the combined entry budget is exhausted", async () => {
  let failure: unknown;
  try {
    await parse(kernelModuleFixture(), { max_entries: 7 });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  expect(failure).toMatchObject({ reason: "limit", boundary: "capacity" });
});

it("examines the first of two .modinfo sections and records the duplicate", async () => {
  const report = await parse(
    kernelModuleFixture({
      modinfo: Buffer.from("name=first\0"),
      sharedNameSections: {
        name: ".modinfo",
        count: 1,
        body: Buffer.from("name=second\0"),
      },
    }),
  );
  expect(report.modinfo?.entries.map(({ key, value }) => [key, value])).toEqual(
    [["name", "first"]],
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.limitations).toContainEqual(
    expect.stringMatching(/multiple.*\.modinfo.*first.*examined/iu),
  );
});

it.each([
  { index: 1, key: "modinfo" },
  { index: 2, key: "versions" },
] as const)(
  "keeps $key metadata unreadable when its storage is unavailable",
  async ({ index, key }) => {
    const header = 64 + index * 64;
    const compressed = kernelModuleFixture();
    compressed.writeBigUInt64LE(0x800n, header + 8);
    const packed = await parse(compressed);
    expect(packed.coverage.status).toBe("partial");
    expect(packed[key]).toMatchObject({
      status: "unsupported",
      entries: [],
      reason: `${key}_section_compressed`,
    });
    for (const nobits of [true, false]) {
      const bytes = kernelModuleFixture();
      if (nobits) bytes.writeUInt32LE(8, header + 4);
      else bytes.writeBigUInt64LE(1_000_000n, header + 24);
      expect((await parse(bytes))[key]).toMatchObject({
        status: "malformed",
        location: null,
        entries: [],
        reason: `${key}_section_not_file_backed`,
      });
    }
  },
);

it("keeps presence without a file range for a NOBITS module structure", async () => {
  const bytes = kernelModuleFixture();
  bytes.writeUInt32LE(8, 64 + 64 * 3 + 4);
  expect((await parse(bytes)).this_module).toMatchObject({
    status: "present",
    location: null,
    layout: "unknown",
  });
});

it("rejects ELF bytes preceding a bare signature magic as an inconsistent trailer", async () => {
  const report = await parse(
    kernelModuleFixture({
      signature: Buffer.from(MODULE_SIGNATURE_MAGIC, "latin1"),
    }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.signature).toMatchObject({
    status: "malformed",
    reason: "signature_length_inconsistent",
    pkcs7: null,
  });
  expect(report.modinfo?.entries[0]?.key).toBe("license");
});

it("records a missing trailer as observed absence", async () => {
  const report = await parse(kernelModuleFixture({ signature: null }));
  expect(report.signature).toMatchObject({
    status: "absent",
    magic: null,
    info: null,
    pkcs7: null,
    reason: null,
  });
  expect(report.limitations.join("\n")).toContain(
    "not proof the module is unsigned",
  );
});

it("reports unbacked __ksymtab ranges while keeping module metadata", async () => {
  const bytes = kernelModuleFixture();
  bytes.writeUInt32LE(8, 64 + 64 * 4 + 4);
  const report = await parse(bytes);
  expect(report.ksymtab?.sections).toEqual([]);
  expect(report.limitations).toContainEqual(
    expect.stringMatching(
      /1 __ksymtab\*.*not file-backed.*ranges are unknown/iu,
    ),
  );
  expect(report.modinfo?.entries[0]?.key).toBe("license");
});

it("charges many sections sharing one huge __ksymtab name to the entry budget", async () => {
  const name = `__ksymtab_${"x".repeat(65_490)}`;
  const bytes = kernelModuleFixture({
    sharedNameSections: { name, count: 8192 },
  });
  const refused = parse(bytes);
  await expect(refused).rejects.toBeInstanceOf(ArtifactReaderFailure);
  await expect(refused).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
  });
  // The shared name decodes once; per-section decoding exceeds the 16 MiB
  // section-name budget and refuses this module.
  const report = await parse(bytes, { max_entries: 65_536 });
  const huge = report.ksymtab?.sections.slice(1) ?? [];
  expect(huge).toHaveLength(8192);
  expect(
    huge.every(
      (section) =>
        section.name === null &&
        section.reason === "ksymtab_name_exceeds_limit",
    ),
  ).toBe(true);
  expect(report.ksymtab?.sections[0]).toMatchObject({
    name: "__ksymtab",
    reason: null,
  });
  expect(report.coverage).toEqual({
    status: "partial",
    examined_entries: 8201,
  });
  expect(JSON.stringify(report).length).toBeLessThan(2 * 1024 * 1024);
});

it.each([
  [64, true],
  [64, false],
  [32, true],
  [32, false],
] as const)(
  "decodes __ksymtab_strings and __kcrctab / __kcrctab_gpl on ELF%s little=%s",
  async (bits, little) => {
    const strings = Buffer.from(
      "\0exported_fn\0EXPORT_NS\0gpl_fn\0\0",
      "latin1",
    );
    const kcrctab = crc32Array([0x12345678], little);
    const kcrctabGpl = crc32Array([0xdeadbeef, 0x0000cafe], little);
    const bytes = kernelModuleFixture({
      bits,
      little,
      ksymtabStrings: strings,
      kcrctab,
      kcrctabGpl,
    });
    const report = await parse(bytes);
    expect(report.coverage).toEqual({
      status: "complete",
      examined_entries: 16,
    });
    expect(report.ksymtab?.sections.map((section) => section.name)).toEqual([
      "__ksymtab",
      "__ksymtab_strings",
    ]);
    expect(report.ksymtab?.strings).toMatchObject({
      status: "present",
      sha256: createHash("sha256").update(strings).digest("hex"),
      reason: null,
    });
    expect(
      report.ksymtab?.strings?.entries.map((entry) => [
        entry.value,
        entry.status,
        entry.omitted,
      ]),
    ).toEqual([
      ["exported_fn", "observed", false],
      ["EXPORT_NS", "observed", false],
      ["gpl_fn", "observed", false],
    ]);
    expect(
      report.ksymtab?.kcrctab?.entries.map((entry) => entry.crc_hex),
    ).toEqual(["12345678"]);
    expect(
      report.ksymtab?.kcrctab_gpl?.entries.map((entry) => entry.crc_hex),
    ).toEqual(["deadbeef", "0000cafe"]);
    expect(report.limitations.join("\n")).toContain("PREL32");
    expect(report.limitations.join("\n")).toContain("relocations");
  },
);

it("handles malformed, oversized, compressed, unbacked, and over-budget __ksymtab_strings and __kcrctab*", async () => {
  const longSym = "s".repeat(4097);
  const strings = Buffer.from(`ok_sym\0${longSym}\0unterm`, "latin1");
  const report = await parse(
    kernelModuleFixture({
      ksymtabStrings: strings,
      kcrctab: Buffer.from([1, 2, 3]),
      extraSections: [{ name: "__kcrctab_unused", body: Buffer.alloc(4) }],
    }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.ksymtab?.strings?.entries).toMatchObject([
    {
      index: 0,
      value: "ok_sym",
      status: "observed",
      reason: null,
      omitted: false,
    },
    {
      index: 1,
      value: null,
      raw_hex: null,
      raw_sha256: createHash("sha256")
        .update(Buffer.from(`${longSym}\0`, "latin1"))
        .digest("hex"),
      status: "observed",
      reason: null,
      omitted: true,
    },
    {
      index: 2,
      value: null,
      status: "malformed",
      reason: "ksymtab_string_unterminated",
      omitted: false,
    },
  ]);
  expect(report.ksymtab?.kcrctab).toMatchObject({
    status: "malformed",
    reason: "kcrctab_size_not_multiple",
    entries: [],
  });
  expect(report.limitations.join("\n")).toContain(
    "Additional __kcrctab* sections",
  );

  const compressed = await parse(
    kernelModuleFixture({
      extraSections: [
        { name: "__ksymtab_strings", flags: 0x800n, body: Buffer.from("a\0") },
        { name: "__kcrctab_gpl", flags: 0x800n, body: Buffer.alloc(4) },
      ],
    }),
  );
  expect(compressed.coverage.status).toBe("partial");
  expect(compressed.ksymtab?.strings).toMatchObject({
    status: "unsupported",
    reason: "ksymtab_strings_section_compressed",
    entries: [],
  });
  expect(compressed.ksymtab?.kcrctab_gpl).toMatchObject({
    status: "unsupported",
    reason: "kcrctab_section_compressed",
    entries: [],
  });

  const nobits = await parse(
    kernelModuleFixture({
      extraSections: [
        { name: "__ksymtab_strings", type: 8, body: Buffer.alloc(0) },
        { name: "__kcrctab", type: 8, body: Buffer.alloc(0) },
      ],
    }),
  );
  expect(nobits.coverage.status).toBe("partial");
  expect(nobits.ksymtab?.strings).toMatchObject({
    status: "malformed",
    reason: "ksymtab_strings_section_not_file_backed",
    location: null,
  });
  expect(nobits.ksymtab?.kcrctab).toMatchObject({
    status: "malformed",
    reason: "kcrctab_section_not_file_backed",
    location: null,
  });

  await expect(
    parse(
      kernelModuleFixture({
        ksymtabStrings: Buffer.from("a\0b\0c\0", "latin1"),
      }),
      { max_entries: 11 },
    ),
  ).rejects.toMatchObject({ reason: "limit", boundary: "capacity" });

  await expect(
    parse(
      kernelModuleFixture({
        kcrctab: crc32Array([1, 2, 3, 4], true),
      }),
      { max_entries: 11 },
    ),
  ).rejects.toMatchObject({ reason: "limit", boundary: "capacity" });
});

it.each([
  [64, true],
  [64, false],
  [32, true],
  [32, false],
] as const)(
  "decodes CONFIG_EXTENDED_MODVERSIONS with long symbol names on ELF%s little=%s",
  async (bits, little) => {
    const longRustName = `_RNvNtCs1234_${"long_module_segment_".repeat(6)}func`;
    expect(longRustName.length).toBeGreaterThan(64);
    const ext = extendedVersionSections(
      [
        { crc: 0x01020304, name: "printk" },
        { crc: 0xdeadbeef, name: longRustName },
      ],
      little,
    );
    const bytes = kernelModuleFixture({
      bits,
      little,
      versions: null,
      versionExtNames: Buffer.concat([ext.names, Buffer.alloc(3)]),
      versionExtCrcs: ext.crcs,
    });
    const report = await parse(bytes);
    expect(report.coverage).toEqual({
      status: "complete",
      examined_entries: 9,
    });
    expect(report.versions?.status).toBe("absent");
    expect(report.extended_versions).toMatchObject({
      status: "present",
      entry_crc_bytes: 4,
      names_section: { status: "present", count: 2, reason: null },
      crcs_section: { status: "present", count: 2, reason: null },
      reason: null,
    });
    expect(
      report.extended_versions?.entries.map((entry) => [
        entry.crc_hex,
        entry.name,
        entry.status,
      ]),
    ).toEqual([
      ["01020304", "printk", "observed"],
      ["deadbeef", longRustName, "observed"],
    ]);
    expect(report.limitations.join("\n")).toContain(
      "CONFIG_EXTENDED_MODVERSIONS",
    );
  },
);

it("handles missing pairs, count mismatches, truncation, empty/oversized names, and budgets for CONFIG_EXTENDED_MODVERSIONS", async () => {
  const missingCrcs = await parse(
    kernelModuleFixture({
      versions: null,
      versionExtNames: Buffer.from("printk\0", "latin1"),
    }),
  );
  expect(missingCrcs.coverage.status).toBe("partial");
  expect(missingCrcs.extended_versions).toMatchObject({
    status: "malformed",
    reason: "version_ext_crcs_missing",
    entries: [],
    names_section: { status: "present" },
    crcs_section: { status: "absent" },
  });

  const missingNames = await parse(
    kernelModuleFixture({
      versions: null,
      versionExtCrcs: crc32Array([0x11111111], true),
    }),
  );
  expect(missingNames.extended_versions).toMatchObject({
    status: "malformed",
    reason: "version_ext_names_missing",
    entries: [],
    names_section: { status: "absent" },
    crcs_section: { status: "present", count: 1 },
  });

  const unknownNames = kernelModuleFixture({
    versions: null,
    versionExtCrcs: crc32Array([0x11111111], true),
  });
  unknownNames.writeUInt16LE(0, 62);
  const unknownExt = await parse(unknownNames);
  expect(unknownExt.extended_versions?.status).toBe("unknown");
  expect(unknownExt.extended_versions?.names_section.status).toBe("unknown");

  const oddCrcs = await parse(
    kernelModuleFixture({
      versions: null,
      versionExtNames: Buffer.from("printk\0", "latin1"),
      versionExtCrcs: Buffer.from([1, 2, 3]),
    }),
  );
  expect(oddCrcs.extended_versions).toMatchObject({
    status: "malformed",
    reason: "version_ext_crcs_size_not_multiple",
    entries: [],
  });

  const fewerNames = await parse(
    kernelModuleFixture({
      versions: null,
      versionExtNames: Buffer.from("printk\0", "latin1"),
      versionExtCrcs: crc32Array([1, 2], true),
    }),
  );
  expect(fewerNames.extended_versions).toMatchObject({
    status: "malformed",
    reason: "version_ext_count_mismatch",
    entries: [],
    names_section: { status: "present", count: 1 },
    crcs_section: { status: "present", count: 2 },
  });

  const moreNames = await parse(
    kernelModuleFixture({
      versions: null,
      versionExtNames: Buffer.from("printk\0extra_sym\0", "latin1"),
      versionExtCrcs: crc32Array([1], true),
    }),
  );
  expect(moreNames.extended_versions).toMatchObject({
    status: "malformed",
    reason: "version_ext_count_mismatch",
    entries: [],
    names_section: { status: "present", count: 2 },
    crcs_section: { status: "present", count: 1 },
  });

  const unterminated = await parse(
    kernelModuleFixture({
      versions: null,
      versionExtNames: Buffer.from("printk\0module_layout", "latin1"),
      versionExtCrcs: crc32Array([1, 2], true),
    }),
  );
  expect(unterminated.coverage.status).toBe("partial");
  expect(unterminated.extended_versions?.entries).toMatchObject([
    { index: 0, name: "printk", status: "observed", reason: null },
    {
      index: 1,
      name: null,
      status: "malformed",
      reason: "version_ext_name_unterminated",
      omitted: false,
    },
  ]);

  const longSym = "r".repeat(4097);
  const emptyAndLong = await parse(
    kernelModuleFixture({
      versions: null,
      versionExtNames: Buffer.from(`\0${longSym}\0`, "latin1"),
      versionExtCrcs: crc32Array([1, 2], true),
    }),
  );
  expect(emptyAndLong.extended_versions?.entries).toMatchObject([
    {
      index: 0,
      name: null,
      status: "malformed",
      reason: "version_ext_empty_name",
      omitted: false,
    },
    {
      index: 1,
      name: null,
      name_raw_hex: null,
      status: "observed",
      reason: null,
      omitted: true,
    },
  ]);

  const extBudget = extendedVersionSections(
    [
      { crc: 1, name: "a" },
      { crc: 2, name: "b" },
      { crc: 3, name: "c" },
    ],
    true,
  );
  await expect(
    parse(
      kernelModuleFixture({
        versions: null,
        versionExtNames: extBudget.names,
        versionExtCrcs: extBudget.crcs,
      }),
      { max_entries: 9 },
    ),
  ).rejects.toMatchObject({ reason: "limit", boundary: "capacity" });

  await expect(
    parse(
      kernelModuleFixture({
        versions: null,
        versionExtNames: Buffer.from("a\0b\0c\0d\0", "latin1"),
        versionExtCrcs: crc32Array([1], true),
      }),
      { max_entries: 9 },
    ),
  ).rejects.toMatchObject({ reason: "limit", boundary: "capacity" });
});

it("charges mismatched CONFIG_EXTENDED_MODVERSIONS work against max_entries before later sections", async () => {
  const moreNamesBytes = kernelModuleFixture({
    modinfo: null,
    versions: null,
    ksymtab: null,
    versionExtNames: Buffer.from("a\0b\0c\0d\0", "latin1"),
    versionExtCrcs: crc32Array([1, 2, 3], true),
    kcrctab: crc32Array([10, 20, 30, 40], true),
  });
  for (const max_entries of [4, 7]) {
    await expect(parse(moreNamesBytes, { max_entries })).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
    });
  }
  const withinBudget = await parse(moreNamesBytes, { max_entries: 8 });
  expect(withinBudget.extended_versions).toMatchObject({
    status: "malformed",
    reason: "version_ext_count_mismatch",
    names_section: { count: 4 },
    crcs_section: { count: 3 },
    entries: [],
  });
  expect(withinBudget.ksymtab?.kcrctab?.entries).toHaveLength(4);
  expect(withinBudget.coverage).toEqual({
    status: "partial",
    examined_entries: 4,
  });

  const fewerNamesBytes = kernelModuleFixture({
    modinfo: null,
    versions: null,
    ksymtab: null,
    versionExtNames: Buffer.from("a\0b\0c\0", "latin1"),
    versionExtCrcs: crc32Array([1, 2, 3, 4], true),
    kcrctab: crc32Array([10, 20, 30, 40], true),
  });
  await expect(
    parse(fewerNamesBytes, { max_entries: 7 }),
  ).rejects.toMatchObject({
    reason: "limit",
    boundary: "capacity",
  });
  const fewerWithinBudget = await parse(fewerNamesBytes, { max_entries: 8 });
  expect(fewerWithinBudget.ksymtab?.kcrctab?.entries).toHaveLength(4);
  expect(fewerWithinBudget.coverage).toEqual({
    status: "partial",
    examined_entries: 4,
  });
});

it.each(["__ksymtab_strings", "__version_ext_names"] as const)(
  "checkpoints and honors abort signals while scanning NUL padding in %s",
  async (sectionName) => {
    const padding = Buffer.alloc(131_072);
    const bytes = kernelModuleFixture({
      modinfo: null,
      versions: null,
      ksymtab: null,
      ...(sectionName === "__ksymtab_strings"
        ? {
            ksymtabStrings: Buffer.concat([
              padding,
              Buffer.from("exported\0", "latin1"),
            ]),
          }
        : {
            versionExtNames: Buffer.concat([
              Buffer.from("printk\0", "latin1"),
              padding,
            ]),
            versionExtCrcs: crc32Array([0xdeadbeef], true),
          }),
      kcrctab: crc32Array([0x12345678], true),
    });

    const runWithPause = async (abortAtCheckpoint: boolean) => {
      const controller = new AbortController();
      const abortReason = new Error(`cancelled in ${sectionName} padding`);
      const checkpoint = createDeferred<void>();
      const release = createDeferred<void>();
      let reads = 0;
      let checkpoints = 0;
      const pending = parseKernelModuleFromHandle(
        {
          size: bytes.length,
          prefix: bytes.subarray(0, 4096),
          readRange: async (offset, length) => {
            reads += 1;
            return bytes.subarray(offset, offset + length);
          },
        },
        {
          path: artifactPath,
          sha256: "ab".repeat(32),
          bytes: bytes.length,
        },
        inspectKernelModuleInputSchema.parse({ path: artifactPath }),
        controller.signal,
        async () => {
          checkpoints += 1;
          if (checkpoints === 1) {
            checkpoint.resolve();
            await release.promise;
          }
          await yieldArtifactRead(controller.signal);
        },
      );
      try {
        await awaitAcknowledgement(
          checkpoint.promise,
          pending,
          `${sectionName} padding checkpoint`,
        );
        const pausedReads = reads;
        await expect(
          Promise.race([pending, setImmediate("waiting")]),
        ).resolves.toBe("waiting");
        expect(reads).toBe(pausedReads);
        expect(checkpoints).toBe(1);
        if (abortAtCheckpoint) {
          controller.abort(abortReason);
          release.resolve();
          await expect(pending).rejects.toMatchObject({
            reason: "cancelled",
            cancellation: { reason: abortReason },
          });
          expect(reads).toBe(pausedReads);
          return null;
        }
        release.resolve();
        const report = kernelModuleSchema.parse(await pending);
        expect(checkpoints).toBeGreaterThanOrEqual(2);
        return report;
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
      }
    };

    await runWithPause(true);
    const completed = await runWithPause(false);
    expect(
      completed?.ksymtab?.kcrctab?.entries.map((entry) => entry.crc_hex),
    ).toEqual(["12345678"]);
    if (sectionName === "__ksymtab_strings") {
      expect(
        completed?.ksymtab?.strings?.entries.map((entry) => entry.value),
      ).toEqual(["exported"]);
    } else {
      expect(
        completed?.extended_versions?.entries.map((entry) => entry.name),
      ).toEqual(["printk"]);
    }
  },
);
