/** Decode BOM-aware XML plist text with fatal byte validation. */
export const decodeXmlPlistText = (bytes: Uint8Array): string => {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const declaration = /^<\?xml\s[^?]*\bencoding\s*=\s*["']([^"']+)["']/u.exec(
    text,
  )?.[1];
  const declared = declaration?.toLowerCase();
  if (
    declared !== undefined &&
    !["utf-8", "utf-16", "utf-16le", "utf-16be"].includes(declared)
  )
    throw new TypeError(
      `Unsupported XML encoding declaration: ${declaration}. Supported encodings are UTF-8 and BOM-marked UTF-16 in either byte order.`,
    );
  if (
    declared !== undefined &&
    declared !== encoding &&
    !(encoding !== "utf-8" && declared === "utf-16")
  )
    throw new TypeError("XML encoding declaration disagrees with its bytes");
  return text;
};
