export function unmarkedMatchCount(
  raw: string,
  pattern: RegExp,
  names: readonly string[],
  counts?: (match: RegExpMatchArray) => boolean,
): number;
export function markedCodeLines(
  raw: string,
  names: readonly string[],
): string[];
