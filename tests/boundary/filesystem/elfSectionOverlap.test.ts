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

// ELF header and section header field offsets of each class.
const LAYOUTS = {
  32: {
    shoff: 32,
    flags: 36,
    ehsize: 52,
    shentsize: 40,
    counts: 40,
    sh: { flags: 8, address: 12, offset: 16, size: 20 },
  },
  64: {
    shoff: 40,
    flags: 48,
    ehsize: 64,
    shentsize: 64,
    counts: 52,
    sh: { flags: 8, address: 16, offset: 24, size: 32 },
  },
} as const;

/**
 * A RISC-V image with these sections, its attributes and, unless `names` is
 * false, a section-name table. ELF32 images declare the soft-float ABI and
 * ELF64 images the double-float ABI, so each reaches an admitted lane.
 */
const elf = (
  sections: readonly Section[],
  options: {
    readonly type?: number;
    readonly names?: boolean;
    readonly elfClass?: 32 | 64;
  } = {},
): Buffer => {
  const elfClass = options.elfClass ?? 32;
  const layout = LAYOUTS[elfClass];
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
  const payloads = Math.max(
    PAYLOADS,
    SECTION_TABLE + (1 + all.length) * layout.shentsize,
  );
  const bytes = Buffer.alloc(
    payloads + filed.reduce((total, payload) => total + payload.length, 0),
  );
  const word = (value: number, at: number): void => {
    if (elfClass === 64) bytes.writeBigUInt64LE(BigInt(value), at);
    else bytes.writeUInt32LE(value, at);
  };
  bytes.set([0x7f, 0x45, 0x4c, 0x46, elfClass === 64 ? 2 : 1, 1, 1]);
  bytes.writeUInt16LE(options.type ?? 2, 16);
  bytes.writeUInt16LE(243, 18); // EM_RISCV
  bytes.writeUInt32LE(1, 20);
  word(SECTION_TABLE, layout.shoff);
  // RVC with the soft-float ABI, or with the double-float ABI.
  bytes.writeUInt32LE(elfClass === 64 ? 0x5 : 0x1, layout.flags);
  bytes.writeUInt16LE(layout.ehsize, layout.counts);
  bytes.writeUInt16LE(layout.shentsize, layout.counts + 6);
  bytes.writeUInt16LE(1 + all.length, layout.counts + 8);
  bytes.writeUInt16LE(
    options.names === false ? 0 : all.length,
    layout.counts + 10,
  );
  let offset = payloads;
  let nameOffset = 1;
  all.forEach((section, index) => {
    const header = SECTION_TABLE + (1 + index) * layout.shentsize;
    const payload = filed[index] ?? Buffer.alloc(0);
    bytes.writeUInt32LE(nameOffset, header);
    nameOffset += section.name.length + 1;
    bytes.writeUInt32LE(section.type, header + 4);
    word(section.flags, header + layout.sh.flags);
    word(section.address, header + layout.sh.address);
    word(offset, header + layout.sh.offset);
    word(
      section.type === SHT_NOBITS ? section.size : payload.length,
      header + layout.sh.size,
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

  it("leaves relocatable images uninspected, since their addresses are not load addresses", async () => {
    const { overlap, refusal } = await resolve(
      elf([code, reservation], { type: 1 }),
    );
    expect(overlap).toBeUndefined();
    expect(refusal).toContain("fixed-address ET_EXEC only");
  });
});

describe("ELF section overlap refusals", () => {
  const CODE = "`.flash.text` (executable, 0x42000020, 0x40 bytes)";
  it.each([
    [
      "a reservation smaller than the code",
      [code, { ...reservation, size: 0x20 }],
      `${CODE} and \`.flash_rodata_dummy\` (NOBITS, 0x42000020, 0x20 bytes)`,
    ],
    [
      "a reservation that starts inside the code",
      [code, { ...reservation, address: 0x42000030 }],
      `${CODE} and \`.flash_rodata_dummy\` (NOBITS, 0x42000030, 0x100 bytes)`,
    ],
    [
      "two overlapping code sections",
      [code, { ...code, name: ".flash.text2", address: 0x42000040 }],
      `\`.flash.text2\` (executable, 0x42000040, 0x40 bytes) and ${CODE}`,
    ],
    [
      "an executable reservation",
      [code, { ...reservation, flags: EXEC_ALLOC }],
      `\`.flash_rodata_dummy\` (executable, NOBITS, 0x42000020, 0x100 bytes) and ${CODE}`,
    ],
    // The pair of the verified shape is not the cause: the third section is.
    [
      "a reservation that also covers rodata",
      [code, reservation, { ...rodata, address: 0x42000100 }],
      "`.flash_rodata_dummy` (NOBITS, 0x42000020, 0x100 bytes) and `.flash.rodata` (0x42000100, 0x10 bytes)",
    ],
    [
      "code that also overlaps rodata",
      [code, reservation, { ...rodata, address: 0x42000040 }],
      `${CODE} and \`.flash.rodata\` (0x42000040, 0x10 bytes)`,
    ],
    [
      "a second code reservation",
      [
        code,
        reservation,
        { ...iram, address: 0x42000400 },
        { ...reservation, name: ".iram_dummy", address: 0x42000400 },
      ],
      "`.iram0.text` (executable, 0x42000400, 0x20 bytes) and `.iram_dummy` (NOBITS, 0x42000400, 0x100 bytes)",
    ],
  ] as const)(
    "refuses %s and names its cause",
    async (_label, sections, named) => {
      const { overlap, refusal, preparation } = await resolve(elf(sections));
      expect(overlap?.status).toBe("unsupported");
      expect(refusal).toContain(`Sections ${named} share addresses`);
      expect(refusal).toContain(
        "This lane prepares only one NOBITS section that starts at an executable PROGBITS section's address and covers it",
      );
      expect(refusal).toContain("docs/ghidra-riscv.md");
      expect(preparation).toBeUndefined();
    },
  );
});

describe("ELF section tables at the reader's bounds", () => {
  it("stops at the second overlap in a table of 10,000 executable sections at one address", async () => {
    const sections = Array.from({ length: 10_000 }, () => ({
      ...code,
      size: 4,
    }));
    const { overlap, refusal } = await resolve(elf(sections, { names: false }));
    expect(overlap).toEqual({
      status: "unsupported",
      witnesses: [
        {
          index: 2,
          name: null,
          address: "0x42000020",
          size: "0x4",
          nobits: false,
          executable: true,
        },
        {
          index: 1,
          name: null,
          address: "0x42000020",
          size: "0x4",
          nobits: false,
          executable: true,
        },
      ],
    });
    expect(refusal).toContain(
      "Sections section [2] (executable, 0x42000020, 0x4 bytes) and section [1]",
    );
  });

  it("reads ELF64 section tables, with addresses beyond 32 bits", async () => {
    const high = 0x1_4200_0020;
    const { overlap, refusal, preparation } = await resolve(
      elf(
        [
          { ...code, address: high },
          { ...reservation, address: high },
        ],
        { elfClass: 64 },
      ),
    );
    expect(overlap).toEqual({
      status: "code-reservation",
      code: {
        index: 1,
        name: ".flash.text",
        address: "0x142000020",
        size: "0x40",
        offset: "0x2000",
      },
      reservation: {
        index: 2,
        name: ".flash_rodata_dummy",
        address: "0x142000020",
        size: "0x100",
      },
    });
    expect(refusal).toBeNull();
    expect(preparation?.code.address).toBe("0x142000020");
  });

  // Double-float lanes read no ISA declaration; the resolver still refuses a
  // table it cannot read before any lane sees the image.
  it("rejects a truncated section table of a double-float image", async () => {
    const directory = await createTestTempDirectory("rea-elf-overlap-test-");
    const path = join(directory, "truncated.elf");
    await writeFile(
      path,
      elf([code, reservation], { elfClass: 64 }).subarray(
        0,
        SECTION_TABLE + 64 * 2,
      ),
    );
    const resolved = await parseBinaryTarget(path);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok)
      expect(resolved.error.message).toContain(
        "truncated ELF section header table",
      );
  });
});
