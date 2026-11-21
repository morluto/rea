import type {
  XtensaAbiDeclaration,
  XtensaInfoDeclarations,
  XtensaInfoUndeclared,
  XtensaLiteralDeclaration,
} from "./binaryTargetTypes.js";
import {
  declaredElfNoteAlignment,
  ELF_NOTE_HEADER_BYTES,
  isElfNotePadding,
  readElfNoteFrame,
} from "./native/elfNoteLayout.js";

/** Bound the section read before its declared size can drive allocation; binutils writes 56 bytes. */
export const XTENSA_INFO_MAX_BYTES = 4096;

/** binutils `XTINFO_NAME` with its NUL (`XTINFO_NAMESZ` 12) and `XTINFO_TYPE`. */
const XTINFO_NAME = Buffer.from("Xtensa_Info\0", "latin1");
const XTINFO_TYPE = 1;
/** A value as binutils prints it with `%d`. */
const DECLARED_INTEGER = /^-?\d{1,10}$/u;

/** `XTHAL_ABI_WINDOWED` (0) and `XTHAL_ABI_CALL0` (1). */
const ABI_VALUES = new Map<string, XtensaAbiDeclaration>([
  ["0", { status: "declared", abi: "windowed" }],
  ["1", { status: "declared", abi: "call0" }],
]);

/** `XSHAL_USE_ABSOLUTE_LITERALS`: 1 when L32R literals are addressed from `LITBASE`. */
const LITERAL_VALUES = new Map<string, XtensaLiteralDeclaration>([
  ["0", { status: "declared", literals: "pc-relative" }],
  ["1", { status: "declared", literals: "absolute" }],
]);

const unavailable = (reason: string): XtensaInfoUndeclared => ({
  status: "unavailable",
  reason,
});

/** An absent or unreadable note declares none of its keys. */
export const undeclaredXtensaInfo = (
  outcome: XtensaInfoUndeclared,
): XtensaInfoDeclarations => ({ abi: outcome, literals: outcome });

/** The one value the descriptor gives `key`, as binutils defines it. */
const declaration = <Declared>(
  lines: readonly string[],
  key: string,
  values: ReadonlyMap<string, Declared>,
): Declared | XtensaInfoUndeclared => {
  const [value, ...repeated] = lines
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
  if (value === undefined) return { status: "absent" };
  if (repeated.length > 0)
    return unavailable(`The Xtensa_Info note declares ${key} more than once.`);
  const declared = values.get(value);
  if (declared !== undefined) return declared;
  return DECLARED_INTEGER.test(value)
    ? { status: "unrecognized", value }
    : unavailable(`The Xtensa_Info note declares a malformed ${key} value.`);
};

/**
 * Interpret the contents of a `.xtensa.info` section. GNU as and ld write one
 * `Xtensa_Info` note whose descriptor is `USE_ABSOLUTE_LITERALS=%d\nABI=%d\n`.
 * Other keys are not interpreted. Notes are located by the shared ELF note
 * rules that `inspect_elf_notes` also applies, with the padding the section's
 * declared `sh_addralign` selects; GNU as and ld write 4-byte words. Any other
 * alignment leaves both declarations unavailable, as GNU readelf reads no
 * notes from such a section.
 */
export const parseXtensaInfo = (
  contents: Buffer,
  littleEndian: boolean,
  declaredAlignment: bigint,
): XtensaInfoDeclarations => {
  const alignment = declaredElfNoteAlignment(declaredAlignment);
  if (alignment === undefined)
    return undeclaredXtensaInfo(
      unavailable(
        `.xtensa.info declares sh_addralign ${declaredAlignment}, which selects no ELF note padding; only up to 4 and 8 do.`,
      ),
    );
  let descriptor: Buffer | undefined;
  let at = 0;
  while (at + ELF_NOTE_HEADER_BYTES <= contents.length) {
    const nameStart = at + ELF_NOTE_HEADER_BYTES;
    const frame = readElfNoteFrame(
      contents.subarray(at, nameStart),
      littleEndian,
      alignment,
      contents.length - at,
    );
    if (!frame.ok)
      return undeclaredXtensaInfo(
        unavailable(`.xtensa.info is malformed: ${frame.error.message}`),
      );
    const { namesz, descsz, type, framing, next } = frame.value;
    if (framing !== "complete")
      return undeclaredXtensaInfo(
        unavailable(
          ".xtensa.info is malformed: ELF note entry exceeds its table.",
        ),
      );
    const name = contents.subarray(nameStart, nameStart + namesz);
    if (type === XTINFO_TYPE && name.equals(XTINFO_NAME)) {
      if (descriptor !== undefined)
        return undeclaredXtensaInfo(
          unavailable(".xtensa.info holds more than one Xtensa_Info note."),
        );
      const start = at + frame.value.descriptor;
      descriptor = contents.subarray(start, start + descsz);
    }
    at += next;
  }
  if (at < contents.length && !isElfNotePadding(contents.subarray(at)))
    return undeclaredXtensaInfo(
      unavailable(".xtensa.info has trailing non-zero bytes."),
    );
  if (descriptor === undefined)
    return undeclaredXtensaInfo(
      unavailable(".xtensa.info holds no Xtensa_Info note."),
    );
  const end = descriptor.indexOf(0);
  // GNU as ends the text with a NUL inside descsz; without it the framing is
  // not the one this parser recognizes.
  if (end < 0)
    return undeclaredXtensaInfo(
      unavailable("The Xtensa_Info note's text has no terminating NUL."),
    );
  // binutils pads the text's terminator with NULs to a word boundary; other
  // bytes after it could contradict the declaration read before it.
  if (!descriptor.subarray(end).every((byte) => byte === 0))
    return undeclaredXtensaInfo(
      unavailable(
        "The Xtensa_Info note holds non-zero bytes after its terminating NUL.",
      ),
    );
  const lines = descriptor.subarray(0, end).toString("latin1").split("\n");
  return {
    abi: declaration(lines, "ABI", ABI_VALUES),
    literals: declaration(lines, "USE_ABSOLUTE_LITERALS", LITERAL_VALUES),
  };
};
