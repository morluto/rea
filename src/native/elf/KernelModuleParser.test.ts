import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ArtifactReaderFailure } from "../../resources/ArtifactReader.js";
import {
  inspectKernelModuleInputSchema,
  kernelModuleSchema,
  MODULE_SIGNATURE_MAGIC,
} from "../../domain/native/kernelModule.js";
import {
  compressedKernelModuleContainer,
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
