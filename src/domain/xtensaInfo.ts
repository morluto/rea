import type { XtensaAbiDeclaration } from "./binaryTargetTypes.js";
import { isElfNotePadding, readElfNoteRecord } from "./native/elfNoteLayout.js";

/** Bound the section read before its declared size can drive allocation; binutils writes 56 bytes. */
export const XTENSA_INFO_MAX_BYTES = 4096;

/** binutils `XTINFO_NAME` with its NUL (`XTINFO_NAMESZ` 12) and `XTINFO_TYPE`. */
const XTINFO_NAME = Buffer.from("Xtensa_Info\0", "latin1");
const XTINFO_TYPE = 1;
/** GNU as and ld pad the note's name and descriptor to 4-byte words. */
const XTINFO_ALIGNMENT = 4;
/** A value as binutils prints it with `%d`. */
const DECLARED_INTEGER = /^-?\d{1,10}$/u;

const unavailable = (reason: string): XtensaAbiDeclaration => ({
  status: "unavailable",
  reason,
});

/**
 * Interpret the contents of a `.xtensa.info` section. GNU as and ld write one
 * `Xtensa_Info` note whose descriptor is `USE_ABSOLUTE_LITERALS=%d\nABI=%d\n`;
 * binutils defines ABI 0 as windowed (`XTHAL_ABI_WINDOWED`) and 1 as call0
 * (`XTHAL_ABI_CALL0`). Other keys are not interpreted. Notes are located by the
 * shared ELF note rules that `inspect_elf_notes` also applies.
 */
export const parseXtensaInfoAbi = (
  contents: Buffer,
  littleEndian: boolean,
): XtensaAbiDeclaration => {
  let descriptor: Buffer | undefined;
  let at = 0;
  while (at + 12 <= contents.length) {
    const record = readElfNoteRecord(
      contents,
      at,
      littleEndian,
      XTINFO_ALIGNMENT,
    );
    if (!record.ok)
      return unavailable(`.xtensa.info is malformed: ${record.error.message}`);
    const { namesz, descsz, type } = record.value;
    const name = contents.subarray(at + 12, at + 12 + namesz);
    if (type === XTINFO_TYPE && name.equals(XTINFO_NAME)) {
      if (descriptor !== undefined)
        return unavailable(
          ".xtensa.info holds more than one Xtensa_Info note.",
        );
      descriptor = contents.subarray(
        record.value.descriptor,
        record.value.descriptor + descsz,
      );
    }
    at = record.value.next;
  }
  if (!isElfNotePadding(contents.subarray(at)))
    return unavailable(".xtensa.info has trailing non-zero bytes.");
  if (descriptor === undefined)
    return unavailable(".xtensa.info holds no Xtensa_Info note.");
  const end = descriptor.indexOf(0);
  const [value, ...repeated] = descriptor
    .subarray(0, end < 0 ? descriptor.length : end)
    .toString("latin1")
    .split("\n")
    .filter((line) => line.startsWith("ABI="))
    .map((line) => line.slice("ABI=".length));
  if (value === undefined) return { status: "absent" };
  if (repeated.length > 0)
    return unavailable("The Xtensa_Info note declares ABI more than once.");
  if (value === "0") return { status: "declared", abi: "windowed" };
  if (value === "1") return { status: "declared", abi: "call0" };
  return DECLARED_INTEGER.test(value)
    ? { status: "unrecognized", value }
    : unavailable("The Xtensa_Info note declares a malformed ABI value.");
};
