import {
  PE_RESOURCE_TYPE_RCDATA,
  PE_RESOURCE_DATA_ENTRY_BYTES,
  PE_RESOURCE_DIRECTORY_BYTES,
  PE_RESOURCE_ENTRY_BYTES,
  peResourceRangeFits,
  readPeResourceDataEntryFacts,
  readPeResourceDirectoryFacts,
  readPeResourceEntryFacts,
} from "../domain/pe/peResourceTreeFacts.js";
import { readPeResourceLayout } from "../domain/pe/peResourceLayout.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import { observeMzWindowsHeader } from "../domain/dosMz.js";
import { LABVIEW_RSRC_MAGIC } from "../domain/labview/labviewArtifact.js";
import { decodeLimit, ParseFailureError } from "../domain/parseFailure.js";

const FORMAT = "pe-rsrc";
/** Directory visits one scan may spend; a repeated offset adds no visit. */
const MAX_DIRECTORY_VISITS = 1024;
/** Entry records one directory may declare. */
const MAX_ENTRIES_PER_DIRECTORY = 4096;
/** Entry records one scan may examine across every directory it reaches. */
const MAX_RESOURCE_ENTRIES = 4096;
const MAX_CONTAINERS = 64;

export interface EmbeddedRsrc {
  /** File offset of the embedded RSRC container. */
  readonly offset: number;
  readonly bytes: Buffer;
}

export type EmbeddedRsrcScan =
  | {
      readonly ok: true;
      readonly containers: readonly EmbeddedRsrc[];
      /** Whether every resource branch this walk reached was examined. */
      readonly complete: boolean;
    }
  | { readonly ok: false; readonly failure: ParseFailureError<"limit"> };

/**
 * Locate RSRC containers stored as PE resources, as a LabVIEW-built executable
 * does. The shared PE owner admits the image and maps every RVA, so section
 * lookup is indexed and a payload may live in any admitted section. This walk
 * only reads directory records, under visit and entry budgets, and never
 * executes or extracts anything.
 */
export const findEmbeddedRsrcContainers = (bytes: Buffer): EmbeddedRsrcScan => {
  // The shared MZ owner decides PE identity: only a "PE\0\0" signature at
  // e_lfanew declares a PE. A plain DOS MZ, NE, LE or LX image is simply not
  // a PE, while a declared PE that cannot be admitted has an unreadable tree.
  const windowsHeader = observeMzWindowsHeader(bytes);
  const declaresPe =
    windowsHeader.state === "declared" && windowsHeader.signature === "PE";
  let layout: ReturnType<typeof readPeResourceLayout>;
  try {
    layout = readPeResourceLayout(bytes);
  } catch (cause) {
    if (cause instanceof ParseFailureError)
      return { ok: true, containers: [], complete: !declaresPe };
    throw cause;
  }
  // No resource directory is observed absence. A declared root whose
  // file-backed run cannot hold one directory header was never read.
  if (layout.rva === 0) return { ok: true, containers: [], complete: true };
  if (layout.size < PE_RESOURCE_DIRECTORY_BYTES)
    return { ok: true, containers: [], complete: false };

  const reader = new BinaryReader(bytes, true, "pe");
  const root = layout.rva;
  const found: EmbeddedRsrc[] = [];
  const visited = new Set<number>();
  /** Payload ranges already recorded; language aliases can share one. */
  const seenPayloads = new Set<string>();
  let visits = 0;
  let examinedEntries = 0;
  let complete = true;

  /** File offset of directory metadata, which must stay inside the resource span. */
  const metadataOffset = (
    relative: number,
    length: number,
  ): number | undefined => {
    if (!Number.isSafeInteger(relative) || relative < 0) return undefined;
    if (!peResourceRangeFits(relative, length, layout.size)) return undefined;
    try {
      return layout.map(root + relative, length);
    } catch {
      return undefined;
    }
  };

  /** File offset of one payload; its RVA may map through any admitted section. */
  const payloadOffset = (rva: number, length: number): number | undefined => {
    try {
      return layout.map(rva, length);
    } catch {
      return undefined;
    }
  };

  const visit = (relativeOffset: number, depth: number): void => {
    if (depth > 3) {
      complete = false;
      return;
    }
    // A repeated offset is a cycle or a shared directory: its subtree was
    // already examined, so it adds neither work nor a visit.
    if (visited.has(relativeOffset)) return;
    visited.add(relativeOffset);
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
    const directory = metadataOffset(
      relativeOffset,
      PE_RESOURCE_DIRECTORY_BYTES,
    );
    if (directory === undefined) {
      complete = false;
      return;
    }
    const { entryCount } = readPeResourceDirectoryFacts(
      reader.range(
        directory,
        PE_RESOURCE_DIRECTORY_BYTES,
        "resource directory",
      ),
    );
    // Rows that do not fit are an unreadable tree, not a capacity question:
    // frame them before either entry allowance.
    const rows = metadataOffset(
      relativeOffset + PE_RESOURCE_DIRECTORY_BYTES,
      entryCount * PE_RESOURCE_ENTRY_BYTES,
    );
    if (rows === undefined) {
      complete = false;
      return;
    }
    if (entryCount > MAX_ENTRIES_PER_DIRECTORY)
      throw decodeLimit(
        FORMAT,
        "A PE resource directory exceeds its entry allowance",
        {
          name: "pe_resource_directory_entries",
          maximum: MAX_ENTRIES_PER_DIRECTORY,
          required: entryCount,
        },
      );
    examinedEntries += entryCount;
    if (examinedEntries > MAX_RESOURCE_ENTRIES)
      throw decodeLimit(
        FORMAT,
        "The PE resource walk exceeded its total entry allowance",
        {
          name: "pe_resource_entries",
          maximum: MAX_RESOURCE_ENTRIES,
          required: examinedEntries,
        },
      );
    for (let index = 0; index < entryCount; index += 1) {
      const at = rows + index * PE_RESOURCE_ENTRY_BYTES;
      const { identity, target } = readPeResourceEntryFacts(
        reader.range(at, PE_RESOURCE_ENTRY_BYTES, "resource entry"),
      );
      // Depth 0 holds the resource types. LabVIEW stores its container under
      // RT_RCDATA, so every other type is skipped before its target is read,
      // whether that target is a subdirectory or a noncanonical leaf.
      if (
        depth === 0 &&
        (identity.kind !== "id" || identity.id !== PE_RESOURCE_TYPE_RCDATA)
      )
        continue;
      if (target.kind === "directory") {
        visit(target.offset, depth + 1);
        continue;
      }
      const dataEntry = metadataOffset(
        target.offset,
        PE_RESOURCE_DATA_ENTRY_BYTES,
      );
      if (dataEntry === undefined) {
        complete = false;
        continue;
      }
      const { rva, size } = readPeResourceDataEntryFacts(
        reader.range(
          dataEntry,
          PE_RESOURCE_DATA_ENTRY_BYTES,
          "resource data entry",
        ),
      );
      if (size < LABVIEW_RSRC_MAGIC.length) continue;
      const dataOffset = payloadOffset(rva, size);
      if (dataOffset === undefined) {
        complete = false;
        continue;
      }
      if (
        reader
          .range(dataOffset, LABVIEW_RSRC_MAGIC.length, "resource payload")
          .toString("latin1") !== LABVIEW_RSRC_MAGIC
      )
        continue;
      const payloadKey = `${String(dataOffset)}:${String(size)}`;
      if (seenPayloads.has(payloadKey)) continue;
      seenPayloads.add(payloadKey);
      found.push({
        offset: dataOffset,
        bytes: bytes.subarray(dataOffset, dataOffset + size),
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
  };

  try {
    visit(0, 0);
  } catch (cause) {
    if (
      cause instanceof ParseFailureError &&
      cause.failure.kind === "limit" &&
      cause.failure.format === FORMAT
    )
      return { ok: false, failure: cause as ParseFailureError<"limit"> };
    throw cause;
  }
  return { ok: true, containers: found, complete };
};
