import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { readXtensaElfAbi } from "../../../src/application/XtensaElfMetadata.js";
import type { XtensaAbiDeclaration } from "../../../src/domain/binaryTargetTypes.js";
import { ghidraXtensaUnsupportedReason } from "../../../src/ghidra/GhidraXtensaProfile.js";
import {
  elfNote,
  elfNoteFixture,
} from "../../../src/native/elf/ElfNotes.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// elfNoteFixture's ELF32 section-only layout: null, note and name-table headers
// follow the 52-byte header.
const NOTE_SECTION = 52 + 40;
const NAMES_SECTION = 52 + 2 * 40;

/** The descriptor GNU as and ld write, padded with NULs to a 4-byte word. */
const descriptor = (abi: string): Buffer => {
  const text = Buffer.from(`USE_ABSOLUTE_LITERALS=0\nABI=${abi}\n\0`, "latin1");
  return Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4)]);
};

const xtensaElf = (
  options: {
    readonly abi?: string;
    readonly little?: boolean;
    readonly ownership?: "section" | "program";
    readonly sectionName?: string;
    readonly notes?: Buffer;
  } = {},
): Buffer => {
  const little = options.little ?? true;
  const bytes = elfNoteFixture({
    bits: 32,
    little,
    machine: 94,
    type: 2,
    alignment: 1,
    ownership: options.ownership ?? "section",
    sectionName: options.sectionName ?? ".xtensa.info",
    notes:
      options.notes ??
      elfNote("Xtensa_Info", 1, descriptor(options.abi ?? "0"), little),
  });
  // EF_XTENSA_XT_INSN | EF_XTENSA_XT_LIT, as ESP-IDF links declare.
  if (little) bytes.writeUInt32LE(0x300, 36);
  else bytes.writeUInt32BE(0x300, 36);
  return bytes;
};

const writeFixture = async (bytes: Buffer): Promise<string> => {
  const directory = await createTestTempDirectory("rea-xtensa-abi-test-");
  const path = join(directory, "firmware.elf");
  await writeFile(path, bytes);
  return path;
};

const resolveFixture = async (bytes: Buffer) => {
  const path = await writeFixture(bytes);
  const result = await parseBinaryTarget(path);
  if (!result.ok) throw result.error;
  if (
    result.value.kind !== "executable" ||
    result.value.architecture !== "xtensa"
  )
    throw new Error("Expected a resolved Xtensa executable");
  expect((await readFile(path)).equals(bytes)).toBe(true);
  return result.value;
};

const resolvedAbi = async (bytes: Buffer): Promise<XtensaAbiDeclaration> => {
  const abi = (await resolveFixture(bytes)).xtensa.abi;
  if (abi === undefined) throw new Error("Expected an inspected ABI");
  return abi;
};

describe("Xtensa ELF target resolution", () => {
  it("records the windowed declaration and admits the Ghidra lane", async () => {
    const target = await resolveFixture(xtensaElf());
    expect(target).toMatchObject({
      format: "elf",
      availableArchitectures: ["xtensa"],
      xtensa: {
        elfClass: 32,
        byteOrder: "little",
        type: 2,
        flags: 0x300,
        abi: { status: "declared", abi: "windowed" },
      },
    });
    expect(ghidraXtensaUnsupportedReason(target)).toBeNull();
  });

  it("records call0 and keeps the Ghidra refusal specific", async () => {
    const target = await resolveFixture(xtensaElf({ abi: "1" }));
    expect(target.xtensa.abi).toEqual({ status: "declared", abi: "call0" });
    expect(ghidraXtensaUnsupportedReason(target)).toContain("call0 ABI");
  });

  it("reads big-endian note words without admitting big-endian images", async () => {
    const target = await resolveFixture(xtensaElf({ little: false }));
    expect(target.xtensa).toMatchObject({
      byteOrder: "big",
      abi: { status: "declared", abi: "windowed" },
    });
    expect(ghidraXtensaUnsupportedReason(target)).toContain("little-endian");
  });

  it("keeps an undefined ABI value as written", async () => {
    expect(await resolvedAbi(xtensaElf({ abi: "7" }))).toEqual({
      status: "unrecognized",
      value: "7",
    });
  });

  it("reports an examined image without .xtensa.info as absent", async () => {
    expect(
      await resolvedAbi(
        xtensaElf({
          sectionName: ".note.gnu.build-id",
          notes: elfNote("GNU", 3, Buffer.alloc(20)),
        }),
      ),
    ).toEqual({ status: "absent" });
  });

  it.each([
    [
      "no section header table",
      xtensaElf({ ownership: "program" }),
      "no section header table",
    ],
    [
      "a non-note .xtensa.info",
      (() => {
        const bytes = xtensaElf();
        bytes.writeUInt32LE(1, NOTE_SECTION + 4);
        return bytes;
      })(),
      "not an SHT_NOTE section",
    ],
    [
      "an unreadable section name",
      (() => {
        const bytes = xtensaElf();
        bytes.writeUInt32LE(
          bytes.readUInt32LE(NAMES_SECTION + 20),
          NOTE_SECTION,
        );
        return bytes;
      })(),
      "name offset is outside its string table",
    ],
    [
      "a visible .xtensa.info beside another unreadable section name",
      (() => {
        // The name table's own name is unreadable; it could be a second
        // .xtensa.info, so the visible one is not known to be unique.
        const bytes = xtensaElf();
        bytes.writeUInt32LE(
          bytes.readUInt32LE(NAMES_SECTION + 20),
          NAMES_SECTION,
        );
        return bytes;
      })(),
      "name offset is outside its string table",
    ],
    [
      "a section-name table that is not a string table",
      (() => {
        const bytes = xtensaElf();
        bytes.writeUInt32LE(1, NAMES_SECTION + 4);
        return bytes;
      })(),
      "not a string table",
    ],
  ])("leaves the ABI unknown for %s", async (_label, bytes, reason) => {
    const target = await resolveFixture(bytes);
    expect(target.xtensa.abi).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining(reason),
    });
    // Only REA's own fixed bound attaches limit facts.
    expect(target.xtensa.abi).not.toHaveProperty("limit");
    expect(ghidraXtensaUnsupportedReason(target)).toContain(
      "does not infer the windowed ABI",
    );
  });

  it("reports the fixed .xtensa.info bound as structured limit facts", async () => {
    // A 12-byte note header, the 12-byte owner and a 5000-byte descriptor.
    const target = await resolveFixture(
      xtensaElf({ notes: elfNote("Xtensa_Info", 1, Buffer.alloc(5000)) }),
    );
    expect(target.xtensa.abi).toMatchObject({
      status: "unavailable",
      limit: {
        boundary: "xtensa_info",
        maximum_bytes: 4096,
        declared_bytes: 5024,
        runtime_override: false,
      },
    });
    expect(ghidraXtensaUnsupportedReason(target)).toContain(
      "does not infer the windowed ABI",
    );
  });

  it("propagates the caller's cancellation instead of reporting an unknown ABI", async () => {
    const bytes = xtensaElf();
    const handle = await open(await writeFixture(bytes), "r");
    const cancelled = new Error("cancelled during .xtensa.info inspection");
    let checks = 0;
    try {
      await expect(
        readXtensaElfAbi(handle, bytes.length, () => {
          checks += 1;
          if (checks > 3) throw cancelled;
        }),
      ).rejects.toBe(cancelled);
    } finally {
      await handle.close();
    }
  });
});
