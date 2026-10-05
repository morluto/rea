/** Validate optional source-map content against its source inventory. */
export const hasValidSourceMapContents = (
  sourceCount: number,
  contents: unknown,
): boolean =>
  contents === undefined ||
  (Array.isArray(contents) &&
    contents.length === sourceCount &&
    contents.every(
      (content: unknown) => content === null || typeof content === "string",
    ));
