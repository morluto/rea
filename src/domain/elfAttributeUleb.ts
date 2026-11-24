import { readLeb128, ULEB32 } from "./leb128.js";

/** Read a bounded 32-bit ULEB value within an ELF attribute scope. */
export const readElfAttributeUleb = (
  bytes: Uint8Array,
  offset: number,
  end: number,
): { readonly value: number; readonly next: number } | undefined => {
  const read = readLeb128(bytes, offset, end, ULEB32);
  return "failure" in read
    ? undefined
    : { value: Number(read.value), next: read.next };
};
