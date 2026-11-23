import { excerptText, type ExcerptText } from "./excerpt.js";

/**
 * The longest prefix of `text` whose UTF-8 encoding fits `maximumBytes`,
 * never splitting a character. `text` is a slice of the source, `bytes` its
 * UTF-8 length, and `truncated` says whether any of the end was dropped. Only
 * the retained prefix is encoded.
 */
export const utf8HeadExcerpt = (
  text: string,
  maximumBytes: number,
): {
  readonly text: ExcerptText;
  readonly bytes: number;
  readonly truncated: boolean;
} => {
  if (maximumBytes <= 0)
    return { text: excerptText(""), bytes: 0, truncated: text.length > 0 };
  // Every UTF-16 code unit needs at most three UTF-8 bytes. If the
  // budget fits that worst case, count bytes without encoding the text.
  if (text.length * 3 <= maximumBytes)
    return {
      text: excerptText(text),
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: false,
    };
  // encodeInto stops before the first character that does not fit.
  const { read, written } = new TextEncoder().encodeInto(
    text,
    new Uint8Array(maximumBytes),
  );
  return {
    text: excerptText(text.slice(0, read)),
    bytes: written,
    truncated: read < text.length,
  };
};
