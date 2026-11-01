import type { RawBinaryLoad } from "./binaryTargetTypes.js";
import { admitRawBinary, parseRawBinaryEntryPoint } from "./rawBinary.js";

/** The load raw-binary admission yields for a caller entry: file offset 0 maps at the entry. */
export const rawLoadAtEntry = (entryPoint: string): RawBinaryLoad => {
  const parsed = parseRawBinaryEntryPoint(entryPoint);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    baseAddress: parsed.value.canonical,
    entryPoint: parsed.value.canonical,
    entrySource: { kind: "caller" },
  };
};

/** The first two M-profile vector-table words, little-endian. */
export const vectorTableWords = (
  initialStackPointer: number,
  reset: number,
): Uint8Array => {
  const words = new Uint8Array(8);
  const view = new DataView(words.buffer);
  view.setUint32(0, initialStackPointer, true);
  view.setUint32(4, reset, true);
  return words;
};

/** The load admission yields for a selection, reading `words` when Reset comes from the vector table. */
export const admittedRawLoad = (
  selection: Parameters<typeof admitRawBinary>[0],
  words?: Uint8Array,
): RawBinaryLoad => {
  const admitted = admitRawBinary(selection);
  if (!admitted.ok) throw new Error(admitted.error.reason);
  if (!("admit" in admitted.value)) return admitted.value.load;
  if (words === undefined)
    throw new Error("the selection reads Reset from the vector table");
  const finished = admitted.value.admit(words);
  if (!finished.ok) throw new Error(finished.error.reason);
  return finished.value.load;
};
