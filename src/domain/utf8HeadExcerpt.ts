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
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
} => {
  if (maximumBytes <= 0)
    return { text: "", bytes: 0, truncated: text.length > 0 };
  // A UTF-16 code unit encodes to at most three UTF-8 bytes, and encodeInto
  // stops before the first character that does not fit.
  const { read, written } = new TextEncoder().encodeInto(
    text,
    new Uint8Array(Math.min(maximumBytes, text.length * 3)),
  );
  return {
    text: text.slice(0, read),
    bytes: written,
    truncated: read < text.length,
  };
};
