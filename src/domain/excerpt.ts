declare const excerptBrand: unique symbol;

/**
 * Text cut to a display bound by `utf8HeadExcerpt` or `utf8TailExcerpt`. It
 * is still a string for display, but it is not the source value: matching,
 * classification and identity must use the source text, and an identity owner
 * rejects it with {@link NotExcerpt}.
 */
export type ExcerptText = string & { readonly [excerptBrand]: true };

/**
 * `T` unless it is excerpt text. An identity parameter typed
 * `<T extends string>(value: NotExcerpt<T>)` refuses an excerpt at compile time.
 */
export type NotExcerpt<T extends string> = T extends ExcerptText ? never : T;

/** Mark text the excerpt helpers retained; only they produce excerpt text. */
export const excerptText = (text: string): ExcerptText => text as ExcerptText;

/**
 * `text` cut to at most `maximum` UTF-16 code units for display, never
 * splitting a surrogate pair, with "…" appended when anything was dropped.
 * Text that fits is returned whole.
 */
export const ellipsisExcerpt = (text: string, maximum: number): ExcerptText =>
  text.length <= maximum
    ? excerptText(text)
    : excerptText(`${text.slice(0, excerptEnd(text, maximum))}…`);

/**
 * Cut `text` to at most `maximum` UTF-16 code units without splitting a
 * surrogate pair, format the retained prefix, and append "…" when anything was
 * dropped.
 */
export const formattedEllipsisExcerpt = (
  text: string,
  maximum: number,
  format: (prefix: string) => string = (prefix) => prefix,
): ExcerptText =>
  text.length <= maximum
    ? excerptText(format(text))
    : excerptText(`${format(text.slice(0, excerptEnd(text, maximum)))}…`);

/**
 * `text` quoted as a JSON string for a diagnostic. Text longer than `maximum`
 * UTF-16 code units is cut as by {@link ellipsisExcerpt} and keeps its full
 * length: `"abc"… (300 UTF-16 code units)`.
 */
export const quotedExcerpt = (text: string, maximum: number): ExcerptText =>
  text.length <= maximum
    ? excerptText(JSON.stringify(text))
    : excerptText(
        `${JSON.stringify(text.slice(0, excerptEnd(text, maximum)))}… (${String(text.length)} UTF-16 code units)`,
      );

/** Where a cut to `maximum` code units ends without splitting a surrogate pair. */
const excerptEnd = (text: string, maximum: number): number =>
  maximum > 0 && /[\uD800-\uDBFF]/u.test(text.charAt(maximum - 1))
    ? maximum - 1
    : Math.max(0, maximum);
