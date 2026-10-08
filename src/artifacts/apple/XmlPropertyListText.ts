import { TextDecoder } from "node:util";

/** Decode BOM-aware XML plist text with fatal byte validation. */
export const decodeXmlPlistText = (bytes: Buffer): string => {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const declared = /^<\?xml\s[^?]*\bencoding\s*=\s*["']([^"']+)["']/u
    .exec(text)?.[1]
    ?.toLowerCase();
  if (
    declared !== undefined &&
    ((encoding !== "utf-8" && declared !== encoding && declared !== "utf-16") ||
      (encoding === "utf-8" && declared.startsWith("utf-16")))
  )
    throw new TypeError("XML encoding declaration disagrees with its bytes");
  return text;
};
