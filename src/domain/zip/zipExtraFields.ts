import type { BinaryReader } from "../binaryContainer.js";
import { err, ok, type Result } from "../result.js";

/** APPNOTE §4.5.1. The exported desktop reader uses the same field layout. */
export const ZIP_EXTRA_FIELD = {
  headerBytes: 4,
  idOffset: 0,
  sizeOffset: 2,
  zip64: 0x0001,
  unicodePath: 0x7075,
} as const;

/** The last matching payload, provided every framed field fits the extra block. */
export const lastZipExtraField = (
  reader: BinaryReader,
  start: number,
  end: number,
  kind: number,
): Result<
  { readonly start: number; readonly end: number } | undefined,
  "overrun"
> => {
  let selected: { readonly start: number; readonly end: number } | undefined;
  // Both desktop decoders have historically accepted a remainder shorter
  // than a header. Only a complete header declares a payload span.
  for (let at = start; at + ZIP_EXTRA_FIELD.headerBytes <= end;) {
    const payload = at + ZIP_EXTRA_FIELD.headerBytes;
    const next = payload + reader.u16(at + ZIP_EXTRA_FIELD.sizeOffset);
    if (next > end) return err("overrun");
    if (reader.u16(at + ZIP_EXTRA_FIELD.idOffset) === kind)
      selected = { start: payload, end: next };
    at = next;
  }
  return ok(selected);
};
