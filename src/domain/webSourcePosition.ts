/** JavaScript positions use one-based lines and zero-based UTF-16 columns. */
export interface WebSourcePosition {
  readonly line: number;
  readonly column: number;
}

/** A resolved text offset, or the coordinate past the end of the text with its inclusive maximum. */
export type WebSourcePositionResolution =
  | { readonly offset: number }
  | { readonly field: "line" | "column"; readonly maximum: number };

/** Resolve a selected position against actual text without splitting the whole source. */
export const resolveWebSourcePosition = (
  text: string,
  position: WebSourcePosition,
): WebSourcePositionResolution | undefined => {
  if (
    !Number.isSafeInteger(position.line) ||
    position.line < 1 ||
    !Number.isSafeInteger(position.column) ||
    position.column < 0
  )
    return undefined;
  let line = 1;
  let start = 0;
  for (const boundary of text.matchAll(/\r\n?|\n|\u2028|\u2029/gu)) {
    if (line === position.line) return column(start, boundary.index, position);
    line += 1;
    start = boundary.index + boundary[0].length;
  }
  return line === position.line
    ? column(start, text.length, position)
    : { field: "line", maximum: line };
};

const column = (
  start: number,
  end: number,
  position: WebSourcePosition,
): WebSourcePositionResolution =>
  position.column <= end - start
    ? { offset: start + position.column }
    : { field: "column", maximum: end - start };

/** Verify a selected position against actual text without splitting the whole source. */
export const webSourceOffset = (
  text: string,
  position: WebSourcePosition,
): number | undefined => {
  const resolved = resolveWebSourcePosition(text, position);
  return resolved !== undefined && "offset" in resolved
    ? resolved.offset
    : undefined;
};
