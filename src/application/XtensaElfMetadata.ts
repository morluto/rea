import type { FileHandle } from "node:fs/promises";
import type { XtensaInfoDeclarations } from "../domain/binaryTargetTypes.js";
import {
  parseXtensaInfo,
  undeclaredXtensaInfo,
  XTENSA_INFO_MAX_BYTES,
} from "../domain/xtensaInfo.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../native/metadata/BinaryContainer.js";
import {
  readElfSectionDirectory,
  type NativeSectionDirectory,
} from "../native/metadata/NativeSectionDirectory.js";

const SHT_NOTE = 7;
/** Compressed storage holds a compression header and payload, not notes. */
const SHF_COMPRESSED = 0x800n;

const unavailable = (reason: string): XtensaInfoDeclarations =>
  undeclaredXtensaInfo({ status: "unavailable", reason });

/**
 * Read what `.xtensa.info` declares from the caller's already-open file.
 * GNU ld finds that section by name, so names come from the section directory
 * that owns them. A source REA could not examine leaves the declarations
 * unknown. The caller supplies its cancellation check so its tagged error is
 * preserved.
 */
export const readXtensaElfInfo = async (
  handle: FileHandle,
  fileSize: number,
  checkCancelled: () => void,
): Promise<XtensaInfoDeclarations> => {
  const read = async (
    offset: number,
    size: number,
  ): Promise<Buffer | undefined> => {
    const bytes = Buffer.alloc(size);
    for (let total = 0; total < size;) {
      checkCancelled();
      const observed = await handle.read(
        bytes,
        total,
        size - total,
        offset + total,
      );
      checkCancelled();
      if (observed.bytesRead === 0) return undefined;
      total += observed.bytesRead;
    }
    return bytes;
  };
  const truncated = unavailable("The file ended inside a declared ELF range.");
  let directory: NativeSectionDirectory;
  try {
    const steps = readElfSectionDirectory(fileSize);
    let next = steps.next();
    while (!next.done) {
      const bytes = await read(next.value.offset, next.value.size);
      if (bytes === undefined) return truncated;
      next = steps.next(bytes);
    }
    directory = next.value;
  } catch (cause: unknown) {
    if (
      cause instanceof BinaryFormatFailure ||
      cause instanceof BinaryResourceFailure
    )
      return unavailable(cause.message);
    throw cause;
  }
  if (directory.sections.length === 0)
    return unavailable(
      "The image has no section header table, which is where .xtensa.info is declared.",
    );
  // A section whose name cannot be read could be another .xtensa.info, so
  // neither absence nor a single declaration can be established.
  if (directory.section_names_limitation !== undefined)
    return unavailable(directory.section_names_limitation);
  const [info, ...repeated] = directory.sections.filter(
    (section) => section.name === ".xtensa.info",
  );
  if (info === undefined) return undeclaredXtensaInfo({ status: "absent" });
  if (repeated.length > 0)
    return unavailable("More than one section is named .xtensa.info.");
  if (info.type !== SHT_NOTE)
    return unavailable(".xtensa.info is not an SHT_NOTE section.");
  if ((info.flags & SHF_COMPRESSED) !== 0n)
    return unavailable(
      ".xtensa.info is compressed (SHF_COMPRESSED); REA reads its note only from uncompressed section bytes.",
    );
  // A validated SHT_NOTE extent lies inside the file, so its size is exact.
  if (info.size > BigInt(XTENSA_INFO_MAX_BYTES))
    return undeclaredXtensaInfo({
      status: "unavailable",
      reason: `.xtensa.info declares ${String(info.size)} bytes, above REA's fixed ${XTENSA_INFO_MAX_BYTES}-byte inspection bound. This release has no runtime override, and runtime analysis settings do not raise this bound.`,
      limit: {
        boundary: "xtensa_info",
        maximum_bytes: XTENSA_INFO_MAX_BYTES,
        declared_bytes: Number(info.size),
        runtime_override: false,
      },
    });
  const contents = await read(Number(info.offset), Number(info.size));
  if (contents === undefined) return truncated;
  return parseXtensaInfo(contents, directory.little);
};
