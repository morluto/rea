import type { FileHandle } from "node:fs/promises";
import type { XtensaAbiDeclaration } from "../domain/binaryTargetTypes.js";
import {
  parseXtensaInfoAbi,
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

const unavailable = (reason: string): XtensaAbiDeclaration => ({
  status: "unavailable",
  reason,
});

/**
 * Read the ABI that `.xtensa.info` declares from the caller's already-open file.
 * GNU ld finds that section by name, so names come from the section directory
 * that owns them. A source REA could not examine leaves the ABI unknown.
 * The caller supplies its cancellation check so its tagged error is preserved.
 */
export const readXtensaElfAbi = async (
  handle: FileHandle,
  fileSize: number,
  checkCancelled: () => void,
): Promise<XtensaAbiDeclaration> => {
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
  if (info === undefined) return { status: "absent" };
  if (repeated.length > 0)
    return unavailable("More than one section is named .xtensa.info.");
  if (info.type !== SHT_NOTE)
    return unavailable(".xtensa.info is not an SHT_NOTE section.");
  // A validated SHT_NOTE extent lies inside the file, so its size is exact.
  if (info.size > BigInt(XTENSA_INFO_MAX_BYTES))
    return {
      status: "unavailable",
      reason: `.xtensa.info declares ${String(info.size)} bytes, above REA's fixed ${XTENSA_INFO_MAX_BYTES}-byte inspection bound. This release has no runtime override, and runtime analysis settings do not raise this bound.`,
      limit: {
        boundary: "xtensa_info",
        maximum_bytes: XTENSA_INFO_MAX_BYTES,
        declared_bytes: Number(info.size),
        runtime_override: false,
      },
    };
  const contents = await read(Number(info.offset), Number(info.size));
  if (contents === undefined) return truncated;
  return parseXtensaInfoAbi(contents, directory.little);
};
