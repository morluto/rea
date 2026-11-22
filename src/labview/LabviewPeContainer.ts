import { BinaryReader } from "../domain/binaryContainer.js";

const RSRC_MAGIC = "RSRC\r\n";

export interface EmbeddedRsrc {
  /** File offset of the embedded RSRC container. */
  readonly offset: number;
  readonly bytes: Buffer;
}

interface Section {
  readonly virtualAddress: number;
  readonly virtualBytes: number;
  readonly rawBytes: number;
  readonly rawOffset: number;
}

/**
 * Locate RSRC containers stored as PE resources, as a LabVIEW-built executable
 * does. This is a bounded static walk of the resource directory; it does not
 * interpret the resource types beyond the payload's own magic, and it never
 * executes or extracts anything.
 */
export const findEmbeddedRsrcContainers = (bytes: Buffer): EmbeddedRsrc[] => {
  const reader = new BinaryReader(bytes, true, "pe");
  try {
    if (
      bytes.length < 0x40 ||
      reader.range(0, 2, "DOS signature").toString("latin1") !== "MZ"
    )
      return [];
    const peOffset = reader.u32(0x3c);
    if (
      !Number.isSafeInteger(peOffset) ||
      peOffset + 24 > bytes.length ||
      reader.range(peOffset, 4, "PE signature").toString("latin1") !== "PE\0\0"
    )
      return [];
    const coff = peOffset + 4;
    const sectionCount = reader.u16(coff + 2);
    const optionalBytes = reader.u16(coff + 16);
    const optional = coff + 20;
    if (optional + optionalBytes > bytes.length) return [];
    const magic = reader.u16(optional);
    const directoryOffset =
      magic === 0x20b ? 112 : magic === 0x10b ? 96 : undefined;
    if (
      directoryOffset === undefined ||
      optional + directoryOffset + 24 > bytes.length
    )
      return [];
    const resourceRva = reader.u32(optional + directoryOffset + 16);
    const resourceBytes = reader.u32(optional + directoryOffset + 20);
    if (resourceRva === 0 || resourceBytes === 0) return [];

    const sections: Section[] = [];
    const sectionsAt = optional + optionalBytes;
    for (let index = 0; index < sectionCount; index += 1) {
      const at = sectionsAt + index * 40;
      if (at + 40 > bytes.length) return [];
      sections.push({
        virtualBytes: reader.u32(at + 8),
        virtualAddress: reader.u32(at + 12),
        rawBytes: reader.u32(at + 16),
        rawOffset: reader.u32(at + 20),
      });
    }

    const fileOffsetOf = (rva: number): number | undefined => {
      for (const section of sections) {
        const span = Math.max(section.virtualBytes, section.rawBytes);
        if (
          rva >= section.virtualAddress &&
          rva < section.virtualAddress + span
        ) {
          const offset = section.rawOffset + (rva - section.virtualAddress);
          return offset < bytes.length ? offset : undefined;
        }
      }
      return undefined;
    };

    const found: EmbeddedRsrc[] = [];
    // Resource directory entry offsets are relative to the resource directory,
    // so every target is resolved against the resource RVA, never the file
    // start.
    const visit = (relativeOffset: number, depth: number): void => {
      if (depth > 3 || found.length >= 64) return;
      const directory = fileOffsetOf(resourceRva + relativeOffset);
      if (directory === undefined || directory + 16 > bytes.length) return;
      const entries = reader.u16(directory + 12) + reader.u16(directory + 14);
      if (entries > 4096 || directory + 16 + entries * 8 > bytes.length) return;
      for (let index = 0; index < entries; index += 1) {
        const entry = directory + 16 + index * 8;
        const target = reader.u32(entry + 4);
        if ((target & 0x80000000) !== 0) {
          visit(target & 0x7fffffff, depth + 1);
          continue;
        }
        const dataEntry = fileOffsetOf(resourceRva + target);
        if (dataEntry === undefined || dataEntry + 8 > bytes.length) continue;
        const dataRva = reader.u32(dataEntry);
        const dataBytes = reader.u32(dataEntry + 4);
        const dataOffset = fileOffsetOf(dataRva);
        if (
          dataOffset === undefined ||
          dataBytes < 6 ||
          dataOffset + dataBytes > bytes.length
        )
          continue;
        if (
          reader.range(dataOffset, 6, "resource payload").toString("latin1") ===
          RSRC_MAGIC
        )
          found.push({
            offset: dataOffset,
            bytes: bytes.subarray(dataOffset, dataOffset + dataBytes),
          });
      }
    };
    visit(0, 0);
    return found;
  } catch {
    return [];
  }
};
