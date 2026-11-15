export function unmarkedMatchCount(
  raw: string,
  pattern: RegExp,
  names: readonly string[],
  counts?: (match: RegExpMatchArray) => boolean,
): number;
export function markedLineNumbers(
  raw: string,
  names: readonly string[],
): Set<number>;
