import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  hasArmAttributes,
  removeArmAttributes,
} from "../../../scripts/lib/arm-objcopy.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** A minimal ELF32 section table with one SHT_ARM_ATTRIBUTES section. */
const armAttributesElf = (sectionType = 0x70000003): Buffer => {
  const bytes = Buffer.alloc(64 + 2 * 40);
  bytes.write("\u007fELF", 0, "ascii");
  bytes[4] = 1; // ELF32
  bytes[5] = 1; // little-endian
  bytes.writeUInt16LE(40, 46); // e_shentsize
  bytes.writeUInt16LE(2, 48); // e_shnum
  bytes.writeUInt32LE(64, 32); // e_shoff
  // Section 0 stays SHT_NULL; section 1 carries the declared type.
  bytes.writeUInt32LE(sectionType, 64 + 40 + 4);
  return bytes;
};

const createFile = async (name: string, sectionType?: number) => {
  const directory = await createTestTempDirectory("rea-arm-objcopy-");
  const path = join(directory, name);
  await writeFile(path, armAttributesElf(sectionType));
  return path;
};

describe("ARM verifier objcopy prerequisite", () => {
  it("selects the first candidate whose strip removes the section", async () => {
    const attempts: string[] = [];
    const path = await createFile("capable.elf");
    const selected = await removeArmAttributes(
      ["missing-objcopy", "silent-objcopy", "working-objcopy"],
      async (command, args) => {
        attempts.push(command);
        if (command === "missing-objcopy") throw new Error("not found");
        if (command === "silent-objcopy") return undefined;
        // A working strip neutralizes the section header in place.
        const bytes = armAttributesElf();
        bytes.writeUInt32LE(0, 64 + 40 + 4);
        await writeFile(args.at(-1) ?? "", bytes);
      },
      path,
    );

    // A tool that answers but leaves the section in place is not selected.
    expect(selected.tool).toBe("working-objcopy");
    expect(attempts).toEqual([
      "missing-objcopy",
      "silent-objcopy",
      "working-objcopy",
    ]);
    expect(selected.failures).toEqual([
      "missing-objcopy: not found",
      "silent-objcopy: section still present",
    ]);
    await expect(hasArmAttributes(path)).resolves.toBe(false);
  });

  it("falls back to the built-in neutralizer when no candidate can", async () => {
    const path = await createFile("fallback.elf");
    const result = await removeArmAttributes(
      ["missing-objcopy"],
      async () => {
        throw new Error("not found");
      },
      path,
    );

    expect(result.tool).toBe("builtin-elf-neutralizer");
    expect(result.failures).toEqual(["missing-objcopy: not found"]);
    await expect(hasArmAttributes(path)).resolves.toBe(false);
  });

  it("surfaces a caller-selected objcopy failure instead of falling back", async () => {
    const path = await createFile("selected.elf");
    await expect(
      removeArmAttributes(
        ["selected-objcopy"],
        async () => {
          throw new Error("cannot read ARM input");
        },
        path,
        { fallback: false },
      ),
    ).rejects.toThrow("selected-objcopy: cannot read ARM input");
    await expect(hasArmAttributes(path)).resolves.toBe(true);
  });

  it("reads a big-endian ELF64 section table in the file's byte order", async () => {
    const bytes = Buffer.alloc(64 + 2 * 64);
    bytes.write("\u007fELF", 0, "ascii");
    bytes[4] = 2; // ELF64
    bytes[5] = 2; // big-endian
    bytes.writeBigUInt64BE(64n, 40); // e_shoff
    bytes.writeUInt16BE(64, 58); // e_shentsize
    bytes.writeUInt16BE(2, 60); // e_shnum
    bytes.writeUInt32BE(0x70000003, 64 + 64 + 4);
    const directory = await createTestTempDirectory("rea-arm-objcopy-");
    const path = join(directory, "elf64be.elf");
    await writeFile(path, bytes);
    await expect(hasArmAttributes(path)).resolves.toBe(true);
  });

  it("reports when the variant has no attributes section to remove", async () => {
    const path = await createFile("plain.elf", 1);
    await expect(
      removeArmAttributes(
        ["missing-objcopy"],
        async () => {
          throw new Error("not found");
        },
        path,
      ),
    ).rejects.toThrow("has no SHT_ARM_ATTRIBUTES section to remove");
  });
});
