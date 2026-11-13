/**
 * Detect advertised JSON Schema `pattern` values that a strict client can
 * reject even though V8 compiles them.
 *
 * The defect this guards against shipped in 6.9.0: `localPathStringSchema`
 * advertised `^[^\uD800-\uDFFF]*$`. It compiles in Annex B, `u` and `v` mode,
 * so the compile-only guard beside it passed, but a gateway that decodes the
 * escape into its own regex syntax rejected the pattern and with it the whole
 * `tools/list` request.
 *
 * Two properties make a pattern unsafe to advertise, and both are decidable
 * from the pattern text:
 *
 * 1. It names a code point inside U+D800..U+DFFF. A validator that resolves the
 *    escape and refuses surrogate code points rejects the pattern. `\uD800`,
 *    `\u{D800}` and `\x{D800}` all name one.
 * 2. Its meaning depends on the `u`/`v` flags. JSON Schema does not state the
 *    flags a validator compiles a pattern with, so a pattern whose meaning
 *    changes without `u` is not portable. `\p{Cs}` is the concrete case: under
 *    `u` it names surrogates, and without `u` Annex B reads it as the literal
 *    characters `p`, `{`, `C`, `s`, `}`.
 *
 * The text is walked left to right, consuming escapes as it goes, because a
 * backslash can be escaped: `\\uD800` matches the literal text `\uD800` and
 * names no code point, so a pattern containing it is safe to publish. Matching
 * escape spellings anywhere in the string would report it as a surrogate.
 */

const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;

const BACKSLASH = "\\";
const HEX_DIGIT = /[0-9a-fA-F]/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isSurrogate = (codePoint: number): boolean =>
  codePoint >= SURROGATE_MIN && codePoint <= SURROGATE_MAX;

const describe = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

/** Property values whose meaning is the surrogate block. */
const SURROGATE_PROPERTIES = new Set(["cs", "surrogate", "surrogates"]);

export interface AdvertisedPatternFinding {
  readonly pattern: string;
  readonly reason: string;
}

interface Escape {
  /** Source text of the complete escape. */
  readonly text: string;
  /** Decoded code point, when the escape is a code-point escape. */
  readonly codePoint?: number;
  /** Property name, when the escape is a Unicode property escape. */
  readonly property?: string;
  /** Index just past the escape. */
  readonly end: number;
}

const readHexDigits = (
  pattern: string,
  start: number,
  limit: number,
): { readonly digits: string; readonly end: number } => {
  let end = start;
  while (
    end < pattern.length &&
    end - start < limit &&
    HEX_DIGIT.test(pattern[end] ?? "")
  )
    end += 1;
  return { digits: pattern.slice(start, end), end };
};

/**
 * Read one escape starting at the backslash at `start`. Returns `undefined`
 * when the backslash introduces no escape this check understands, including a
 * trailing backslash and an escaped backslash.
 */
const readEscape = (pattern: string, start: number): Escape | undefined => {
  const marker = pattern[start + 1];
  if (marker === undefined) return undefined;
  if (marker === "u" || marker === "x") {
    const braced = pattern[start + 2] === "{";
    const required = marker === "u" ? 4 : 2;
    const { digits, end: digitsEnd } = readHexDigits(
      pattern,
      start + (braced ? 3 : 2),
      braced ? Number.POSITIVE_INFINITY : required,
    );
    if (digits.length === 0) return undefined;
    let end = digitsEnd;
    if (braced) {
      if (pattern[end] !== "}") return undefined;
      end += 1;
    } else if (digits.length !== required) {
      // `\uD8` and `\x0` are not code-point escapes; Annex B reads them as
      // literal characters, so they name no code point here either.
      return undefined;
    }
    return {
      text: pattern.slice(start, end),
      codePoint: Number.parseInt(digits, 16),
      end,
    };
  }
  if (marker === "p" || marker === "P") {
    if (pattern[start + 2] !== "{") return undefined;
    const closing = pattern.indexOf("}", start + 3);
    if (closing === -1) return undefined;
    return {
      text: pattern.slice(start, closing + 1),
      property: pattern.slice(start + 3, closing),
      end: closing + 1,
    };
  }
  return undefined;
};

/** Return every reason `pattern` is unsafe to publish, or an empty list. */
export const advertisedPatternFindings = (
  pattern: string,
): readonly string[] => {
  const findings: string[] = [];
  let index = 0;
  while (index < pattern.length) {
    if (pattern[index] !== BACKSLASH) {
      index += 1;
      continue;
    }
    // `\\` is an escaped backslash and starts no escape sequence. Skipping the
    // pair is what keeps `\\uD800` from being reported as a surrogate escape.
    if (pattern[index + 1] === BACKSLASH) {
      index += 2;
      continue;
    }
    const escape = readEscape(pattern, index);
    if (escape === undefined) {
      index += 1;
      continue;
    }
    if (escape.codePoint !== undefined && isSurrogate(escape.codePoint))
      findings.push(
        `names surrogate code point ${describe(escape.codePoint)} via ${escape.text}`,
      );
    if (escape.property !== undefined) {
      // Without `u`, Annex B reads `\p{...}` as literal characters, so any
      // property escape is mode-dependent. A surrogate-valued property is also
      // a code-point problem even when a client compiles with `u`.
      const property = escape.property.trim().toLowerCase();
      if (SURROGATE_PROPERTIES.has(property))
        findings.push(
          `${escape.text} is a surrogate property and is only defined with the u flag`,
        );
      else findings.push(`${escape.text} is only defined with the u or v flag`);
    }
    index = escape.end;
  }
  return findings;
};

/** Collect every `pattern` string in a schema document, with its location. */
export const collectAdvertisedPatterns = (
  schema: unknown,
  path = "$",
  found: { pattern: string; where: string }[] = [],
): { pattern: string; where: string }[] => {
  if (Array.isArray(schema)) {
    schema.forEach((entry, index) =>
      collectAdvertisedPatterns(entry, `${path}[${index}]`, found),
    );
    return found;
  }
  if (!isRecord(schema)) return found;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "pattern" && typeof value === "string")
      found.push({ pattern: value, where: `${path}/pattern` });
    else collectAdvertisedPatterns(value, `${path}/${key}`, found);
  }
  return found;
};
