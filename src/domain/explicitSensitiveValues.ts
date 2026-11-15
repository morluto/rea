/**
 * The one owner for redacting declared sensitive values: literals a caller
 * explicitly marked sensitive, and transport credentials REA minted itself.
 * Nothing here infers secrecy from names or text patterns; an undeclared value
 * is ordinary evidence. Producers choose what they declare, this module
 * decides how every declared value is found and replaced.
 */

/**
 * HTTP fields whose values are transport credentials by protocol definition
 * (RFC 9110 authentication, RFC 6265 cookies), in lower case. Other headers
 * are ordinary evidence unless a caller declares them.
 */
export const TRANSPORT_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

/** Whether an HTTP field name carries a transport credential. */
export const isTransportCredentialHeader = (name: string): boolean =>
  TRANSPORT_CREDENTIAL_HEADERS.has(name.toLowerCase());

/** Distinct non-empty declarations, longest first so overlaps redact whole. */
const declaredLiterals = (values: readonly string[]): readonly string[] =>
  [...new Set(values)]
    .filter((literal) => literal !== "")
    .sort((left, right) => right.length - left.length);

/** Whether any declared literal occurs in `value`. */
export const explicitValuesOccurIn = (
  value: string,
  sensitiveValues: readonly string[],
): boolean =>
  sensitiveValues.some((literal) => literal !== "" && value.includes(literal));

/**
 * UTF-8 spellings of the declared literals, for searching retained bytes. An
 * unpaired surrogate has no UTF-8 representation; encoding it would invent
 * replacement-character bytes and discard real evidence, so it is skipped.
 */
export const explicitUtf8Spellings = (
  sensitiveValues: readonly string[],
): readonly Buffer[] =>
  declaredLiterals(sensitiveValues).flatMap((value) => {
    const encoded = Buffer.from(value, "utf8");
    return encoded.toString("utf8") === value ? [encoded] : [];
  });

export type ExplicitRedactionOptions = Readonly<{
  /** Preferred marker; a safe fallback is used when it contains a declaration. */
  replacement?: string;
  /**
   * The text was cut by an output budget, so its end may hold the start of a
   * declared value. The longest such prefix is replaced as well.
   */
  cutOff?: boolean;
}>;

/** Replace declared literal text values without guessing sensitivity from names. */
export const redactExplicitText = (
  value: string,
  sensitiveValues: readonly string[],
  options: ExplicitRedactionOptions = {},
): string => {
  const literals = declaredLiterals(sensitiveValues);
  if (literals.length === 0) return value;
  const replacement =
    [
      ...(options.replacement === undefined ? [] : [options.replacement]),
      "[REDACTED]",
      "…",
      "",
    ].find((candidate) =>
      literals.every((literal) => !candidate.includes(literal)),
    ) ?? "";
  let result = value;
  for (const literal of literals)
    result = result.replaceAll(literal, replacement);
  if (options.cutOff === true) {
    const tail = cutOffPrefixLength(result, literals);
    if (tail > 0)
      result = `${result.slice(0, result.length - tail)}${replacement}`;
  }
  // Replacement boundaries can form another declaration; exclude that text.
  return literals.some((literal) => result.includes(literal)) ? "" : result;
};

/**
 * Redact declared values in retained output. Output whose observed length
 * exceeds the retained bytes was cut by its budget, so its end is checked for
 * the start of a declared value too.
 */
export const redactExplicitOutput = (
  output: Readonly<{ text: string; bytes: number; observedBytes: number }>,
  sensitiveValues: readonly string[],
  replacement?: string,
): string =>
  redactExplicitText(output.text, sensitiveValues, {
    cutOff: output.observedBytes > output.bytes,
    ...(replacement === undefined ? {} : { replacement }),
  });

/** Length of the longest proper prefix of a declaration that ends `text`. */
const cutOffPrefixLength = (
  text: string,
  literals: readonly string[],
): number => {
  let longest = 0;
  for (const literal of literals)
    for (
      let length = Math.min(text.length, literal.length - 1);
      length > longest;
      length -= 1
    )
      if (text.endsWith(literal.slice(0, length))) {
        longest = length;
        break;
      }
  return longest;
};
