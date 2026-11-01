import type {
  XtensaAbiDeclaration,
  XtensaInfoDeclarations,
  XtensaInfoUndeclared,
  XtensaLiteralDeclaration,
} from "./binaryTargetTypes.js";
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
 * rules that `inspect_elf_notes` also applies.
 */
export const parseXtensaInfo = (
  contents: Buffer,
  littleEndian: boolean,
): XtensaInfoDeclarations => {
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
      return undeclaredXtensaInfo(
        unavailable(`.xtensa.info is malformed: ${record.error.message}`),
      );
    const { namesz, descsz, type } = record.value;
    const name = contents.subarray(at + 12, at + 12 + namesz);
    if (type === XTINFO_TYPE && name.equals(XTINFO_NAME)) {
      if (descriptor !== undefined)
        return undeclaredXtensaInfo(
          unavailable(".xtensa.info holds more than one Xtensa_Info note."),
        );
      descriptor = contents.subarray(
        record.value.descriptor,
        record.value.descriptor + descsz,
      );
    }
    at = record.value.next;
  }
  if (!isElfNotePadding(contents.subarray(at)))
    return undeclaredXtensaInfo(
      unavailable(".xtensa.info has trailing non-zero bytes."),
    );
  if (descriptor === undefined)
    return undeclaredXtensaInfo(
      unavailable(".xtensa.info holds no Xtensa_Info note."),
    );
  const end = descriptor.indexOf(0);
  // binutils pads the text's terminator with NULs to a word boundary; other
  // bytes after it could contradict the declaration read before it.
  if (end >= 0 && !descriptor.subarray(end).every((byte) => byte === 0))
    return undeclaredXtensaInfo(
      unavailable(
        "The Xtensa_Info note holds non-zero bytes after its terminating NUL.",
      ),
    );
  const lines = descriptor
    .subarray(0, end < 0 ? descriptor.length : end)
    .toString("latin1")
    .split("\n");
  return {
    abi: declaration(lines, "ABI", ABI_VALUES),
    literals: declaration(lines, "USE_ABSOLUTE_LITERALS", LITERAL_VALUES),
  };
};
