import { BinaryReader } from "../domain/binaryContainer.js";
import { decodeLimit, ParseFailureError } from "../domain/parseFailure.js";

const FORMAT = "pe-rsrc";
const RSRC_MAGIC = "RSRC\r\n";
/** Directory visits one scan may spend; cycles share offsets, not new visits. */
const MAX_DIRECTORY_VISITS = 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_CONTAINERS = 64;

export interface EmbeddedRsrc {
  /** File offset of the embedded RSRC container. */
  readonly offset: number;
  readonly bytes: Buffer;
}

export type EmbeddedRsrcScan =
  | { readonly ok: true; readonly containers: readonly EmbeddedRsrc[] }
  | { readonly ok: false; readonly failure: ParseFailureError<"limit"> };

interface Section {
  readonly virtualAddress: number;
  readonly virtualBytes: number;
  readonly rawBytes: number;
  readonly rawOffset: number;
}

/**
 * Locate RSRC containers stored as PE resources, as a LabVIEW-built executable
 * does. This is a bounded static walk of the resource directory: visited
 * directories, a total visit budget, directory and container allowances, and
 * every target checked against the declared resource range. It never executes
 * or extracts anything, and it fails rather than returning a partial scan.
 */
export const findEmbeddedRsrcContainers = (bytes: Buffer): EmbeddedRsrcScan => {
  const reader = new BinaryReader(bytes, true, "pe");
  try {
    if (
      bytes.length < 0x40 ||
      reader.range(0, 2, "DOS signature").toString("latin1") !== "MZ"
    )
      return { ok: true, containers: [] };
    const peOffset = reader.u32(0x3c);
    if (
      !Number.isSafeInteger(peOffset) ||
      peOffset + 24 > bytes.length ||
      reader.range(peOffset, 4, "PE signature").toString("latin1") !== "PE\0\0"
    )
      return { ok: true, containers: [] };
    const coff = peOffset + 4;
    const sectionCount = reader.u16(coff + 2);
    const optionalBytes = reader.u16(coff + 16);
    const optional = coff + 20;
    if (optional + optionalBytes > bytes.length)
      return { ok: true, containers: [] };
    const magic = reader.u16(optional);
    const directoryOffset =
      magic === 0x20b ? 112 : magic === 0x10b ? 96 : undefined;
    if (
      directoryOffset === undefined ||
      optional + directoryOffset + 24 > bytes.length
    )
      return { ok: true, containers: [] };
    const resourceRva = reader.u32(optional + directoryOffset + 16);
    const resourceBytes = reader.u32(optional + directoryOffset + 20);
    if (resourceRva === 0 || resourceBytes === 0)
      return { ok: true, containers: [] };
    const resourceEnd = resourceRva + resourceBytes;

    const sections: Section[] = [];
    const sectionsAt = optional + optionalBytes;
    for (let index = 0; index < sectionCount; index += 1) {
      const at = sectionsAt + index * 40;
      if (at + 40 > bytes.length) return { ok: true, containers: [] };
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

    /**
     * Resolve an RVA that must lie wholly inside the declared resource range.
     * The directory and its data entries are children of that range, so a
     * target outside it is not part of this resource.
     */
    const resourceOffsetOf = (
      rva: number,
      length: number,
    ): number | undefined => {
      if (!Number.isSafeInteger(rva) || rva < resourceRva) return undefined;
      if (length > resourceEnd - rva) return undefined;
      return fileOffsetOf(rva);
    };

    const found: EmbeddedRsrc[] = [];
    const visited = new Set<number>();
    let visits = 0;
    // Resource directory entry offsets are relative to the resource directory,
    // so every target is resolved against the resource RVA, never the file
    // start.
    const visit = (relativeOffset: number, depth: number): void => {
      if (depth > 3) return;
      visits += 1;
      if (visits > MAX_DIRECTORY_VISITS)
        throw decodeLimit(
          FORMAT,
          "The PE resource-directory walk exceeded its visit allowance",
          {
            name: "pe_resource_directory_visits",
            maximum: MAX_DIRECTORY_VISITS,
            required: visits,
          },
        );
      // A repeated offset is a cycle or a shared directory: its subtree was
      // already examined, so following it again adds nothing.
      if (visited.has(relativeOffset)) return;
      visited.add(relativeOffset);
      const directory = resourceOffsetOf(resourceRva + relativeOffset, 16);
      if (directory === undefined) return;
      const entries = reader.u16(directory + 12) + reader.u16(directory + 14);
      if (entries > MAX_DIRECTORY_ENTRIES)
        throw decodeLimit(
          FORMAT,
          "A PE resource directory exceeds its entry allowance",
          {
            name: "pe_resource_directory_entries",
            maximum: MAX_DIRECTORY_ENTRIES,
            required: entries,
          },
        );
      if (directory + 16 + entries * 8 > bytes.length) return;
      for (let index = 0; index < entries; index += 1) {
        const entry = directory + 16 + index * 8;
        const target = reader.u32(entry + 4);
        if ((target & 0x80000000) !== 0) {
          visit(target & 0x7fffffff, depth + 1);
          continue;
        }
        const dataEntry = resourceOffsetOf(resourceRva + target, 8);
        if (dataEntry === undefined) continue;
        const dataRva = reader.u32(dataEntry);
        const dataBytes = reader.u32(dataEntry + 4);
        if (dataBytes < 6) continue;
        const dataOffset = resourceOffsetOf(dataRva, dataBytes);
        if (dataOffset === undefined) continue;
        if (
          reader.range(dataOffset, 6, "resource payload").toString("latin1") ===
          RSRC_MAGIC
        ) {
          found.push({
            offset: dataOffset,
            bytes: bytes.subarray(dataOffset, dataOffset + dataBytes),
          });
          if (found.length > MAX_CONTAINERS)
            throw decodeLimit(
              FORMAT,
              "The file carries more embedded RSRC containers than the inspection allowance admits",
              {
                name: "pe_embedded_rsrc_containers",
                maximum: MAX_CONTAINERS,
                required: found.length,
              },
            );
        }
      }
    };
    visit(0, 0);
    return { ok: true, containers: found };
  } catch (cause) {
    if (
      cause instanceof ParseFailureError &&
      cause.failure.kind === "limit" &&
      cause.failure.format === FORMAT
    )
      return { ok: false, failure: cause as ParseFailureError<"limit"> };
    // A file whose PE structure cannot be read is not a LabVIEW PE; the
    // provider reports the absence of an embedded container.
    return { ok: true, containers: [] };
  }
};
