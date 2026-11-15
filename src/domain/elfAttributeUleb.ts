/** Read a bounded 32-bit ULEB value within an ELF attribute scope. */
export const readElfAttributeUleb = (
  bytes: Uint8Array,
  offset: number,
  end: number,
): { readonly value: number; readonly next: number } | undefined => {
  let value = 0;
  for (let index = 0; index < 5 && offset + index < end; index += 1) {
    const byte = bytes[offset + index]!;
    value += (byte & 0x7f) * 2 ** (7 * index);
    if ((byte & 0x80) === 0)
      return value <= 0xffffffff
        ? { value, next: offset + index + 1 }
        : undefined;
  }
  return undefined;
};
