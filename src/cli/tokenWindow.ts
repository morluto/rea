import { estimateTokenCount, sliceByTokens } from "tokenx";

export interface TokenWindow {
  readonly text: string;
  readonly total: number;
  readonly start: number;
  readonly end: number;
  readonly truncated: boolean;
}

/** Slice an approximate token range without overlapping pages or splitting a surrogate pair. */
export const sliceTextByTokenWindow = (
  text: string,
  offset: number,
  limit: number | undefined,
): TokenWindow => {
  const total = estimateTokenCount(text);
  const end = limit === undefined ? total : offset + limit;
  if (offset === 0 && end >= total)
    return { text, total, start: 0, end: total, truncated: false };

  const actualEnd = Math.min(end, total);
  if (offset >= actualEnd)
    return {
      text: "",
      total,
      start: actualEnd,
      end: actualEnd,
      truncated: true,
    };

  return {
    // An open end retains trailing whitespace priced at zero tokens.
    text: sliceByTokens(
      text,
      offset,
      actualEnd === total ? undefined : actualEnd,
    ),
    total,
    start: offset,
    end: actualEnd,
    truncated: true,
  };
};

export const formatTokenWindow = (
  text: string,
  {
    tokenLimit,
    tokenOffset,
  }: {
    readonly tokenLimit: number | undefined;
    readonly tokenOffset: number | undefined;
  },
):
  | { readonly truncated: false; readonly text: string }
  | {
      readonly truncated: true;
      readonly text: string;
      readonly nextOffset: number | undefined;
    } => {
  if (tokenLimit === undefined && tokenOffset === undefined)
    return { truncated: false, text };
  const window = sliceTextByTokenWindow(text, tokenOffset ?? 0, tokenLimit);
  if (!window.truncated) return { truncated: false, text: window.text };
  return {
    truncated: true,
    text: `${window.text}\n[truncated: showing tokens ${window.start}–${window.end} of ${window.total}]`,
    nextOffset: window.end < window.total ? window.end : undefined,
  };
};
