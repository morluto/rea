import { hasElfMagic } from "../domain/binaryContainer.js";
import {
  inspectQualcommMbnElf,
  inspectQualcommMbnImage,
  qualcommMbnElfTableSpan,
  qualcommMbnHashHeaderSpan,
  type QualcommMbnInspection,
} from "../domain/qualcommMbnImage.js";

/** A legacy v5/v6 header is 80 bytes; an ELF64 fixed header is 64. */
const PREFIX_BYTES = 80;

type ReadRange = (offset: number, length: number) => Promise<Buffer>;

/**
 * Inspect a file as Qualcomm MBN, reading only the spans the domain owner
 * asks for: the leading header, then for ELF the program header table and
 * the hash-segment header.
 */
export const readQualcommMbnInspection = async (
  read: ReadRange,
  fileSize: number,
): Promise<QualcommMbnInspection> => {
  const prefix = await read(0, Math.min(fileSize, PREFIX_BYTES));
  if (!hasElfMagic(prefix)) return inspectQualcommMbnImage(prefix, fileSize);
  const tableSpan = qualcommMbnElfTableSpan(prefix, fileSize);
  if (tableSpan.kind !== "span") return tableSpan;
  // The table lies inside the file: the format's own bound.
  const table = await read(tableSpan.offset, tableSpan.length);
  const hashSpan = qualcommMbnHashHeaderSpan(prefix, table, fileSize);
  if (hashSpan.kind !== "span") return hashSpan;
  return inspectQualcommMbnElf({
    prefix,
    table,
    hashHeader: await read(hashSpan.offset, hashSpan.length),
    hashOffset: hashSpan.offset,
    fileSize,
  });
};

/**
 * Whether an ELF image declares a Qualcomm hash segment. Inventory then reads
 * it as `qualcomm-mbn`, as it reads a Node SEA executable as its package,
 * while binary target resolution keeps the ELF classification.
 */
export const locatesQualcommMbnHashSegment = async (
  read: ReadRange,
  fileSize: number,
): Promise<boolean> => {
  const inspection = await readQualcommMbnInspection(read, fileSize);
  return inspection.kind === "elf" && inspection.hashSegment !== null;
};
