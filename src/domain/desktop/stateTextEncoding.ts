const UTF16 = {
  le: new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }),
  be: new TextDecoder("utf-16be", { fatal: true, ignoreBOM: true }),
};

/** Decode UTF-16 only with a byte-order mark. Strip exactly that first mark. */
export const decodeStateUtf16 = (bytes: Uint8Array) => {
  const order =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "be"
        : undefined;
  if (order === undefined) return undefined;
  try {
    return { order, text: UTF16[order].decode(bytes.subarray(2)) };
  } catch {
    return undefined;
  }
};
