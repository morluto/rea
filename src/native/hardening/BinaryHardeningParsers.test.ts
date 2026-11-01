import { expect, it } from "vitest";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  ELF_HARDENING_PROPERTIES,
  MACHO_HARDENING_PROPERTIES,
  PE_HARDENING_PROPERTIES,
  type BinaryHardeningRow,
} from "../../domain/native/binaryHardening.js";
import { BinaryFormatFailure } from "../metadata/BinaryContainer.js";
import { readElfImage } from "../metadata/ElfImage.js";
import { readMachoImage } from "../metadata/MachoImage.js";
import {
  elfHardeningFixture,
  fatMachoHardeningFixture,
  machoHardeningFixture,
  peHardeningImage,
} from "./BinaryHardening.fixture.js";
import { readElfHardening } from "./ElfHardening.js";
import { readMachoHardening } from "./MachoHardening.js";
import { readPeHardening } from "./PeHardening.js";

const states = (rows: readonly BinaryHardeningRow[]) =>
  Object.fromEntries(rows.map((entry) => [entry.property, entry.state]));

const findRow = (
  rows: readonly BinaryHardeningRow[],
  property: BinaryHardeningRow["property"],
): BinaryHardeningRow => {
  const found = rows.find((entry) => entry.property === property);
  if (found === undefined) throw new Error(`Missing ${property}`);
  return found;
};

const peArtifact = (bytes: Buffer) => ({
  path: "/artifacts/app.exe",
  sha256: "a".repeat(64),
  bytes: bytes.length,
});

it("reports a default ET_DYN image without treating missing symbols as disabled", () => {
  const image = readElfHardening(elfHardeningFixture());
  expect(image.rows.map(({ property }) => property)).toEqual([
    ...ELF_HARDENING_PROPERTIES,
  ]);
  expect(states(image.rows)).toEqual({
    pie: "not_applicable",
    nx: "enabled",
    relro: "disabled",
    stack_protector: "unknown",
    fortify: "unknown",
    cet_ibt_shstk: "disabled",
    aarch64_bti_pac: "not_applicable",
    rpath: "disabled",
    runpath: "disabled",
    stripped: "disabled",
  });
  expect(findRow(image.rows, "stack_protector").note).toEqual(
    expect.stringContaining("static or stripped"),
  );
  expect(image.architecture).toBe("x86_64");
  expect(image.byte_order).toBe("little");
});

it("derives PIE, RELRO, NX, symbols, paths and GNU properties", () => {
  const enabled = readElfHardening(
    elfHardeningFixture({
      interp: true,
      gnuRelro: true,
      bindNow: true,
      stackChk: true,
      fortify: true,
      rpath: "/opt/lib",
      runpath: "/opt/run",
      property: { arch: "x86", value: 0b11 },
    }),
  );
  expect(states(enabled.rows)).toMatchObject({
    pie: "enabled",
    relro: "enabled",
    stack_protector: "enabled",
    fortify: "enabled",
    cet_ibt_shstk: "enabled",
    rpath: "enabled",
    runpath: "enabled",
  });
  expect(findRow(enabled.rows, "pie")).toMatchObject({
    confidence: "derived",
    basis: expect.stringContaining("PT_INTERP"),
  });
  expect(findRow(enabled.rows, "relro").confidence).toBe("derived");
  expect(findRow(enabled.rows, "rpath").note).toBe("/opt/lib");
  expect(findRow(enabled.rows, "fortify").basis).toContain(
    "Undefined dynamic symbol __memcpy_chk",
  );
  const exported = readElfHardening(
    elfHardeningFixture({ stackChk: true, exportSymbols: true }),
  );
  expect(findRow(exported.rows, "stack_protector")).toMatchObject({
    state: "unknown",
    basis: expect.stringContaining("was found"),
  });
  expect(findRow(exported.rows, "nx").state).toBe("enabled");

  const pieFlag = readElfHardening(elfHardeningFixture({ pieFlag: true }));
  expect(findRow(pieFlag.rows, "pie")).toMatchObject({
    state: "enabled",
    confidence: "derived",
    basis: expect.stringContaining("DF_1_PIE"),
  });
  const executable = readElfHardening(elfHardeningFixture({ type: 2 }));
  expect(findRow(executable.rows, "pie").state).toBe("disabled");
  const partial = readElfHardening(elfHardeningFixture({ gnuRelro: true }));
  expect(findRow(partial.rows, "relro")).toMatchObject({
    state: "partial",
    confidence: "derived",
  });
  const executableStack = readElfHardening(
    elfHardeningFixture({ gnuStack: { flags: 7 } }),
  );
  expect(findRow(executableStack.rows, "nx").state).toBe("disabled");
  const missingStack = readElfHardening(
    elfHardeningFixture({ gnuStack: null }),
  );
  expect(findRow(missingStack.rows, "nx")).toMatchObject({
    state: "unknown",
    note: expect.stringContaining("does not apply"),
  });
  const i386 = readElfHardening(
    elfHardeningFixture({ bits: 32, machine: 3, gnuStack: null }),
  );
  expect(findRow(i386.rows, "nx").note).toEqual(
    expect.stringContaining("an executable stack"),
  );
  const stripped = readElfHardening(elfHardeningFixture({ symtab: false }));
  expect(findRow(stripped.rows, "stripped").state).toBe("enabled");
  const noSections = readElfHardening(elfHardeningFixture({ sections: false }));
  expect(findRow(noSections.rows, "stripped").state).toBe("unknown");
  const oneBit = readElfHardening(
    elfHardeningFixture({ property: { arch: "x86", value: 0b01 } }),
  );
  expect(findRow(oneBit.rows, "cet_ibt_shstk")).toMatchObject({
    state: "partial",
    confidence: "derived",
  });
  const conflict = readElfHardening(
    elfHardeningFixture({ property: { arch: "x86", value: 1, also: 2 } }),
  );
  expect(findRow(conflict.rows, "cet_ibt_shstk").state).toBe("unknown");
  const same = readElfHardening(
    elfHardeningFixture({ property: { arch: "x86", value: 3, also: 3 } }),
  );
  expect(findRow(same.rows, "cet_ibt_shstk").state).toBe("enabled");
  const aarch64 = readElfHardening(
    elfHardeningFixture({
      machine: 183,
      property: { arch: "aarch64", value: 0b11 },
    }),
  );
  expect(findRow(aarch64.rows, "aarch64_bti_pac").state).toBe("enabled");
  expect(findRow(aarch64.rows, "cet_ibt_shstk").state).toBe("not_applicable");
  const canaryOnly = readElfHardening(elfHardeningFixture({ stackChk: true }));
  expect(findRow(canaryOnly.rows, "stack_protector").state).toBe("enabled");
  expect(findRow(canaryOnly.rows, "fortify").state).toBe("unknown");
});

it("rejects truncated, duplicate and over-budget ELF tables", () => {
  expect(() => readElfHardening(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toThrow(
    BinaryFormatFailure,
  );
  expect(() =>
    readElfHardening(elfHardeningFixture({ truncateDynamic: true })),
  ).toThrow(expect.objectContaining({ kind: "malformed" }));
  expect(() =>
    readElfHardening(elfHardeningFixture({ duplicateStack: true })),
  ).toThrow(expect.objectContaining({ kind: "malformed" }));
  const overBudget = readElfHardening(
    elfHardeningFixture({ symbolBudget: true }),
  );
  expect(overBudget.status).toBe("parsed");
  expect(findRow(overBudget.rows, "nx").state).toBe("enabled");
  expect(findRow(overBudget.rows, "stack_protector")).toMatchObject({
    state: "unknown",
    note: expect.stringContaining("structural budget"),
  });
  expect(findRow(overBudget.rows, "fortify").state).toBe("unknown");
  const longPath = "A".repeat(70000);
  const longRpath = readElfHardening(elfHardeningFixture({ rpath: longPath }));
  expect(findRow(longRpath.rows, "rpath")).toMatchObject({
    state: "unknown",
    note: expect.stringContaining("name budget"),
  });
  expect(findRow(longRpath.rows, "rpath").note).not.toContain("AAA");
  expect(findRow(longRpath.rows, "nx").state).toBe("enabled");
  const big = readElfHardening(elfHardeningFixture({ little: false }));
  expect(big.byte_order).toBe("big");
  expect(findRow(big.rows, "nx").state).toBe("enabled");
});

it("reports PE DllCharacteristics, GuardFlags and directory presence", async () => {
  const bytes = peHardeningImage();
  const image = await readPeHardening(bytes, peArtifact(bytes));
  expect(image.rows.map(({ property }) => property)).toEqual([
    ...PE_HARDENING_PROPERTIES,
  ]);
  expect(states(image.rows)).toEqual({
    dynamic_base: "enabled",
    high_entropy_va: "enabled",
    nx_compat: "enabled",
    force_integrity: "disabled",
    no_seh: "disabled",
    guard_cf: "enabled",
    cfg_instrumented: "enabled",
    authenticode_present: "disabled",
    debug_record_present: "disabled",
  });
  expect(image.architecture).toBe("x86_64");
  expect(findRow(image.rows, "dynamic_base").location).toEqual({
    offset: image.rows[0]?.location?.offset,
    bytes: 2,
  });
  expect(findRow(image.rows, "cfg_instrumented").note).toEqual(
    expect.stringContaining("linker claim"),
  );
  const cleared = peHardeningImage({ characteristics: 0 });
  const clearImage = await readPeHardening(cleared, peArtifact(cleared));
  expect(findRow(clearImage.rows, "nx_compat").state).toBe("disabled");
  expect(findRow(clearImage.rows, "cfg_instrumented").state).toBe("enabled");
  const unknownCfg = peHardeningImage({ loadConfig: false });
  expect(
    findRow(
      (await readPeHardening(unknownCfg, peArtifact(unknownCfg))).rows,
      "cfg_instrumented",
    ).state,
  ).toBe("unknown");
  const shortConfig = peHardeningImage({ loadConfigSize: 64 });
  expect(
    findRow(
      (await readPeHardening(shortConfig, peArtifact(shortConfig))).rows,
      "cfg_instrumented",
    ).state,
  ).toBe("unknown");
  const signed = peHardeningImage({
    certificate: { address: 0x1000, size: 8 },
    debug: { address: 0x2000, size: 16 },
  });
  const signedImage = await readPeHardening(signed, peArtifact(signed));
  expect(findRow(signedImage.rows, "authenticode_present")).toMatchObject({
    state: "enabled",
    basis: expect.stringContaining("presence, not validity"),
    location: { bytes: 8 },
  });
  expect(findRow(signedImage.rows, "debug_record_present").state).toBe(
    "enabled",
  );
  const half = peHardeningImage({ certificate: { address: 0, size: 8 } });
  const halfImage = await readPeHardening(half, peArtifact(half));
  expect(findRow(halfImage.rows, "authenticode_present").state).toBe("unknown");
  expect(findRow(halfImage.rows, "dynamic_base").state).toBe("enabled");
  const halfDebug = peHardeningImage({ debug: { address: 0x2000, size: 0 } });
  expect(
    findRow(
      (await readPeHardening(halfDebug, peArtifact(halfDebug))).rows,
      "debug_record_present",
    ).state,
  ).toBe("unknown");
  const unmappedTls = peHardeningImage({ malformed: "tls-unmapped" });
  const unmappedImage = await readPeHardening(
    unmappedTls,
    peArtifact(unmappedTls),
  );
  expect(findRow(unmappedImage.rows, "cfg_instrumented").state).toBe("unknown");
  expect(findRow(unmappedImage.rows, "dynamic_base").state).toBe("enabled");
  expect(findRow(unmappedImage.rows, "guard_cf").state).toBe("enabled");
  const halfTls = peHardeningImage({ malformed: "tls-half" });
  const halfTlsImage = await readPeHardening(halfTls, peArtifact(halfTls));
  expect(findRow(halfTlsImage.rows, "cfg_instrumented").state).toBe("unknown");
  expect(findRow(halfTlsImage.rows, "nx_compat").state).toBe("enabled");
  const narrow = peHardeningImage({ bits: 32, characteristics: 0x4160 });
  const narrowImage = await readPeHardening(narrow, peArtifact(narrow));
  expect(narrowImage.bits).toBe(32);
  expect(findRow(narrowImage.rows, "dynamic_base").state).toBe("enabled");
  expect(findRow(narrowImage.rows, "high_entropy_va").state).toBe(
    "not_applicable",
  );
});

it("reports Mach-O header flags, imports and per-slice defects", async () => {
  const image = (await readMachoHardening(machoHardeningFixture()))[0];
  if (image === undefined) throw new Error("Missing Mach-O image");
  expect(image.rows.map(({ property }) => property)).toEqual([
    ...MACHO_HARDENING_PROPERTIES,
  ]);
  expect(states(image.rows)).toEqual({
    pie: "enabled",
    allow_stack_execution: "disabled",
    no_heap_execution: "enabled",
    restrict_segment: "disabled",
    code_signature_present: "disabled",
    encrypted: "disabled",
    arm64e: "disabled",
    stack_protector: "unknown",
    hardened_runtime: "unknown",
  });
  expect(findRow(image.rows, "hardened_runtime")).toMatchObject({
    next_probe: "inspect_signature",
    note: expect.stringContaining("inspect_signature"),
  });
  expect(image.rows.every((entry) => entry.confidence === "observed")).toBe(
    true,
  );
  expect(image.slice).toBeNull();

  const marked = (
    await readMachoHardening(
      machoHardeningFixture({
        flags: 0x20000,
        restrict: true,
        codeSignature: true,
        encrypted: true,
        stackChk: true,
        cpuSubtype: 2,
      }),
    )
  )[0];
  if (marked === undefined) throw new Error("Missing marked image");
  expect(states(marked.rows)).toMatchObject({
    pie: "disabled",
    allow_stack_execution: "enabled",
    no_heap_execution: "disabled",
    restrict_segment: "enabled",
    code_signature_present: "enabled",
    encrypted: "enabled",
    arm64e: "enabled",
    stack_protector: "enabled",
  });
  expect(findRow(marked.rows, "code_signature_present").basis).toContain(
    "not validity",
  );
  expect(findRow(marked.rows, "stack_protector").basis).toContain(
    "Undefined symbol",
  );
  const defined = (
    await readMachoHardening(
      machoHardeningFixture({ stackChk: true, definedSymbol: true }),
    )
  )[0];
  expect(findRow(defined?.rows ?? [], "stack_protector").state).toBe("unknown");
  expect(findRow(defined?.rows ?? [], "pie").state).toBe("enabled");
  const embeddedRestrict = (
    await readMachoHardening(
      machoHardeningFixture({ restrictName: "__RESTRICT\0junk!" }),
    )
  )[0];
  expect(findRow(embeddedRestrict?.rows ?? [], "restrict_segment").state).toBe(
    "enabled",
  );
  const clearCrypt = (
    await readMachoHardening(machoHardeningFixture({ encrypted: false }))
  )[0];
  expect(findRow(clearCrypt?.rows ?? [], "encrypted").state).toBe("disabled");
  const emptySymbols = (
    await readMachoHardening(machoHardeningFixture({ stackChk: false }))
  )[0];
  expect(findRow(emptySymbols?.rows ?? [], "stack_protector").state).toBe(
    "unknown",
  );
  const i386 = (
    await readMachoHardening(machoHardeningFixture({ bits: 32 }))
  )[0];
  expect(findRow(i386?.rows ?? [], "arm64e").state).toBe("not_applicable");
});

it("keeps Mach-O siblings when one slice is big-endian, mismatched or malformed", async () => {
  await expect(
    readMachoHardening(machoHardeningFixture({ bigEndian: true })),
  ).rejects.toMatchObject({ kind: "unsupported" });
  const arm = machoHardeningFixture();
  const bigSlice = machoHardeningFixture({ bigEndian: true });
  const mixed = await readMachoHardening(
    fatMachoHardeningFixture([
      { bytes: arm, cpuType: 0x0100000c, cpuSubtype: 0 },
      { bytes: bigSlice, cpuType: 0x0100000c, cpuSubtype: 0 },
    ]),
  );
  expect(mixed[0]?.status).toBe("parsed");
  expect(mixed[1]).toMatchObject({
    status: "unknown",
    rows: [],
    byte_order: null,
  });

  const intel = machoHardeningFixture({ cpuType: 0x01000007 });
  const fat = await readMachoHardening(
    fatMachoHardeningFixture([
      { bytes: arm, cpuType: 0x0100000c, cpuSubtype: 0 },
      {
        bytes: intel,
        cpuType: 0x01000007,
        cpuSubtype: 0,
        fatCpuType: 0x0100000c,
      },
    ]),
  );
  expect(fat[0]?.status).toBe("parsed");
  expect(fat[0]?.slice).not.toBeNull();
  expect(fat[1]).toMatchObject({
    status: "malformed",
    rows: [],
    byte_order: "little",
    reason: expect.stringContaining("CPU type/subtype disagrees"),
  });
  const oneSlice = await readMachoHardening(
    fatMachoHardeningFixture([
      { bytes: arm, cpuType: 0x0100000c, cpuSubtype: 0 },
    ]),
  );
  expect(oneSlice[0]?.slice?.architecture).toBe("arm64");

  const hugeSymbols = (
    await readMachoHardening(machoHardeningFixture({ nsyms: 65537 }))
  )[0];
  expect(hugeSymbols?.status).toBe("parsed");
  expect(findRow(hugeSymbols?.rows ?? [], "pie").state).toBe("enabled");
  expect(findRow(hugeSymbols?.rows ?? [], "stack_protector")).toMatchObject({
    state: "unknown",
    note: expect.stringContaining("structural budget"),
  });
  const hugeSlice = machoHardeningFixture({ nsyms: 65537 });
  const kept = await readMachoHardening(
    fatMachoHardeningFixture([
      { bytes: arm, cpuType: 0x0100000c, cpuSubtype: 0 },
      { bytes: hugeSlice, cpuType: 0x0100000c, cpuSubtype: 0 },
    ]),
  );
  expect(kept[0]?.status).toBe("parsed");
  expect(findRow(kept[0]?.rows ?? [], "pie").state).toBe("enabled");
  expect(kept[1]?.status).toBe("parsed");
  expect(findRow(kept[1]?.rows ?? [], "stack_protector").state).toBe("unknown");
  await expect(
    readMachoHardening(machoHardeningFixture({ brokenStrx: true })),
  ).rejects.toMatchObject({ kind: "malformed" });
  const brokenHeader = machoHardeningFixture();
  brokenHeader.writeUInt32LE(4, 20);
  await expect(readMachoHardening(brokenHeader)).rejects.toMatchObject({
    kind: "malformed",
  });
  const badSlice = machoHardeningFixture();
  badSlice.writeUInt32LE(4, 20);
  const siblings = await readMachoHardening(
    fatMachoHardeningFixture([
      { bytes: arm, cpuType: 0x0100000c, cpuSubtype: 0 },
      { bytes: badSlice, cpuType: 0x0100000c, cpuSubtype: 0 },
    ]),
  );
  expect(siblings[0]?.status).toBe("parsed");
  expect(siblings[0]?.rows.length).toBeGreaterThan(0);
  expect(siblings[1]).toMatchObject({ status: "malformed", rows: [] });
  await expect(readMachoHardening(Buffer.from("not macho"))).rejects.toThrow(
    expect.objectContaining({ kind: "unsupported" }),
  );
});

it("keeps repeated DT_NEEDED and still rejects a duplicated singular tag", () => {
  const needed = readElfHardening(
    elfHardeningFixture({ needed: ["libc.so.6", "libm.so.6"] }),
  );
  expect(needed.status).toBe("parsed");
  expect(() =>
    readElfHardening(elfHardeningFixture({ duplicateFlags: true })),
  ).toThrow(expect.objectContaining({ kind: "malformed" }));
});

it("reads a 4-aligned build-id note and bounds aliased note walks", () => {
  const buildId = readElfHardening(elfHardeningFixture({ buildId: true }));
  expect(findRow(buildId.rows, "cet_ibt_shstk").state).toBe("disabled");
  const aliased = readElfHardening(
    elfHardeningFixture({ buildId: true, buildIdSections: 300 }),
  );
  expect(aliased.status).toBe("parsed");
  const manyBuildIds = readElfHardening(
    elfHardeningFixture({ buildIdCount: 257 }),
  );
  expect(manyBuildIds.status).toBe("parsed");
  expect(findRow(manyBuildIds.rows, "nx").state).toBe("enabled");
  expect(findRow(manyBuildIds.rows, "pie").state).toBe("not_applicable");
  expect(findRow(manyBuildIds.rows, "relro").state).toBe("disabled");
  const copiedProperties = readElfHardening(
    elfHardeningFixture({
      property: { arch: "x86", value: 0b11 },
      propertyCopies: 200,
    }),
  );
  expect(copiedProperties.status).toBe("parsed");
  expect(findRow(copiedProperties.rows, "cet_ibt_shstk").state).toBe("enabled");
  expect(findRow(copiedProperties.rows, "nx").state).toBe("enabled");
  expect(() =>
    readElfHardening(
      elfHardeningFixture({ buildId: true }),
      AbortSignal.abort(),
    ),
  ).toThrow(ArtifactReaderFailure);
});

it.each(["pt-note", "pt-gnu-property", "section-only"] as const)(
  "identifies GNU properties by note owner and type in renamed sections (%s)",
  (propertyCarrier) => {
    const bytes = elfHardeningFixture({
      propertyCarrier:
        propertyCarrier === "section-only" ? "pt-note" : propertyCarrier,
      property: { arch: "x86", value: 3 },
    });
    const nameAt = bytes.indexOf(Buffer.from(".note.gnu.property\0"));
    expect(nameAt).toBeGreaterThan(0);
    bytes.write(".note.custom.abcde\0", nameAt, "latin1");
    if (propertyCarrier === "section-only") {
      const phoff = Number(bytes.readBigUInt64LE(32));
      for (let index = 0; index < bytes.readUInt16LE(56); index += 1) {
        const at = phoff + index * 56;
        if (bytes.readUInt32LE(at) === 4) bytes.writeUInt32LE(0, at);
      }
    }
    expect(findRow(readElfHardening(bytes).rows, "cet_ibt_shstk").state).toBe(
      "enabled",
    );
  },
);

it.each([0, 1, 2])(
  "keeps partially covered PT_NOTE contents unknown (section note %i)",
  (sectionNote) => {
    const bytes = elfHardeningFixture({
      propertyCarrier: "pt-note",
      property: { arch: "x86", value: 3 },
      propertyCopies: 3,
    });
    const shoff = Number(bytes.readBigUInt64LE(40));
    let sectionAt = 0;
    for (let index = 0; index < bytes.readUInt16LE(60); index += 1) {
      const at = shoff + index * 64;
      if (bytes.readUInt32LE(at + 4) === 7) sectionAt = at;
    }
    expect(sectionAt).toBeGreaterThan(0);
    const noteAt = Number(bytes.readBigUInt64LE(sectionAt + 24));
    const noteBytes = Number(bytes.readBigUInt64LE(sectionAt + 32)) / 3;
    const coveredAt = noteAt + sectionNote * noteBytes;
    // The section aliases just a build-id; CET remains in the segment's
    // uncovered prefix and/or suffix.
    bytes.writeUInt32LE(3, coveredAt + 8);
    bytes.writeBigUInt64LE(BigInt(coveredAt), sectionAt + 24);
    bytes.writeBigUInt64LE(BigInt(noteBytes), sectionAt + 32);
    const image = readElfHardening(bytes);
    expect(findRow(image.rows, "cet_ibt_shstk")).toMatchObject({
      state: "unknown",
      note: expect.stringContaining("uncovered bytes"),
    });
    expect(findRow(image.rows, "nx").state).toBe("enabled");
    // Without the alias, all segment notes are available to the walker.
    bytes.writeUInt32LE(1, sectionAt + 4);
    expect(findRow(readElfHardening(bytes).rows, "cet_ibt_shstk").state).toBe(
      "enabled",
    );
  },
);

it.each([true, false])(
  "preserves sectionless imports with an empty GNU hash (SysV count: %s)",
  (withSysv) => {
    const original = elfHardeningFixture({
      sections: false,
      stackChk: true,
      fortify: true,
      bindNowTag: true,
    });
    const bytes = Buffer.concat([original, Buffer.alloc(32)]);
    const phoff = Number(bytes.readBigUInt64LE(32));
    bytes.writeBigUInt64LE(BigInt(bytes.length), phoff + 32);
    bytes.writeBigUInt64LE(BigInt(bytes.length), phoff + 40);
    // One bloom word and an empty bucket; symoffset is not a symbol count.
    bytes.writeUInt32LE(1, original.length);
    bytes.writeUInt32LE(1, original.length + 4);
    bytes.writeUInt32LE(1, original.length + 8);
    for (let index = 0; index < bytes.readUInt16LE(56); index += 1) {
      const at = phoff + index * 56;
      if (bytes.readUInt32LE(at) !== 2) continue;
      const dynamicAt = Number(bytes.readBigUInt64LE(at + 8));
      for (
        let entry = dynamicAt;
        bytes.readBigUInt64LE(entry) !== 0n;
        entry += 16
      ) {
        const tag = bytes.readBigUInt64LE(entry);
        if (tag === 24n) {
          bytes.writeBigUInt64LE(0x6ffffef5n, entry);
          bytes.writeBigUInt64LE(BigInt(original.length), entry + 8);
        } else if (tag === 4n && !withSysv) {
          bytes.writeBigUInt64LE(21n, entry); // DT_DEBUG, no count information.
          bytes.writeBigUInt64LE(0n, entry + 8);
        }
      }
    }
    const image = readElfHardening(bytes);
    expect(image.rows.map(({ property }) => property)).toEqual([
      ...ELF_HARDENING_PROPERTIES,
    ]);
    expect(states(image.rows)).toMatchObject({
      nx: "enabled",
      stack_protector: withSysv ? "enabled" : "unknown",
      fortify: withSysv ? "enabled" : "unknown",
    });
    if (withSysv) {
      // A nonempty GNU chain still supplies an exact count that must agree.
      bytes.writeUInt32LE(1, original.length + 24);
      bytes.writeUInt32LE(1, original.length + 28);
      expect(() => readElfHardening(bytes)).toThrow(/different symbol counts/u);
    }
  },
);

it("reads sectionless GNU hash buckets with many non-owning load declarations", () => {
  const original = elfHardeningFixture({ sections: false, stackChk: true });
  const oldPhoff = Number(original.readBigUInt64LE(32));
  const oldPhnum = original.readUInt16LE(56);
  const buckets = 65536;
  const hashAt = original.length;
  const hashBytes = 24 + buckets * 4 + 4;
  const phoff = hashAt + hashBytes;
  const phnum = 60000;
  const bytes = Buffer.alloc(phoff + phnum * 56);
  original.copy(bytes);
  original.copy(bytes, phoff, oldPhoff, oldPhoff + oldPhnum * 56);
  bytes.writeBigUInt64LE(BigInt(phoff), 32);
  bytes.writeUInt16LE(phnum, 56);
  bytes.writeBigUInt64LE(BigInt(bytes.length), phoff + 32);
  bytes.writeBigUInt64LE(BigInt(bytes.length), phoff + 40);
  for (let index = oldPhnum; index < phnum; index += 1) {
    const at = phoff + index * 56;
    bytes.writeUInt32LE(1, at);
    bytes.writeBigUInt64LE(0x10000000n + BigInt(index * 4096), at + 16);
    bytes.writeBigUInt64LE(1n, at + 32);
    bytes.writeBigUInt64LE(1n, at + 40);
  }
  bytes.writeUInt32LE(buckets, hashAt);
  bytes.writeUInt32LE(1, hashAt + 4);
  bytes.writeUInt32LE(1, hashAt + 8);
  bytes.writeUInt32LE(1, hashAt + 24 + (buckets - 1) * 4);
  bytes.writeUInt32LE(1, hashAt + hashBytes - 4);
  for (let index = 0; index < oldPhnum; index += 1) {
    const at = phoff + index * 56;
    if (bytes.readUInt32LE(at) !== 2) continue;
    const dynamicAt = Number(bytes.readBigUInt64LE(at + 8));
    for (
      let entry = dynamicAt;
      bytes.readBigUInt64LE(entry) !== 0n;
      entry += 16
    ) {
      if (bytes.readBigUInt64LE(entry) !== 4n) continue;
      bytes.writeBigUInt64LE(0x6ffffef5n, entry);
      bytes.writeBigUInt64LE(BigInt(hashAt), entry + 8);
    }
  }
  expect(findRow(readElfHardening(bytes).rows, "stack_protector").state).toBe(
    "enabled",
  );
  // Retaining the mapping must still reject an ambiguous table owner.
  const extraAt = phoff + oldPhnum * 56;
  bytes.writeBigUInt64LE(BigInt(hashAt), extraAt + 8);
  bytes.writeBigUInt64LE(BigInt(hashAt), extraAt + 16);
  bytes.writeBigUInt64LE(BigInt(hashBytes), extraAt + 32);
  bytes.writeBigUInt64LE(BigInt(hashBytes), extraAt + 40);
  expect(() => readElfHardening(bytes)).toThrow(/exactly one PT_LOAD/u);
});

it.each([
  ["string table", 5, 18, null],
  ["string table with only its first byte mapped", 5, 18, 1],
  ["symbol table", 6, 48, null],
  ["SysV hash header", 4, 20, 7],
  ["SysV hash table", 4, 20, null],
  ["GNU hash header", 0x6ffffef5, 32, 15],
  ["GNU hash bloom filter", 0x6ffffef5, 32, 23],
  ["GNU hash bucket", 0x6ffffef5, 32, 27],
  ["GNU hash chain", 0x6ffffef5, 32, null],
] as const)(
  "rejects a dynamic %s extending beyond its file-backed PT_LOAD",
  (_label, tag, size, backedBytes) => {
    const original = elfHardeningFixture({ sections: false, stackChk: true });
    const bytes = Buffer.concat([original, Buffer.alloc(size)]);
    const phoff = Number(bytes.readBigUInt64LE(32));
    const phnum = bytes.readUInt16LE(56);
    let dynamicAt = 0;
    for (let index = 0; index < phnum; index += 1) {
      const at = phoff + index * 56;
      if (bytes.readUInt32LE(at) === 2)
        dynamicAt = Number(bytes.readBigUInt64LE(at + 8));
    }
    expect(dynamicAt).toBeGreaterThan(0);
    const sourceTag = tag === 0x6ffffef5 ? 4 : tag;
    for (let at = dynamicAt; bytes.readBigUInt64LE(at) !== 0n; at += 16) {
      if (bytes.readBigUInt64LE(at) !== BigInt(sourceTag)) continue;
      const source = Number(bytes.readBigUInt64LE(at + 8));
      if (tag === 0x6ffffef5) {
        // One bloom word, one bucket and one terminated chain for symbol 1.
        [1, 1, 1, 0, 0, 0, 1, 1].forEach((word, index) =>
          bytes.writeUInt32LE(word, original.length + index * 4),
        );
      } else original.copy(bytes, original.length, source, source + size);
      bytes.writeBigUInt64LE(BigInt(tag), at);
      bytes.writeBigUInt64LE(BigInt(original.length), at + 8);
    }
    bytes.writeBigUInt64LE(BigInt(bytes.length), phoff + 32);
    bytes.writeBigUInt64LE(BigInt(bytes.length), phoff + 40);
    expect(findRow(readElfHardening(bytes).rows, "stack_protector").state).toBe(
      "enabled",
    );
    bytes.writeBigUInt64LE(
      BigInt(original.length + (backedBytes ?? size - 1)),
      phoff + 32,
    );
    expect(() => readElfHardening(bytes)).toThrow(/file-backed/u);
  },
);

it("treats DT_BIND_NOW as full RELRO and leaves unsearched property notes unknown", () => {
  const bound = readElfHardening(
    elfHardeningFixture({ gnuRelro: true, bindNowTag: true }),
  );
  expect(findRow(bound.rows, "relro").state).toBe("enabled");
  const bare = readElfHardening(elfHardeningFixture({ sections: false }));
  expect(findRow(bare.rows, "cet_ibt_shstk").state).toBe("unknown");
  expect(findRow(bare.rows, "aarch64_bti_pac").state).toBe("not_applicable");
  const program = readElfHardening(
    elfHardeningFixture({
      sections: false,
      property: { arch: "x86", value: 0b11 },
    }),
  );
  expect(findRow(program.rows, "cet_ibt_shstk").state).toBe("enabled");
  const note = readElfHardening(
    elfHardeningFixture({
      sections: false,
      propertyCarrier: "pt-note",
      property: { arch: "x86", value: 0b11 },
    }),
  );
  expect(findRow(note.rows, "cet_ibt_shstk").state).toBe("enabled");
});

it("bounds aggregate ELF and Mach-O symbol-name scans", async () => {
  const elfScan = readElfHardening(
    elfHardeningFixture({ symbolScanBudget: true }),
  );
  expect(elfScan.status).toBe("parsed");
  expect(findRow(elfScan.rows, "nx").state).toBe("enabled");
  expect(findRow(elfScan.rows, "stack_protector")).toMatchObject({
    state: "unknown",
    note: expect.stringContaining("structural budget"),
  });
  expect(findRow(elfScan.rows, "fortify").state).toBe("unknown");
  const machoScan = (
    await readMachoHardening(machoHardeningFixture({ symbolScanBudget: true }))
  )[0];
  expect(machoScan?.status).toBe("parsed");
  expect(findRow(machoScan?.rows ?? [], "pie").state).toBe("enabled");
  expect(findRow(machoScan?.rows ?? [], "stack_protector")).toMatchObject({
    state: "unknown",
    note: expect.stringContaining("structural budget"),
  });
});

it("keeps ELF rows when an import name has no NUL in the name budget", () => {
  const image = readElfHardening(elfHardeningFixture({ longSymbolName: true }));
  expect(image.status).toBe("parsed");
  expect(findRow(image.rows, "nx").state).toBe("enabled");
  expect(findRow(image.rows, "relro").state).toBe("disabled");
  for (const property of ["stack_protector", "fortify"] as const)
    expect(findRow(image.rows, property)).toMatchObject({
      state: "unknown",
      note: expect.stringContaining("65536-byte name budget"),
    });
  const signed = readElfHardening(
    elfHardeningFixture({ longSymbolName: true, stackChk: true }),
  );
  expect(findRow(signed.rows, "stack_protector").state).toBe("enabled");
  expect(findRow(signed.rows, "fortify").state).toBe("unknown");
});

it("keeps Mach-O rows when an import name has no NUL in the name budget", async () => {
  const thin = (
    await readMachoHardening(machoHardeningFixture({ longSymbolName: true }))
  )[0];
  expect(thin?.status).toBe("parsed");
  expect(findRow(thin?.rows ?? [], "pie").state).toBe("enabled");
  expect(findRow(thin?.rows ?? [], "stack_protector")).toMatchObject({
    state: "unknown",
    note: expect.stringContaining("65536-byte name budget"),
  });
  const fat = await readMachoHardening(
    fatMachoHardeningFixture([
      {
        bytes: machoHardeningFixture({ longSymbolName: true }),
        cpuType: 0x0100000c,
        cpuSubtype: 0,
      },
    ]),
  );
  expect(fat[0]?.status).toBe("parsed");
  expect(fat[0]?.rows.length).toBe(MACHO_HARDENING_PROPERTIES.length);
});

it("notes each architecture's real default for a missing PT_GNU_STACK", () => {
  const note = (machine: number, bits: 32 | 64) =>
    findRow(
      readElfHardening(
        elfHardeningFixture({ bits, machine, gnuStack: null, symtab: false }),
      ).rows,
      "nx",
    );
  for (const [machine, bits] of [
    [3, 32],
    [20, 32],
    [40, 32],
  ] as const)
    expect(note(machine, bits)).toMatchObject({
      state: "unknown",
      note: expect.stringContaining("read-implies-exec"),
    });
  for (const [machine, bits] of [
    [21, 64],
    [62, 64],
    [183, 64],
    [243, 64],
  ] as const)
    expect(note(machine, bits)).toMatchObject({
      state: "unknown",
      note: expect.stringContaining("non-executable stack"),
    });
  expect(note(8, 32).note).not.toContain("default for");
});

it("does not read program-table absence from objects without them", () => {
  for (const type of [1, 4]) {
    const image = readElfHardening(
      elfHardeningFixture({ type, gnuStack: null }),
    );
    for (const property of ["nx", "relro", "rpath", "runpath"] as const)
      expect(findRow(image.rows, property)).toMatchObject({
        state: "not_applicable",
        location: { offset: 16, bytes: 2 },
      });
  }
  const bytes = elfHardeningFixture({ type: 3 });
  bytes.writeUInt16LE(0, 56);
  const image = readElfHardening(bytes);
  for (const property of ["pie", "nx", "relro", "rpath", "runpath"] as const)
    expect(findRow(image.rows, property).state).toBe("unknown");
});

it("reports the note budget it hit and keeps the header rows", () => {
  const entries = readElfHardening(
    elfHardeningFixture({ disjointNoteSections: 300 }),
  );
  expect(entries.status).toBe("parsed");
  expect(findRow(entries.rows, "nx").state).toBe("enabled");
  expect(findRow(entries.rows, "cet_ibt_shstk")).toMatchObject({
    state: "unknown",
    note: "ELF note tables exceed the 256-entry budget.",
  });
  const text = readElfHardening(
    elfHardeningFixture({ longNoteName: true, type: 2 }),
  );
  expect(findRow(text.rows, "pie").state).toBe("disabled");
  expect(findRow(text.rows, "cet_ibt_shstk")).toMatchObject({
    state: "unknown",
    note: expect.stringMatching(
      /^ELF note text exceeds the \d+-byte budget\.$/u,
    ),
  });
  expect(findRow(text.rows, "aarch64_bti_pac").state).toBe("not_applicable");
});

it("leaves GNU property rows unknown behind a compressed note section", () => {
  const image = readElfHardening(
    elfHardeningFixture({
      compressedPropertyNote: true,
      property: { arch: "x86", value: 0b11 },
      propertyCarrier: "pt-note",
    }),
  );
  expect(image.status).toBe("parsed");
  expect(findRow(image.rows, "nx").state).toBe("enabled");
  expect(findRow(image.rows, "cet_ibt_shstk")).toMatchObject({
    state: "unknown",
    note: expect.stringContaining("compressed SHT_NOTE"),
  });
});

it("admits a hostile section table without rescanning every span", () => {
  const started = performance.now();
  const image = readElfHardening(
    elfHardeningFixture({ disjointNoteSections: 65000 }),
  );
  expect(performance.now() - started).toBeLessThan(5000);
  expect(findRow(image.rows, "cet_ibt_shstk").state).toBe("unknown");
}, 60000);

it("cites a non-ASCII import name by its source bytes", () => {
  const name = "__\u00ff_chk";
  const bytes = elfHardeningFixture({ fortify: true, fortifyName: name });
  const image = readElfHardening(bytes);
  const row = findRow(image.rows, "fortify");
  expect(row).toMatchObject({ state: "enabled", location: { bytes: 7 } });
  const at = row.location?.offset ?? 0;
  expect(bytes.subarray(at, at + 7).toString("latin1")).toBe(name);
});

it("keeps malformed name offsets malformed in both formats", async () => {
  await expect(
    readMachoHardening(machoHardeningFixture({ brokenStrx: true })),
  ).rejects.toMatchObject({
    kind: "malformed",
    message: "Mach-O symbol name offset is outside the string table",
  });
});

it("names one CPU family per image and keeps the exact slice identity", async () => {
  const thin = (
    await readMachoHardening(machoHardeningFixture({ cpuSubtype: 2 }))
  )[0];
  expect(thin?.architecture).toBe("arm64");
  expect(findRow(thin?.rows ?? [], "arm64e").state).toBe("enabled");
  const fat = await readMachoHardening(
    fatMachoHardeningFixture([
      {
        bytes: machoHardeningFixture({ cpuSubtype: 2 }),
        cpuType: 0x0100000c,
        cpuSubtype: 2,
      },
    ]),
  );
  expect(fat[0]).toMatchObject({
    architecture: "arm64",
    slice: { architecture: "arm64e" },
  });
  const narrow = peHardeningImage({ bits: 32 });
  expect((await readPeHardening(narrow, peArtifact(narrow))).architecture).toBe(
    "x86",
  );
  const encoded = peHardeningImage();
  const pe = encoded.readUInt32LE(0x3c);
  encoded.writeUInt16LE(0x8664 ^ 0x7b79, pe + 4);
  expect(
    (await readPeHardening(encoded, peArtifact(encoded))).architecture,
  ).toBeNull();
});

it("names the load-config failure behind an unknown GuardFlags row", async () => {
  const bytes = peHardeningImage({ malformed: "tls-unmapped" });
  const row = findRow(
    (await readPeHardening(bytes, peArtifact(bytes))).rows,
    "cfg_instrumented",
  );
  expect(row).toMatchObject({
    state: "unknown",
    note: expect.stringMatching(/unknown here: \S/u),
  });
});

it("reports MH_PIE as not applicable on dylibs and bundles", async () => {
  for (const fileType of [6, 8]) {
    const image = (
      await readMachoHardening(machoHardeningFixture({ fileType }))
    )[0];
    expect(findRow(image?.rows ?? [], "pie")).toMatchObject({
      state: "not_applicable",
      basis: expect.stringContaining(fileType === 6 ? "MH_DYLIB" : "MH_BUNDLE"),
    });
  }
});

it("keeps header rows when a slice has conflicting encryption commands", async () => {
  const image = (
    await readMachoHardening(
      machoHardeningFixture({ encrypted: false, duplicateEncryption: true }),
    )
  )[0];
  expect(image?.status).toBe("parsed");
  expect(findRow(image?.rows ?? [], "pie").state).toBe("enabled");
  expect(findRow(image?.rows ?? [], "encrypted")).toMatchObject({
    state: "unknown",
    note: expect.stringContaining("encryption load commands"),
  });
});

it("keeps a parsed fat slice when another slice is empty or past EOF", async () => {
  const arm = machoHardeningFixture();
  const images = await readMachoHardening(
    fatMachoHardeningFixture([
      { bytes: arm, cpuType: 0x0100000c, cpuSubtype: 0 },
      {
        bytes: arm,
        cpuType: 0x0100000c,
        cpuSubtype: 0,
        declaredSize: 0,
        includePayload: false,
      },
      {
        bytes: arm,
        cpuType: 0x0100000c,
        cpuSubtype: 0,
        declaredSize: arm.length + 64,
      },
    ]),
  );
  expect(images.map((image) => image.status)).toEqual([
    "parsed",
    "malformed",
    "malformed",
  ]);
  expect(images[1]?.slice?.size).toBe(0);
  expect(images[2]?.slice?.size).toBe(arm.length + 64);
  expect(images[1]?.reason).toEqual(
    expect.stringContaining("invalid slice range"),
  );
  expect(images[2]?.reason).toEqual(
    expect.stringContaining("extends beyond the file"),
  );
});

/** Locate the 64-bit little-endian program header of a given type. */
const elfProgramAt = (bytes: Buffer, type: number): number => {
  const phoff = Number(bytes.readBigUInt64LE(32));
  for (let index = 0; index < bytes.readUInt16LE(56); index += 1) {
    const at = phoff + index * 56;
    if (bytes.readUInt32LE(at) === type) return at;
  }
  throw new Error(`Missing program type ${String(type)}`);
};

const elfSectionAt = (bytes: Buffer, type: number): number => {
  const shoff = Number(bytes.readBigUInt64LE(40));
  for (let index = 0; index < bytes.readUInt16LE(60); index += 1) {
    const at = shoff + index * 64;
    if (bytes.readUInt32LE(at + 4) === type) return at;
  }
  throw new Error(`Missing section type ${String(type)}`);
};

const elfDynamicEntryAt = (bytes: Buffer, tag: bigint): number => {
  const start = Number(bytes.readBigUInt64LE(elfProgramAt(bytes, 2) + 8));
  for (let at = start; bytes.readBigUInt64LE(at) !== 0n; at += 16)
    if (bytes.readBigUInt64LE(at) === tag) return at;
  throw new Error(`Missing dynamic tag ${tag.toString()}`);
};

const PT_LOAD = 1;
const PT_INTERP = 3;
const SHT_DYNSYM = 11;
const SHT_STRTAB = 3;
const DT_HASH = 4n;
const DT_GNU_HASH = 0x6ffffef5n;
const DT_SYMTAB = 6n;

/** Grow the image so its only PT_LOAD maps `extra`, returning where it landed. */
const appendMapped = (
  image: Buffer,
  extra: Buffer,
): { readonly bytes: Buffer; readonly at: number } => {
  const bytes = Buffer.concat([image, extra]);
  const load = elfProgramAt(bytes, PT_LOAD);
  bytes.writeBigUInt64LE(BigInt(bytes.length), load + 32);
  bytes.writeBigUInt64LE(BigInt(bytes.length), load + 40);
  return { bytes, at: image.length };
};

/** Replace DT_HASH with a DT_GNU_HASH whose only bucket is empty. */
const withEmptyGnuHash = (image: Buffer): Buffer => {
  const words = Buffer.alloc(32);
  [1, 1, 1, 0, 0, 0, 0, 0].forEach((word, index) =>
    words.writeUInt32LE(word, index * 4),
  );
  const { bytes, at } = appendMapped(image, words);
  const entry = elfDynamicEntryAt(bytes, DT_HASH);
  bytes.writeBigUInt64LE(DT_GNU_HASH, entry);
  bytes.writeBigUInt64LE(BigInt(at), entry + 8);
  return bytes;
};

it.each([
  ["PT_LOAD past EOF", PT_LOAD, 8, 0n, /program 0/u],
  ["PT_INTERP past EOF", PT_INTERP, 8, 1n << 40n, /program 1/u],
] as const)("rejects a %s", (_label, type, field, value, message) => {
  const bytes = elfHardeningFixture({ interp: true, bindNow: true });
  const at = elfProgramAt(bytes, type);
  if (value !== 0n) bytes.writeBigUInt64LE(value, at + field);
  else bytes.writeBigUInt64LE(BigInt(bytes.length + 1), at + 32);
  if (value === 0n) bytes.writeBigUInt64LE(BigInt(bytes.length + 1), at + 40);
  expect(() => readElfHardening(bytes)).toThrow(
    expect.objectContaining({
      kind: "malformed",
      message: expect.stringMatching(message),
    }),
  );
});

it("rejects a section payload past EOF and impossible load sizes", () => {
  const section = elfHardeningFixture();
  section.writeBigUInt64LE(
    BigInt(section.length + 1),
    elfSectionAt(section, 2) + 32,
  );
  expect(() => readElfHardening(section)).toThrow(/truncated ELF section/u);
  const larger = elfHardeningFixture();
  larger.writeBigUInt64LE(1n, elfProgramAt(larger, PT_LOAD) + 40);
  expect(() => readElfHardening(larger)).toThrow(
    /load segment sizes or addresses/u,
  );
  const wrapped = elfHardeningFixture();
  wrapped.writeBigUInt64LE(
    0xffffffffffffffffn,
    elfProgramAt(wrapped, PT_LOAD) + 16,
  );
  expect(() => readElfHardening(wrapped)).toThrow(
    /load segment sizes or addresses/u,
  );
});

it.each([
  ["empty", 0n, null],
  ["unterminated", null, 0x41],
] as const)("rejects an %s PT_INTERP", (_label, size, last) => {
  const bytes = elfHardeningFixture({ interp: true });
  const at = elfProgramAt(bytes, PT_INTERP);
  if (size !== null) bytes.writeBigUInt64LE(size, at + 32);
  if (last !== null)
    bytes[
      Number(bytes.readBigUInt64LE(at + 8)) +
        Number(bytes.readBigUInt64LE(at + 32)) -
        1
    ] = last;
  expect(() => readElfHardening(bytes)).toThrow(/PT_INTERP/u);
});

it("reads imports from DT_SYMTAB when section metadata names other symbols", () => {
  // The section names a protector the dynamic table does not declare.
  const donor = elfHardeningFixture({ stackChk: true, fortify: true });
  const donorSymbols = elfSectionAt(donor, SHT_DYNSYM);
  const donorStrings = elfSectionAt(donor, SHT_STRTAB);
  const slice = (header: number): Buffer => {
    const offset = Number(donor.readBigUInt64LE(header + 24));
    return donor.subarray(
      offset,
      offset + Number(donor.readBigUInt64LE(header + 32)),
    );
  };
  const { bytes, at } = appendMapped(
    elfHardeningFixture(),
    Buffer.concat([slice(donorSymbols), slice(donorStrings)]),
  );
  const symbols = elfSectionAt(bytes, SHT_DYNSYM);
  const strings = elfSectionAt(bytes, SHT_STRTAB);
  const symbolBytes = slice(donorSymbols).length;
  bytes.writeBigUInt64LE(BigInt(at), symbols + 16);
  bytes.writeBigUInt64LE(BigInt(at), symbols + 24);
  bytes.writeBigUInt64LE(BigInt(symbolBytes), symbols + 32);
  bytes.writeBigUInt64LE(BigInt(at + symbolBytes), strings + 16);
  bytes.writeBigUInt64LE(BigInt(at + symbolBytes), strings + 24);
  bytes.writeBigUInt64LE(BigInt(slice(donorStrings).length), strings + 32);
  const rows = readElfHardening(bytes).rows;
  expect(findRow(rows, "stack_protector").state).toBe("unknown");
  expect(findRow(rows, "fortify").state).toBe("unknown");
  // The reverse lie cannot hide a declared import.
  const declared = elfHardeningFixture({ stackChk: true });
  declared.writeBigUInt64LE(0n, elfSectionAt(declared, SHT_DYNSYM) + 32);
  expect(
    findRow(readElfHardening(declared).rows, "stack_protector").state,
  ).toBe("enabled");
});

it("does not treat SHT_DYNSYM names as imports without DT_SYMTAB", () => {
  const bytes = elfHardeningFixture({ stackChk: true });
  bytes.writeBigUInt64LE(0x60000000n, elfDynamicEntryAt(bytes, DT_SYMTAB));
  expect(
    findRow(readElfHardening(bytes).rows, "stack_protector"),
  ).toMatchObject({
    state: "unknown",
    note: expect.stringContaining("DT_SYMTAB"),
  });
});

it("sizes an empty DT_GNU_HASH table only from an agreeing SHT_DYNSYM", () => {
  const agreeing = withEmptyGnuHash(elfHardeningFixture({ stackChk: true }));
  expect(
    findRow(readElfHardening(agreeing).rows, "stack_protector"),
  ).toMatchObject({ state: "enabled" });
  const moved = Buffer.from(agreeing);
  const section = elfSectionAt(moved, SHT_DYNSYM);
  moved.writeBigUInt64LE(
    moved.readBigUInt64LE(section + 16) + 8n,
    section + 16,
  );
  const offset = Buffer.from(agreeing);
  offset.writeBigUInt64LE(
    offset.readBigUInt64LE(section + 24) + 8n,
    section + 24,
  );
  const strings = Buffer.from(agreeing);
  strings.writeBigUInt64LE(
    strings.readBigUInt64LE(elfSectionAt(strings, SHT_STRTAB) + 32) - 1n,
    elfSectionAt(strings, SHT_STRTAB) + 32,
  );
  for (const bytes of [moved, offset, strings])
    expect(
      findRow(readElfHardening(bytes).rows, "stack_protector"),
    ).toMatchObject({
      state: "unknown",
      note: expect.stringContaining("DT_GNU_HASH"),
    });
});

it("keeps an unresolved symbol count distinct from an absent table", () => {
  const image = readElfHardening(
    withEmptyGnuHash(elfHardeningFixture({ sections: false, stackChk: true })),
  );
  for (const property of ["stack_protector", "fortify"] as const) {
    const row = findRow(image.rows, property);
    expect(row).toMatchObject({
      state: "unknown",
      note: expect.stringContaining("DT_GNU_HASH"),
    });
    expect(row.basis).not.toContain("absent");
  }
  const noHash = elfHardeningFixture({ sections: false, stackChk: true });
  noHash.writeBigUInt64LE(0x60000000n, elfDynamicEntryAt(noHash, DT_HASH));
  expect(findRow(readElfHardening(noHash).rows, "fortify")).toMatchObject({
    state: "unknown",
    note: expect.stringContaining("DT_HASH"),
  });
  const absent = readElfHardening(elfHardeningFixture({ dynamic: false }));
  expect(findRow(absent.rows, "fortify").basis).toContain("absent");
});

const machoCommand = (command: number, size: number, ...words: number[]) => {
  const body = Buffer.alloc(size);
  body.writeUInt32LE(command, 0);
  body.writeUInt32LE(size, 4);
  words.forEach((word, index) => body.writeUInt32LE(word, 8 + index * 4));
  return body;
};

const LC_CODE_SIGNATURE = 0x1d;
const LC_SEGMENT_64 = 0x19;
const CPU_ARM64 = 0x0100000c;

it.each([
  [
    "an eight-byte LC_CODE_SIGNATURE",
    { codeSignature: false },
    machoCommand(LC_CODE_SIGNATURE, 8),
    /too short for LC_CODE_SIGNATURE/u,
  ],
  [
    "a LC_CODE_SIGNATURE range outside the slice",
    {},
    machoCommand(LC_CODE_SIGNATURE, 16, 0xfffffff0, 0x1000),
    /LC_CODE_SIGNATURE.*outside/u,
  ],
  [
    "a truncated segment after __RESTRICT",
    { restrict: true },
    machoCommand(LC_SEGMENT_64, 8),
    /segment header is truncated/u,
  ],
] as const)("rejects %s", async (_label, options, command, message) => {
  const bytes = machoHardeningFixture({
    ...options,
    extraCommands: [command],
  });
  await expect(readMachoHardening(bytes)).rejects.toMatchObject({
    kind: "malformed",
    message: expect.stringMatching(message),
  });
  const images = await readMachoHardening(
    fatMachoHardeningFixture([
      { bytes: machoHardeningFixture(), cpuType: CPU_ARM64, cpuSubtype: 0 },
      { bytes, cpuType: CPU_ARM64, cpuSubtype: 0 },
    ]),
  );
  expect(images.map((image) => image.status)).toEqual(["parsed", "malformed"]);
  expect(images[1]?.reason).toMatch(message);
  expect(images[1]?.rows).toEqual([]);
});

it("reads facts past a large table of unrelated Mach-O commands", async () => {
  const filler = Array.from({ length: 200_000 }, () => machoCommand(0x7fff, 8));
  const image = (
    await readMachoHardening(
      machoHardeningFixture({
        extraCommands: [...filler, machoCommand(LC_CODE_SIGNATURE, 16)],
        stackChk: true,
      }),
    )
  )[0];
  expect(image?.status).toBe("parsed");
  expect(findRow(image?.rows ?? [], "code_signature_present").state).toBe(
    "enabled",
  );
  expect(findRow(image?.rows ?? [], "stack_protector").state).toBe("enabled");
});

it("rejects p_filesz one above p_memsz like the ELF image reader", () => {
  const bytes = elfHardeningFixture({ interp: true, bindNow: true });
  const load = elfProgramAt(bytes, PT_LOAD);
  bytes.writeBigUInt64LE(bytes.readBigUInt64LE(load + 32) - 1n, load + 40);
  const message = "ELF load segment sizes or addresses are invalid";
  expect(() => readElfImage(bytes)).toThrow(message);
  expect(() => readElfHardening(bytes)).toThrow(
    expect.objectContaining({ kind: "malformed", message }),
  );
});

const machoSegment = (
  bits: 32 | 64,
  {
    commandSize = bits === 64 ? 72 : 56,
    name = "__RESTRICT",
    vmSize = 0,
    fileOffset = 0,
    fileSize = 0,
    sections = 0,
  }: {
    readonly commandSize?: number;
    readonly name?: string;
    readonly vmSize?: number;
    readonly fileOffset?: number;
    readonly fileSize?: number;
    readonly sections?: number;
  },
): Buffer => {
  const body = machoCommand(bits === 64 ? LC_SEGMENT_64 : 1, commandSize);
  body.write(name, 8, "latin1");
  if (bits === 64) {
    body.writeBigUInt64LE(BigInt(vmSize), 32);
    body.writeBigUInt64LE(BigInt(fileOffset), 40);
    body.writeBigUInt64LE(BigInt(fileSize), 48);
    body.writeUInt32LE(sections, 64);
  } else {
    body.writeUInt32LE(vmSize, 28);
    body.writeUInt32LE(fileOffset, 32);
    body.writeUInt32LE(fileSize, 36);
    body.writeUInt32LE(sections, 48);
  }
  return body;
};

it.each([
  [
    "a section count above cmdsize",
    64,
    { sections: 1 },
    "Mach-O section table exceeds its segment command",
  ],
  [
    "a 32-bit section count above cmdsize",
    32,
    { sections: 1 },
    "Mach-O section table exceeds its segment command",
  ],
  [
    "a file size above the VM size",
    64,
    { vmSize: 8, fileSize: 16 },
    "Mach-O segment addresses or sizes are invalid",
  ],
  [
    "a payload past EOF",
    64,
    { vmSize: 0x100000, fileOffset: 0x100000, fileSize: 16 },
    "Mach-O segment range is outside the file",
  ],
] as const)(
  "rejects %s like the Mach-O image reader",
  async (_label, bits, segment, message) => {
    const bytes = machoHardeningFixture({
      bits,
      extraCommands: [machoSegment(bits, segment)],
    });
    expect(() => readMachoImage(bytes)).toThrow(message);
    await expect(readMachoHardening(bytes)).rejects.toMatchObject({
      kind: "malformed",
      message,
    });
    const images = await readMachoHardening(
      fatMachoHardeningFixture([
        {
          bytes: machoHardeningFixture({ bits }),
          cpuType: bits === 64 ? CPU_ARM64 : 7,
          cpuSubtype: 0,
        },
        { bytes, cpuType: bits === 64 ? CPU_ARM64 : 7, cpuSubtype: 0 },
      ]),
    );
    expect(images.map((image) => image.status)).toEqual([
      "parsed",
      "malformed",
    ]);
    expect(images[1]?.reason).toBe(message);
    expect(images[1]?.rows).toEqual([]);
  },
);

it("measures a segment file range against its slice, not the container", async () => {
  // In a fat file this range lands inside the container but past its own slice.
  const slice = machoHardeningFixture();
  const bad = machoHardeningFixture({
    extraCommands: [
      machoSegment(64, {
        vmSize: 0x10000,
        fileOffset: slice.length * 2,
        fileSize: 16,
      }),
    ],
  });
  const images = await readMachoHardening(
    fatMachoHardeningFixture([
      { bytes: bad, cpuType: CPU_ARM64, cpuSubtype: 0 },
      { bytes: slice, cpuType: CPU_ARM64, cpuSubtype: 0 },
    ]),
  );
  expect(images.map((image) => image.status)).toEqual(["malformed", "parsed"]);
});

it("accepts well-formed segments with sections and file payloads", async () => {
  const size = 72 + 80;
  const probe = machoHardeningFixture({
    extraCommands: [machoSegment(64, { commandSize: size })],
  });
  const image = (
    await readMachoHardening(
      machoHardeningFixture({
        extraCommands: [
          machoSegment(64, {
            commandSize: size,
            sections: 1,
            vmSize: probe.length,
            fileSize: probe.length,
          }),
        ],
      }),
    )
  )[0];
  expect(findRow(image?.rows ?? [], "restrict_segment").state).toBe("enabled");
});
