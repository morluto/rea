import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import {
  ghidraRiscvLoadPreparation,
  ghidraRiscvUnsupportedReason,
} from "../../../src/ghidra/GhidraRiscvProfile.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;
const SHT_NOBITS = 8;
const SHT_RISCV_ATTRIBUTES = 0x70000003;
const ALLOC = 0x2;
const WRITE_ALLOC = 0x3;
const EXEC_ALLOC = 0x6;
const SECTION_TABLE = 128;
// Deliberately outside BinaryTargetResolver's 4 KiB probe.
const PAYLOADS = 8192;
// ESP-IDF's ESP32-C6 base string, which the ilp32 lane admits.
const C6_ARCH =
  "rv32i2p1_m2p0_a2p1_c2p0_zicsr2p0_zifencei2p0_zmmul1p0_zaamo1p0_zalrsc1p0";

interface Section {
  readonly name: string;
  readonly type: number;
  readonly flags: number;
  readonly address: number;
  readonly size: number;
  readonly payload?: Buffer;
}

const attributes = (): Buffer => {
  const list = [5, ...Buffer.from(`${C6_ARCH}\0`, "latin1")];
  const scoped = Buffer.alloc(5 + list.length);
  scoped[0] = 1; // Tag_File
  scoped.writeUInt32LE(scoped.length, 1);
  scoped.set(list, 5);
  const vendor = Buffer.from("riscv\0", "latin1");
  const header = Buffer.alloc(5);
  header[0] = 0x41;
  header.writeUInt32LE(4 + vendor.length + scoped.length, 1);
  return Buffer.concat([header, vendor, scoped]);
};

/**
 * An ELF32 RISC-V soft-float image with these sections, its attributes and,
 * unless `names` is false, a section-name table.
 */
const elf = (
  sections: readonly Section[],
  options: { readonly type?: number; readonly names?: boolean } = {},
): Buffer => {
  const all: Section[] = [
    ...sections,
    {
      name: ".riscv.attributes",
      type: SHT_RISCV_ATTRIBUTES,
      flags: 0,
      address: 0,
      size: 0,
      payload: attributes(),
    },
  ];
  const names = Buffer.from(
    `\0${[...all.map((section) => section.name), ".shstrtab"].join("\0")}\0`,
    "latin1",
  );
  if (options.names !== false)
    all.push({
      name: ".shstrtab",
      type: SHT_STRTAB,
      flags: 0,
      address: 0,
      size: 0,
      payload: names,
    });
  const filed = all.map((section) =>
    section.type === SHT_NOBITS
      ? Buffer.alloc(0)
      : (section.payload ?? Buffer.alloc(section.size, 0x13)),
  );
  const bytes = Buffer.alloc(
    PAYLOADS + filed.reduce((total, payload) => total + payload.length, 0),
  );
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  bytes.writeUInt16LE(options.type ?? 2, 16);
  bytes.writeUInt16LE(243, 18); // EM_RISCV
  bytes.writeUInt32LE(1, 20);
  bytes.writeUInt32LE(SECTION_TABLE, 32);
  bytes.writeUInt32LE(0x1, 36); // RVC, soft-float ABI
  bytes.writeUInt16LE(52, 40);
  bytes.writeUInt16LE(32, 42);
  bytes.writeUInt16LE(40, 46);
  bytes.writeUInt16LE(1 + all.length, 48);
  bytes.writeUInt16LE(options.names === false ? 0 : all.length, 50);
  let offset = PAYLOADS;
  let nameOffset = 1;
  all.forEach((section, index) => {
    const header = SECTION_TABLE + (1 + index) * 40;
    const payload = filed[index] ?? Buffer.alloc(0);
    bytes.writeUInt32LE(nameOffset, header);
    nameOffset += section.name.length + 1;
    bytes.writeUInt32LE(section.type, header + 4);
    bytes.writeUInt32LE(section.flags, header + 8);
    bytes.writeUInt32LE(section.address, header + 12);
    bytes.writeUInt32LE(offset, header + 16);
    bytes.writeUInt32LE(
      section.type === SHT_NOBITS ? section.size : payload.length,
      header + 20,
    );
    payload.copy(bytes, offset);
    offset += payload.length;
  });
  return bytes;
};

const resolve = async (bytes: Buffer) => {
  const directory = await createTestTempDirectory("rea-elf-overlap-test-");
  const path = join(directory, "fixture.elf");
  await writeFile(path, bytes);
  const resolved = await parseBinaryTarget(path);
  if (!resolved.ok) throw resolved.error;
  if (
    resolved.value.kind !== "executable" ||
    resolved.value.architecture !== "riscv"
  )
    throw new Error("Expected a resolved RISC-V executable");
  return {
    overlap: resolved.value.riscv.sectionOverlap,
    refusal: ghidraRiscvUnsupportedReason(resolved.value),
    preparation: ghidraRiscvLoadPreparation(resolved.value),
  };
};

// The ESP-IDF v6.1 ESP32-C6 hello_world layout, scaled down: the NOBITS
// reservation starts with the code and covers it, and rodata follows.
const code: Section = {
  name: ".flash.text",
  type: SHT_PROGBITS,
  flags: EXEC_ALLOC,
  address: 0x42000020,
  size: 0x40,
};
const reservation: Section = {
  name: ".flash_rodata_dummy",
  type: SHT_NOBITS,
  flags: WRITE_ALLOC,
  address: 0x42000020,
  size: 0x100,
};
const rodata: Section = {
  name: ".flash.rodata",
  type: SHT_PROGBITS,
  flags: ALLOC,
  address: 0x42000120,
  size: 0x10,
};
const iram: Section = {
  name: ".iram0.text",
  type: SHT_PROGBITS,
  flags: EXEC_ALLOC,
  address: 0x40800000,
  size: 0x20,
};

describe("ELF section overlaps at target resolution", () => {
  it("records ESP-IDF's code reservation and plans the memory-map preparation", async () => {
    const { overlap, refusal, preparation } = await resolve(
      elf([iram, code, reservation, rodata]),
    );
    expect(overlap).toEqual({
      status: "code-reservation",
      code: {
        index: 2,
        name: ".flash.text",
        address: "0x42000020",
        size: "0x40",
        offset: "0x2020",
      },
      reservation: {
        index: 3,
        name: ".flash_rodata_dummy",
        address: "0x42000020",
        size: "0x100",
      },
    });
    expect(refusal).toBeNull();
    expect(preparation).toEqual({
      policy: "nobits-reservation-overlay-v1",
      code: overlap?.status === "code-reservation" ? overlap.code : undefined,
      reservation:
        overlap?.status === "code-reservation"
          ? overlap.reservation
          : undefined,
    });
  });

  it("keeps the reservation without names when the image has no name table", async () => {
    const { overlap } = await resolve(
      elf([code, reservation], { names: false }),
    );
    expect(overlap).toMatchObject({
      status: "code-reservation",
      code: { index: 1, name: null },
      reservation: { index: 2, name: null },
    });
  });

  it.each([
    ["separate code and data", [iram, code, rodata]],
    [
      "overlapping data sections",
      [
        code,
        rodata,
        { ...rodata, name: ".flash.tdata", type: SHT_NOBITS, size: 0x8 },
      ],
    ],
  ] as const)("admits %s without a preparation", async (_label, sections) => {
    const { overlap, refusal, preparation } = await resolve(elf(sections));
    expect(overlap).toEqual({ status: "none" });
    expect(refusal).toBeNull();
    expect(preparation).toBeUndefined();
  });

  it.each([
    [
      "a reservation smaller than the code",
      [code, { ...reservation, size: 0x20 }],
      "[1] .flash.text (0x42000020..0x42000060) and [2] .flash_rodata_dummy (0x42000020..0x42000040)",
    ],
    [
      "a reservation that starts inside the code",
      [code, { ...reservation, address: 0x42000030 }],
      ".flash_rodata_dummy (0x42000030..0x42000130)",
    ],
    [
      "two overlapping code sections",
      [code, { ...code, name: ".flash.text2", address: 0x42000040 }],
      "[1] .flash.text (0x42000020..0x42000060) and [2] .flash.text2",
    ],
    [
      "an executable reservation",
      [code, { ...reservation, flags: EXEC_ALLOC }],
      "and [2] .flash_rodata_dummy",
    ],
    [
      "a reservation that also covers rodata",
      [code, reservation, { ...rodata, address: 0x42000100 }],
      "[1] .flash.text",
    ],
    [
      "code that also overlaps rodata",
      [code, reservation, { ...rodata, address: 0x42000040 }],
      "among 2 overlaps that involve executable code",
    ],
  ] as const)("refuses %s", async (_label, sections, named) => {
    const { overlap, refusal, preparation } = await resolve(elf(sections));
    expect(overlap?.status).toBe("unsupported");
    expect(refusal).toContain(named);
    expect(refusal).toContain("REA prepares only a NOBITS section");
    expect(refusal).toContain("docs/ghidra-riscv.md");
    expect(preparation).toBeUndefined();
  });

  it("leaves relocatable images uninspected, since their addresses are not load addresses", async () => {
    const { overlap, refusal } = await resolve(
      elf([code, reservation], { type: 1 }),
    );
    expect(overlap).toBeUndefined();
    expect(refusal).toContain("fixed-address ET_EXEC only");
  });
});
