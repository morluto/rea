import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  PeImports,
  InspectPeImportsInput,
} from "../../domain/native/peImports.js";

interface Section {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawOffset: number;
  rawSize: number;
}

interface PeHeader {
  format: "pe32" | "pe32-plus";
  imageBase: bigint;
  sections: Section[];
  importDirectoryRva: number;
  importDirectorySize: number;
}

const IMAGE_DIRECTORY_ENTRY_IMPORT = 1;
const IMAGE_ORDINAL_FLAG32 = 0x80000000;
const IMAGE_ORDINAL_FLAG64 = 0x8000000000000000n;

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function readU64(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

function rvaToOffset(sections: Section[], rva: number): number | null {
  for (const section of sections) {
    const sectionEnd =
      section.virtualAddress + Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < sectionEnd) {
      return section.rawOffset + (rva - section.virtualAddress);
    }
  }
  return null;
}

function isOrdinal32(value: number): boolean {
  return (value & IMAGE_ORDINAL_FLAG32) === IMAGE_ORDINAL_FLAG32;
}

function isOrdinal64(value: bigint): boolean {
  return (value & IMAGE_ORDINAL_FLAG64) === IMAGE_ORDINAL_FLAG64;
}

function getOrdinalValue32(value: number): number {
  return value & 0xffff;
}

function getOrdinalValue64(value: bigint): number {
  return Number(value & 0xffffffffffffffffn);
}

function readPeHeader(buffer: Buffer): PeHeader {
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );

  if (readU32(view, 0) !== 0x5a4d) {
    throw new Error("Not a valid PE file: missing MZ signature");
  }

  const peOffset = readU32(view, 0x3c);
  if (peOffset >= buffer.length - 4) {
    throw new Error("Invalid PE offset");
  }

  if (readU32(view, peOffset) !== 0x4550) {
    throw new Error("Not a valid PE file: missing PE signature");
  }

  const coffOffset = peOffset + 4;
  const numberOfSections = readU32(view, coffOffset + 4);
  const optionalHeaderOffset = coffOffset + 20;
  const optionalHeaderSize = readU32(view, optionalHeaderOffset + 2);

  const magic = readU32(view, optionalHeaderOffset + 4);
  const isPe32Plus = magic === 0x20b;

  const imageBase = isPe32Plus
    ? readU64(view, optionalHeaderOffset + 24)
    : BigInt(readU32(view, optionalHeaderOffset + 24));

  const importDirectoryRva = readU32(view, optionalHeaderOffset + 96);
  const importDirectorySize = readU32(view, optionalHeaderOffset + 100);

  const sections: Section[] = [];
  let sectionHeaderOffset = optionalHeaderOffset + 4 + optionalHeaderSize;

  for (let i = 0; i < numberOfSections; i++) {
    const nameBytes = buffer.subarray(
      sectionHeaderOffset,
      sectionHeaderOffset + 8,
    );
    const name = nameBytes.toString("ascii").replace(/\0.*$/, "");
    const virtualSize = readU32(view, sectionHeaderOffset + 8);
    const virtualAddress = readU32(view, sectionHeaderOffset + 12);
    const rawSize = readU32(view, sectionHeaderOffset + 16);
    const rawOffset = readU32(view, sectionHeaderOffset + 20);

    sections.push({
      name,
      virtualAddress,
      virtualSize,
      rawOffset,
      rawSize,
    });

    sectionHeaderOffset += 40;
  }

  return {
    format: isPe32Plus ? "pe32-plus" : "pe32",
    imageBase,
    sections,
    importDirectoryRva,
    importDirectorySize,
  };
}

function readImportDirectory(
  buffer: Buffer,
  header: PeHeader,
): { dlls: any[]; importDirectoryEnd: number } {
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const {
    importDirectoryRva,
    importDirectorySize,
    sections,
    format,
    imageBase,
  } = header;

  if (importDirectoryRva === 0 || importDirectorySize === 0) {
    return { dlls: [], importDirectoryEnd: 0 };
  }

  const importDirOffset = rvaToOffset(header.sections, importDirectoryRva);
  if (
    importDirOffset === null ||
    importDirOffset + importDirectorySize > buffer.length
  ) {
    throw new Error("Import directory outside file bounds");
  }

  const isPe32Plus = format === "pe32-plus";
  const thunkSize = isPe32Plus ? 8 : 4;

  const dlls = [];
  let descriptorOffset = importDirOffset;

  while (descriptorOffset + 20 <= buffer.length) {
    const originalFirstThunk = readU32(view, descriptorOffset);
    const timeDateStamp = readU32(view, descriptorOffset + 4);
    const forwarderChain = readU32(view, descriptorOffset + 8);
    const nameRva = readU32(view, descriptorOffset + 12);
    const firstThunk = readU32(view, descriptorOffset + 16);

    if (
      originalFirstThunk === 0 &&
      timeDateStamp === 0 &&
      forwarderChain === 0 &&
      nameRva === 0 &&
      firstThunk === 0
    ) {
      break;
    }

    const nameOffset = nameRva ? rvaToOffset(header.sections, nameRva) : null;
    const dllName =
      nameOffset !== null && nameOffset < buffer.length
        ? readNullTerminatedString(buffer, nameOffset)
        : "";

    const intOffset = originalFirstThunk
      ? rvaToOffset(header.sections, originalFirstThunk)
      : null;
    const iatOffset = firstThunk
      ? rvaToOffset(header.sections, firstThunk)
      : null;

    const entries = [];
    let thunkIndex = 0;

    if (intOffset !== null && iatOffset !== null) {
      if (isPe32Plus) {
        while (true) {
          const intRva = readU64(view, intOffset + thunkIndex * 8);
          if (intRva === 0n) break;

          const isOrdinal =
            (intRva & 0x8000000000000000n) === 0x8000000000000000n;

          let ordinal: number | null = null;
          let hint: number | null = null;
          let name: string | null = null;
          let nameRva: string | null = null;
          let nameOffset: string | null = null;

          if ((intRva & 0x8000000000000000n) === 0x8000000000000000n) {
            ordinal = Number(intRva & 0xffffffffffffffffn);
          } else {
            const nameRvaValue = intRva + 2n;
            const nameOffsetValue = rvaToOffset(
              header.sections,
              Number(nameRvaValue),
            );
            if (
              nameOffsetValue !== null &&
              nameOffsetValue + 2 < buffer.length
            ) {
              hint = readU32(view, nameOffsetValue);
              name = readNullTerminatedString(buffer, nameOffsetValue + 2);
              nameRva = "0x" + nameRvaValue.toString(16);
              nameOffset = "0x" + nameOffsetValue.toString(16);
            }
          }

          const iatSlotRva = firstThunk + thunkIndex * 8;
          const iatSlotOffset = rvaToOffset(header.sections, iatSlotRva) ?? -1;
          const iatSlotVa = imageBase + BigInt(iatSlotRva);

          entries.push({
            ordinal,
            hint,
            name,
            name_rva: nameRva,
            name_offset: nameOffset,
            iat_slot_rva: "0x" + iatSlotRva.toString(16),
            iat_slot_offset: "0x" + iatSlotOffset.toString(16),
            iat_slot_va: "0x" + iatSlotVa.toString(16),
            is_bound: false,
            bound_forwarder_rva: null,
          });

          thunkIndex++;
        }
      } else {
        while (true) {
          const intRva = readU32(view, intOffset + thunkIndex * 4);
          if (intRva === 0) break;

          const isOrdinal = (intRva & 0x80000000) === 0x80000000;

          let ordinal: number | null = null;
          let hint: number | null = null;
          let name: string | null = null;
          let nameRva: string | null = null;
          let nameOffset: string | null = null;

          if (isOrdinal) {
            ordinal = intRva & 0xffff;
          } else {
            const nameRvaValue = intRva + 2;
            const nameOffsetValue = rvaToOffset(header.sections, nameRvaValue);
            if (
              nameOffsetValue !== null &&
              nameOffsetValue + 2 < buffer.length
            ) {
              hint = readU32(view, nameOffsetValue);
              name = readNullTerminatedString(buffer, nameOffsetValue + 2);
              nameRva = "0x" + nameRvaValue.toString(16);
              nameOffset = "0x" + nameOffsetValue.toString(16);
            }
          }

          const iatSlotRva = firstThunk + thunkIndex * 4;
          const iatSlotOffset = rvaToOffset(header.sections, iatSlotRva) ?? -1;
          const iatSlotVa = BigInt(imageBase) + BigInt(iatSlotRva);

          entries.push({
            ordinal,
            hint,
            name,
            name_rva: nameRva,
            name_offset: nameOffset,
            iat_slot_rva: "0x" + iatSlotRva.toString(16),
            iat_slot_offset: "0x" + iatSlotOffset.toString(16),
            iat_slot_va:
              "0x" + (BigInt(imageBase) + BigInt(iatSlotRva)).toString(16),
            is_bound: false,
            bound_forwarder_rva: null,
          });

          thunkIndex++;
        }
      }
    }

    const dllNameRva = "0x" + nameRva.toString(16);

    dlls.push({
      dll_name: dllName,
      dll_name_rva: "0x" + nameRva.toString(16),
      dll_name_offset: "0x" + (nameOffset ?? -1).toString(16),
      original_first_thunk_rva: "0x" + originalFirstThunk.toString(16),
      first_thunk_rva: "0x" + firstThunk.toString(16),
      time_date_stamp: timeDateStamp,
      forwarder_chain: forwarderChain,
      entries,
    });

    descriptorOffset += 20;
  }

  return { dlls, importDirectoryEnd: descriptorOffset };
}

function readNullTerminatedString(buffer: Buffer, offset: number): string {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end++;
  return buffer.subarray(offset, end).toString("utf8");
}

export { type InspectPeImportsInput } from "../../domain/native/peImports.js";

export async function parsePeImports(
  input: InspectPeImportsInput,
): Promise<any> {
  const buffer = await readFile(input.path);
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  const header = readPeHeader(buffer);
  const { dlls } = readImportDirectory(buffer, header);

  const limitedDlls = dlls.slice(0, input.max_imports);

  const totalEntries = limitedDlls.reduce(
    (sum, dll) => sum + dll.entries.length,
    0,
  );

  return {
    artifact: {
      path: input.path,
      sha256,
      bytes: buffer.length,
    },
    format: header.format,
    image_base: "0x" + header.imageBase.toString(16),
    imports: limitedDlls,
    coverage: {
      status: "complete",
      examined_dlls: limitedDlls.length,
      examined_entries: totalEntries,
    },
    limitations: [],
  };
}
