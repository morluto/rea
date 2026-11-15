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
