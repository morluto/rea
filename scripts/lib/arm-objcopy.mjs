import { readFile, writeFile } from "node:fs/promises";

const SHT_ARM_ATTRIBUTES = 0x70000003;
const ELF_MAGIC = 0x7f454c46;

/**
 * Read the section header table of an ELF32/ELF64 image.
 * Returns null when the header or table cannot be read.
 */
const readSectionTable = async (path) => {
  const bytes = await readFile(path);
  if (bytes.length < 52 || bytes.readUInt32BE(0) !== ELF_MAGIC) return null;
  const elfClass = bytes[4];
  const little = bytes[5] === 1;
  const u16 = (offset) =>
    little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const u32 = (offset) =>
    little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  if (elfClass !== 1 && elfClass !== 2) return null;
  const tableOffset =
    elfClass === 1 ? u32(32) : Number(bytes.readBigUInt64LE(40));
  const stride = elfClass === 1 ? u16(46) : u16(58);
  const count = elfClass === 1 ? u16(48) : u16(60);
  if (tableOffset === 0 || stride === 0 || count === 0) return null;
  if (tableOffset + stride * count > bytes.length) return null;
  return { bytes, tableOffset, stride, count, u32 };
};

/** True when the image still carries an SHT_ARM_ATTRIBUTES section. */
export const hasArmAttributes = async (path) => {
  const table = await readSectionTable(path);
  if (table === null) return false;
  for (let index = 0; index < table.count; index += 1) {
    const header = table.tableOffset + index * table.stride;
    if (table.u32(header + 4) === SHT_ARM_ATTRIBUTES) return true;
  }
  return false;
};

/**
 * Mark every SHT_ARM_ATTRIBUTES section header as SHT_NULL in place, which is
 * what a reader that walks the section table observes as "no declaration".
 * This keeps the variant usable on hosts whose GNU objcopy cannot read ARM.
 */
export const neutralizeArmAttributes = async (path) => {
  const table = await readSectionTable(path);
  if (table === null)
    throw new Error(`Cannot parse the ELF section table of ${path}`);
  let found = false;
  for (let index = 0; index < table.count; index += 1) {
    const header = table.tableOffset + index * table.stride;
    if (table.u32(header + 4) !== SHT_ARM_ATTRIBUTES) continue;
    // SHT_NULL, with the name index cleared so the section is fully inert.
    table.bytes.fill(0, header, header + 8);
    found = true;
  }
  if (!found)
    throw new Error(`${path} has no SHT_ARM_ATTRIBUTES section to remove`);
  await writeFile(path, table.bytes);
};

/**
 * Remove .ARM.attributes from the variant copy, preferring a caller-selected
 * or standard objcopy that actually reads ARM input. Selection is proven by the
 * operation itself: a tool that answers --version but cannot parse ARM (GNU
 * objcopy on hosts built without the ARM target) falls through. When no
 * candidate can do it, the built-in ELF neutralizer keeps the lane runnable.
 * A caller-selected tool passes `fallback: false`: its failure is reported
 * instead of being replaced by another tool.
 */
export const removeArmAttributes = async (
  candidates,
  execute,
  path,
  { fallback = true } = {},
) => {
  const failures = [];
  for (const candidate of candidates) {
    try {
      await execute(candidate, ["--remove-section", ".ARM.attributes", path], {
        timeout: 30000,
      });
      if (await hasArmAttributes(path)) {
        failures.push(`${candidate}: section still present`);
        continue;
      }
      return { tool: candidate, failures };
    } catch (error) {
      failures.push(
        `${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!fallback)
    throw new Error(
      `The selected objcopy could not remove .ARM.attributes: ${failures.join("; ")}`,
    );
  await neutralizeArmAttributes(path);
  return { tool: "builtin-elf-neutralizer", failures };
};
