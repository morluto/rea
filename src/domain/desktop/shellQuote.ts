/** A value as one single-quoted shell word. */
export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;
